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
  /** Serializes persists; see {@link KnownNodesRegistry.persist}. */
  private persistQueue: Promise<unknown> = Promise.resolve();
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
   * Atomic persist: write to a temp file, then rename over the real one.
   *
   * Persists are chained through {@link KnownNodesRegistry.persistQueue} so
   * concurrent record() calls execute their writes strictly one after
   * another (each write snapshots the entries at execution time, so the
   * final file always reflects the final in-memory state). The temp path is
   * unique per write as a second line of defense.
   */
  private persist(): Promise<void> {
    const task = this.persistQueue.then(() => this.writeSnapshot());
    // Keep the queue alive even when a write fails; the failure still
    // propagates to this persist's caller via `task`.
    this.persistQueue = task.catch(() => {});
    return task;
  }

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
