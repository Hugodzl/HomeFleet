/**
 * Paired-device list (ADR-0004): the set of device IDs this daemon trusts,
 * persisted as `trusted-devices.json` in the data directory.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeviceIdSchema } from "@homefleet/protocol";
import { z } from "zod";

export const TrustedDeviceSchema = z.object({
  deviceId: DeviceIdSchema,
  name: z.string().min(1),
  /** When the device was paired, as an ISO 8601 UTC timestamp. */
  addedAt: z.iso.datetime(),
});
export type TrustedDevice = z.infer<typeof TrustedDeviceSchema>;

const TrustStoreFileSchema = z.array(TrustedDeviceSchema);

const TRUST_STORE_FILE = "trusted-devices.json";

/**
 * The paired-device list. Load with {@link TrustStore.load}; mutations
 * persist immediately and atomically (write temp file, then rename).
 */
export class TrustStore {
  private readonly filePath: string;
  private readonly entries: Map<string, TrustedDevice>;

  private constructor(filePath: string, entries: Map<string, TrustedDevice>) {
    this.filePath = filePath;
    this.entries = entries;
  }

  /**
   * Loads the trust store from `dataDir`. A missing file yields an empty
   * store; a file that exists but does not validate throws (silently
   * dropping trust entries would orphan pairings).
   */
  static async load(dataDir: string): Promise<TrustStore> {
    const filePath = path.join(dataDir, TRUST_STORE_FILE);
    let text: string | null = null;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      // Missing file: first run — start empty.
    }
    const entries = new Map<string, TrustedDevice>();
    if (text !== null) {
      let parsed: TrustedDevice[];
      try {
        parsed = TrustStoreFileSchema.parse(JSON.parse(text));
      } catch (cause) {
        throw new Error(
          `Corrupt trust store: ${filePath} is not a valid trusted-devices file. ` +
            "Restore it from backup or remove it to reset pairings.",
          { cause },
        );
      }
      for (const entry of parsed) {
        entries.set(entry.deviceId, entry);
      }
    }
    return new TrustStore(filePath, entries);
  }

  /** Whether `deviceId` is a paired (trusted) device. */
  has(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }

  /** All trusted devices (copies; mutating them does not affect the store). */
  list(): TrustedDevice[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Adds (or replaces, keyed by `deviceId`) a trusted device and persists.
   * Rejects entries that do not validate — in particular a `deviceId` that
   * is not a 64-char lowercase hex SHA-256 fingerprint.
   */
  async add(entry: TrustedDevice): Promise<void> {
    const validated = TrustedDeviceSchema.parse(entry);
    this.entries.set(validated.deviceId, validated);
    await this.persist();
  }

  /**
   * Removes a device from the trust store and persists. Returns whether the
   * device was present.
   */
  async remove(deviceId: string): Promise<boolean> {
    const removed = this.entries.delete(deviceId);
    if (removed) {
      await this.persist();
    }
    return removed;
  }

  /** Atomic persist: write to a temp file, then rename over the real one. */
  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
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
