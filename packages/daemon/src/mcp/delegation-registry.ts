/**
 * Delegation registry: MCP tools take a bare `jobId`, but a delegated job
 * lives on a remote worker node. This records, at delegate time, where each
 * job runs (`jobId → { deviceId, host, port, repoId }`) so `job_status`,
 * `job_result`, and `cancel_job` can route back to the right node — and, for
 * write jobs, so `job_result`'s lazy apply knows WHICH local repo (this
 * daemon's `config.repos` mapping for `repoId`) the artifact lands in. A
 * jobId absent from the registry is an "unknown job" — the tool returns a
 * clean error rather than guessing a node.
 *
 * Write-job apply state lives here too ({@link recordApplied}): once an
 * artifact has been fetched and applied into the local repo, the entry
 * remembers it so a repeated `job_result` call reports `applied` WITHOUT
 * re-downloading the bundle. A FAILED apply is deliberately not recorded —
 * the next `job_result` call simply retries.
 *
 * State is bounded (mirroring the M3/M5 discipline): past
 * {@link MAX_TRACKED_DELEGATIONS} entries the oldest is evicted. A `Map`
 * preserves insertion order, so the first key is always the oldest; touching
 * an existing job (re-record) moves it to the newest slot.
 */

/**
 * Cap on tracked delegations. A single delegating agent will rarely hold more
 * than a handful of live jobs; this cap only guards against unbounded growth
 * over a long-running daemon's lifetime (evict-oldest on overflow).
 */
export const MAX_TRACKED_DELEGATIONS = 1024;

/** Where a delegated job runs, enough to route follow-up HFP calls. */
export interface DelegationRoute {
  /** The worker's paired device ID (the fingerprint the client pins). */
  deviceId: string;
  host: string;
  port: number;
  /**
   * The job's repoId, as delegated. `job_result`'s write-artifact apply
   * resolves it back to this daemon's OWN local repo path (`config.repos`)
   * — the apply target is never taken from the worker's result.
   */
  repoId: string;
}

/** What {@link DelegationRegistry.recordApplied} remembers about an apply. */
export interface AppliedArtifact {
  /** The `refs/heads/homefleet/<jobId12>` branch the apply created. */
  branchName: string;
  /** The artifact's base — the `git diff base...branch` review anchor. */
  baseCommit: string;
}

interface DelegationEntry {
  route: DelegationRoute;
  /** Set once the write artifact has been applied into the local repo. */
  applied?: AppliedArtifact;
}

export class DelegationRegistry {
  private readonly entries = new Map<string, DelegationEntry>();

  /** Number of tracked delegations. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Records where a job runs. Re-recording an existing jobId replaces its
   * route (and clears any applied-artifact state — it is a NEW delegation)
   * and refreshes its recency (so it is evicted last). On overflow the
   * oldest entry is evicted.
   */
  record(jobId: string, route: DelegationRoute): void {
    // Delete-then-set so a re-record moves the key to the newest position.
    this.entries.delete(jobId);
    this.entries.set(jobId, { route: { ...route } });
    while (this.entries.size > MAX_TRACKED_DELEGATIONS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  /** The route for a jobId, or `undefined` when the job is not tracked. */
  lookup(jobId: string): DelegationRoute | undefined {
    const entry = this.entries.get(jobId);
    return entry === undefined ? undefined : { ...entry.route };
  }

  /**
   * Remembers that `jobId`'s write artifact was applied into the local repo,
   * so later `job_result` calls do not re-download the bundle. A no-op for
   * an untracked jobId (evicted between the apply and this call): the entry
   * is gone, and minting a routeless one would corrupt the registry.
   */
  recordApplied(jobId: string, applied: AppliedArtifact): void {
    const entry = this.entries.get(jobId);
    if (entry !== undefined) {
      entry.applied = { ...applied };
    }
  }

  /** The remembered apply for a jobId, or `undefined`. Returns a copy. */
  appliedArtifact(jobId: string): AppliedArtifact | undefined {
    const applied = this.entries.get(jobId)?.applied;
    return applied === undefined ? undefined : { ...applied };
  }
}
