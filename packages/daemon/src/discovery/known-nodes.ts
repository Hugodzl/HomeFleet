/**
 * Known-nodes registry: every node we have ever discovered with a claimed
 * device ID, persisted as `known-nodes.json` in the data directory so
 * previously seen nodes are reachable before rediscovery.
 *
 * This is NOT the trust store — knowing a node is not trusting it. Entries
 * (device ID included) are discovery hints; trust only ever comes from
 * pairing plus the mTLS fingerprint pin at connect time (ADR-0004).
 *
 * Persistence mirrors the trust store exactly: zod-validated file, missing
 * file starts empty, any other read error throws (failing open would let the
 * next record() silently wipe every known node), atomic temp-file+rename
 * writes, serialized persists.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeviceIdSchema, NodeNameSchema } from "@homefleet/protocol";
import { z } from "zod";

/**
 * Registry size cap. deviceIds in announcements are unauthenticated and
 * free to mint, so without a cap a LAN attacker could grow this file (and
 * the aggregator's candidate map, which shares this constant) without
 * bound. On overflow the entry with the oldest `lastSeenAt` is evicted.
 */
export const MAX_KNOWN_NODES = 512;

export const KnownNodeSchema = z.object({
  deviceId: DeviceIdSchema,
  /** Absent for nodes only ever seen via static config (no name there). */
  name: NodeNameSchema.optional(),
  host: z.string().min(1),
  /** The node's HFP HTTPS port. */
  port: z.int().min(1).max(65535),
  /** Latest sighting, as an ISO 8601 UTC timestamp. */
  lastSeenAt: z.iso.datetime(),
  /** Which discovery channel last saw the node. */
  source: z.enum(["mdns", "udp", "static"]),
});
export type KnownNode = z.infer<typeof KnownNodeSchema>;

const KnownNodesFileSchema = z.array(KnownNodeSchema);

const KNOWN_NODES_FILE = "known-nodes.json";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * The persisted known-nodes registry. Load with
 * {@link KnownNodesRegistry.load}; mutations persist immediately and
 * atomically (write temp file, then rename), and persists are serialized so
 * concurrent record() calls cannot interleave.
 */
export class KnownNodesRegistry {
  private readonly filePath: string;
  private readonly entries: Map<string, KnownNode>;
  /** The write currently in flight, or null when idle; see {@link persist}. */
  private writing: Promise<void> | null = null;
  /** The single coalesced follow-up write, or null; see {@link persist}. */
  private pending: Promise<void> | null = null;
  private tempCounter = 0;

  private constructor(filePath: string, entries: Map<string, KnownNode>) {
    this.filePath = filePath;
    this.entries = entries;
  }

  /**
   * Loads the registry from `dataDir`. A missing file (ENOENT) yields an
   * empty registry; any other read error and any file that does not
   * validate throws (see the file-level doc comment for why).
   */
  static async load(dataDir: string): Promise<KnownNodesRegistry> {
    const filePath = path.join(dataDir, KNOWN_NODES_FILE);
    let text: string | null = null;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(
          `Failed to read known-nodes registry ${filePath}; refusing to ` +
            "start with an empty registry (a later write would permanently " +
            "drop every previously discovered node).",
          { cause: error },
        );
      }
      // ENOENT: first run — start empty.
    }
    const entries = new Map<string, KnownNode>();
    if (text !== null) {
      let parsed: KnownNode[];
      try {
        parsed = KnownNodesFileSchema.parse(JSON.parse(text));
      } catch (cause) {
        throw new Error(
          `Corrupt known-nodes registry: ${filePath} is not a valid ` +
            "known-nodes file. Remove it to reset discovered nodes " +
            "(pairings are unaffected).",
          { cause },
        );
      }
      for (const entry of parsed) {
        entries.set(entry.deviceId, entry);
      }
    }
    return new KnownNodesRegistry(filePath, entries);
  }

  /** All known nodes (copies; mutating them does not affect the registry). */
  list(): KnownNode[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Number of file writes performed so far. Exposed so tests can assert that a
   * burst of concurrent record() calls coalesces into few writes (see persist).
   */
  get writeCount(): number {
    return this.tempCounter;
  }

  /**
   * Records (or replaces, keyed by `deviceId`) a sighting and persists.
   * Rejects entries that do not validate. Past {@link MAX_KNOWN_NODES}
   * entries, the oldest sighting is evicted (spoofed-deviceId flood guard).
   */
  async record(entry: KnownNode): Promise<void> {
    const validated = KnownNodeSchema.parse(entry);
    this.entries.set(validated.deviceId, validated);
    while (this.entries.size > MAX_KNOWN_NODES) {
      this.evictOldest();
    }
    await this.persist();
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, node] of this.entries) {
      const at = Date.parse(node.lastSeenAt);
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Atomic persist (write a temp file, then rename over the real one),
   * COALESCING concurrent calls. A burst of record() calls — e.g. a discovery
   * flood, which MAX_KNOWN_NODES caps in memory — collapses into at most two
   * writes: the one already in flight, plus a single follow-up that snapshots
   * the final state. The naive "one write per record" would be an O(n) disk-
   * write amplification of the very flood the cap defends against (and it made
   * the cap test flaky under load).
   *
   * Durability is preserved: every returned promise resolves only after a
   * write that reflects this call's mutation. A caller arriving while a write
   * is in flight gets the follow-up, which snapshots entries when it RUNS
   * (strictly after the in-flight write), so it necessarily includes that
   * mutation. Writes still never interleave — the follow-up is chained off the
   * in-flight write, not started concurrently.
   */
  private persist(): Promise<void> {
    if (this.writing === null) {
      this.writing = this.runWrite();
      return this.writing;
    }
    // A write is in flight; this mutation must land in a follow-up write.
    // Every caller during the current write shares ONE coalesced follow-up.
    this.pending ??= this.writing
      .catch(() => {}) // a failed in-flight write must not skip the follow-up
      .then(() => this.runWrite());
    return this.pending;
  }

  /**
   * Runs one atomic write and, when it settles, promotes any coalesced
   * follow-up to be the write in flight (it is already running — `pending`
   * was chained off this write), keeping {@link persist}'s bookkeeping
   * consistent whether the write succeeded or failed.
   */
  private runWrite(): Promise<void> {
    const done = this.writeSnapshot();
    void done
      .catch(() => {})
      .finally(() => {
        this.writing = this.pending;
        this.pending = null;
      });
    return done;
  }

  /**
   * Atomic write: serialize entries to a unique temp file, then rename over
   * the real file (the rename is the atomic commit; a crash mid-write leaves
   * the previous file intact). The temp path is unique per write so a
   * coalesced follow-up can never collide with the write it chains off.
   */
  private async writeSnapshot(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.tempCounter += 1;
    const tempPath = `${this.filePath}.tmp-${process.pid}-${this.tempCounter}`;
    const json = JSON.stringify([...this.entries.values()], null, 2);
    try {
      await writeFile(tempPath, json, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      // Never leave a stray temp file behind.
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}
