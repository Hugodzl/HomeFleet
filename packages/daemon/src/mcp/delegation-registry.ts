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
 * the next `job_result` call simply retries. OVERLAPPING calls share one
 * in-flight apply ({@link DelegationRegistry.singleFlightApply}), so two
 * concurrent `job_result`s can never race git and report contradictory
 * outcomes.
 *
 * State is bounded (mirroring the M3/M5 discipline): past
 * {@link MAX_TRACKED_DELEGATIONS} entries the oldest is evicted. A `Map`
 * preserves insertion order, so the first key is always the oldest; touching
 * an existing job (re-record) moves it to the newest slot.
 */

import type { JobStatus, JobType } from "@homefleet/protocol";

/**
 * Cap on tracked delegations. A single delegating agent will rarely hold more
 * than a handful of live jobs; this cap only guards against unbounded growth
 * over a long-running daemon's lifetime (evict-oldest on overflow).
 */
export const MAX_TRACKED_DELEGATIONS = 1024;

/** How many delegations `list()` returns by default (newest first). */
export const DEFAULT_DELEGATION_LIST_LIMIT = 100;

export interface DelegationRegistryOptions {
  /** Clock for `recordedAt` / `lastStatusAt`; defaults to `Date.now`. */
  now?: () => number;
}

/** A metadata-only view of one tracked delegation, for the control API. */
export interface DelegationListing {
  jobId: string;
  type: JobType;
  /** The worker's paired device ID. */
  deviceId: string;
  repoId: string;
  recordedAt: number;
  /**
   * The last status an MCP tool (`job_status` / `job_result`) observed from
   * the worker; `queued` until one does. Never fetched by the listing
   * itself — it is "last seen", not live.
   */
  lastStatus: JobStatus;
  lastStatusAt: number;
  appliedBranch?: string;
}

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
  type: JobType;
  recordedAt: number;
  lastStatus: JobStatus;
  lastStatusAt: number;
  /** Set once the write artifact has been applied into the local repo. */
  applied?: AppliedArtifact;
}

export class DelegationRegistry {
  private readonly entries = new Map<string, DelegationEntry>();
  /**
   * In-flight apply computations, for {@link singleFlightApply}. Kept
   * SEPARATE from {@link entries}: flights are transient (deleted when they
   * settle) and bounded by the number of concurrently-executing MCP calls,
   * so they need no cap or eviction of their own.
   */
  private readonly applyFlights = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(options: DelegationRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Number of tracked delegations. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Records where a job runs, and what type it is, stamped with the current
   * time and an initial `queued` status. Re-recording an existing jobId
   * replaces its route (and clears any applied-artifact state — it is a NEW
   * delegation) and refreshes its recency (so it is evicted last). On
   * overflow the oldest entry is evicted.
   */
  record(jobId: string, route: DelegationRoute, type: JobType): void {
    // Delete-then-set so a re-record moves the key to the newest position.
    this.entries.delete(jobId);
    const at = this.now();
    this.entries.set(jobId, {
      route: { ...route },
      type,
      recordedAt: at,
      lastStatus: "queued",
      lastStatusAt: at,
    });
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

  /**
   * Remembers the latest status an MCP tool observed for `jobId` (fed by
   * `job_status` / `job_result`), so the dashboard can show delegated jobs
   * without making LAN calls of its own. A no-op for an untracked jobId.
   */
  observeStatus(jobId: string, status: JobStatus): void {
    const entry = this.entries.get(jobId);
    if (entry !== undefined) {
      entry.lastStatus = status;
      entry.lastStatusAt = this.now();
    }
  }

  /** The newest `limit` tracked delegations, newest first, metadata only. */
  list(limit = DEFAULT_DELEGATION_LIST_LIMIT): DelegationListing[] {
    const all = [...this.entries.entries()];
    const out: DelegationListing[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const [jobId, entry] = all[i] as [string, DelegationEntry];
      out.push({
        jobId,
        type: entry.type,
        deviceId: entry.route.deviceId,
        repoId: entry.route.repoId,
        recordedAt: entry.recordedAt,
        lastStatus: entry.lastStatus,
        lastStatusAt: entry.lastStatusAt,
        ...(entry.applied !== undefined
          ? { appliedBranch: entry.applied.branchName }
          : {}),
      });
    }
    return out;
  }

  /**
   * Single-flight gate for the per-job apply computation: overlapping
   * callers for one jobId share ONE `run()` (they all await — and report —
   * the same outcome), and the slot is freed when it settles, so a later
   * call starts a fresh run (which is exactly the failed-apply retry
   * semantics). Lives on the registry because the registry is the
   * CROSS-REQUEST state: the MCP HTTP front builds a fresh McpServer per
   * request, so any per-server bookkeeping would never see the sibling call.
   *
   * The unchecked cast is sound as long as every caller uses one result
   * type per jobId — true today: `job_result`'s write surface is the only
   * call site.
   */
  singleFlightApply<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    const existing = this.applyFlights.get(jobId);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }
    const flight = (async () => run())().finally(() => {
      this.applyFlights.delete(jobId);
    });
    this.applyFlights.set(jobId, flight);
    return flight;
  }
}
