/**
 * Delegation registry: MCP tools take a bare `jobId`, but a delegated job
 * lives on a remote worker node. This records, at delegate time, where each
 * job runs (`jobId → { deviceId, host, port }`) so `job_status`, `job_result`,
 * and `cancel_job` can route back to the right node. A jobId absent from the
 * registry is an "unknown job" — the tool returns a clean error rather than
 * guessing a node.
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
}

export class DelegationRegistry {
  private readonly entries = new Map<string, DelegationRoute>();

  /** Number of tracked delegations. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Records where a job runs. Re-recording an existing jobId replaces its
   * route and refreshes its recency (so it is evicted last). On overflow the
   * oldest entry is evicted.
   */
  record(jobId: string, route: DelegationRoute): void {
    // Delete-then-set so a re-record moves the key to the newest position.
    this.entries.delete(jobId);
    this.entries.set(jobId, { ...route });
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
    const route = this.entries.get(jobId);
    return route === undefined ? undefined : { ...route };
  }
}
