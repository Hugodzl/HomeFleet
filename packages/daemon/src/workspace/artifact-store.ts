/**
 * Write-job artifact registry (v0.2 code-writing delegation, Task 6): the
 * jobId -> bundle index the artifact download route (Task 8) serves from.
 *
 * Deliberately small: an in-memory map over bundle files that already live
 * on disk (written by `WorkspaceStore.finalizeWriteJob` at
 * `<repoRoot>/jobs/<jobId12>.bundle`). It has NO eviction policy of its own —
 * the JobManager's job-eviction hook (Task 7) drives {@link remove} when a
 * job record ages out, and {@link removeAll} is the shutdown sweep. Crash
 * safety needs no bookkeeping here: registrations die with the process, and
 * the workspace store's `init()` purges every `jobs/` dir (bundles included)
 * on the next start, so a bundle file can never outlive its registration by
 * more than one restart.
 *
 * Bundle deletion is best effort (a locked file is logged and left for the
 * init purge); the registry entry is dropped regardless, so a remove always
 * makes the artifact unavailable immediately.
 */
import { rm } from "node:fs/promises";
import type { JobId } from "@homefleet/protocol";

/** What the download route needs to serve (and validate) one artifact. */
export interface ArtifactEntry {
  /** Absolute path of the bundle file on disk. */
  bundlePath: string;
  /** The artifact's tip commit — the integrity anchor the client re-checks. */
  headCommit: string;
  /** Bundle file size, for Content-Length and sanity checks. */
  byteLength: number;
}

export interface ArtifactStoreOptions {
  /** Diagnostic sink (failed deletions); defaults to no-op. */
  logger?: (message: string) => void;
}

export class ArtifactStore {
  private readonly entries = new Map<JobId, ArtifactEntry>();
  private readonly log: (message: string) => void;

  constructor(options: ArtifactStoreOptions = {}) {
    this.log = options.logger ?? (() => {});
  }

  /**
   * Registers a finalized job's bundle. Re-registering a jobId replaces its
   * entry (the bundle path is deterministic per job, so no file is orphaned).
   */
  register(jobId: JobId, entry: ArtifactEntry): void {
    this.entries.set(jobId, { ...entry });
  }

  /** The registered artifact for `jobId`, or `undefined`. Returns a copy. */
  get(jobId: JobId): ArtifactEntry | undefined {
    const entry = this.entries.get(jobId);
    return entry === undefined ? undefined : { ...entry };
  }

  /**
   * Deregisters `jobId` and deletes its bundle file. Tolerates an unknown
   * jobId and an already-gone file (both quiet no-ops); a failing deletion
   * is logged, never thrown — the entry is dropped either way and the next
   * init purge reaps the file.
   */
  async remove(jobId: JobId): Promise<void> {
    const entry = this.entries.get(jobId);
    this.entries.delete(jobId);
    if (entry === undefined) {
      return;
    }
    try {
      await rm(entry.bundlePath, { force: true });
    } catch (error) {
      this.log(
        `failed to delete artifact bundle ${entry.bundlePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Shutdown sweep: {@link remove} for every registered job. */
  async removeAll(): Promise<void> {
    for (const jobId of [...this.entries.keys()]) {
      await this.remove(jobId);
    }
  }
}
