/**
 * The worker-side dispatch engine (M5). Accepts delegated jobs, runs them
 * through injected {@link Executor}s under a concurrency limit, stamps and
 * buffers the ordered {@link JobEvent} stream, streams it to live
 * subscribers, and honors cancellation — all in memory (jobs do not survive
 * a daemon restart, which is correct for v0).
 *
 * Ownership is the authorization boundary: every accessor takes the
 * requesting peer's device ID and a peer may only ever see or cancel jobs it
 * submitted. An id owned by another peer is indistinguishable from an absent
 * one (both `UNKNOWN_JOB`) so job existence never leaks across peers.
 *
 * No peer-driven state is unbounded: the queue is capped (`maxQueuedJobs` →
 * `BUSY`), retention is capped (`maxRetainedJobs`, oldest-terminal evicted
 * first), and per-job event buffers are bounded by the executor's own event
 * budget (a recon job's `maxToolCalls`, a command job's fixed handful).
 *
 * Design decisions (see also the RFC "Job Lifecycle"):
 * - A job is REJECTED at submit when its type has no executor
 *   (`UNSUPPORTED_JOB_TYPE`), so `delegate` returns an honest error rather
 *   than minting a doomed job.
 * - A picked-up job transitions to `running` (and emits the running status
 *   event) BEFORE its workspace is resolved: the RFC state machine only
 *   reaches a terminal state via `running`, so a workspace-resolution
 *   failure is a `running -> failed` transition, never `queued -> failed`.
 * - Canceling a `running` job aborts the executor and AWAITS its terminal
 *   unwind, so the `CancelResponse` carries the true terminal status rather
 *   than an optimistic guess.
 */
import { randomUUID } from "node:crypto";
import type {
  ExecutionContext,
  Executor,
  ExecutorEventPayload,
} from "@homefleet/executors";
import type {
  CancelResponse,
  JobEvent,
  JobId,
  JobParams,
  JobResult,
  JobSnapshot,
  JobType,
  WorkspaceRef,
} from "@homefleet/protocol";
import {
  CancelResponseSchema,
  isTerminalJobStatus,
  JobEventSchema,
  JobSnapshotSchema,
} from "@homefleet/protocol";
import { JobDispatchError, type JobRecord, type JobSubscriber } from "./job.js";

/** Default number of jobs that may run concurrently. */
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
/** Default cap on jobs waiting for a slot; submit beyond it -> `BUSY`. */
export const DEFAULT_MAX_QUEUED_JOBS = 64;
/** Default cap on retained (active + terminal) jobs; oldest terminal evicted first. */
export const DEFAULT_MAX_RETAINED_JOBS = 256;

/**
 * Bounded wait for a running executor to unwind on `cancel`/`stop`. The
 * shipped M4 executors self-bound (safeSpawn's kill grace, the agent's
 * fetch-abort), so they always win this race and the happy path is unchanged
 * — cancel still returns the TRUE terminal status. It is defense-in-depth
 * against a future (M6) executor that ignores its AbortSignal or blocks:
 * rather than hang the cancel HTTP handler or wedge daemon shutdown, the wait
 * gives up and reports honestly / proceeds with teardown.
 */
export const DEFAULT_CANCEL_UNWIND_TIMEOUT_MS = 30_000;

/**
 * What a {@link WorkspaceResolver} hands back: the absolute, materialized
 * workspace directory plus its `release` callback. `release()` is uniformly
 * promise-shaped — the read path's release is a synchronous unpin wrapped in
 * a resolved promise, while a write job's release genuinely awaits its
 * worktree teardown — so callers await it unconditionally instead of
 * maybe-promise juggling. It settles without throwing in both stores
 * (teardown failures are logged, never thrown).
 */
export interface WorkspaceHandle {
  dir: string;
  release: () => Promise<void>;
}

/**
 * Resolves a workspace reference to a release handle: the absolute,
 * already-materialized workspace directory plus a `release` callback. The
 * daemon injects a resolver (M5 does NOT transfer workspaces — that is M7, git
 * bundles). A rejection yields a terminal `failed` result with
 * `WORKSPACE_UNAVAILABLE`.
 *
 * `job` identifies WHO is asking: a `write`-typed job must be routed to a
 * dedicated ephemeral write worktree keyed by its jobId (the store's
 * `resolve(ref, { write: { jobId } })` path), while every other type shares
 * the pinned checkout cache.
 *
 * The handle PINS its workspace for as long as the job is using it: the
 * resolver holds a reference the store will not evict (read path) or a
 * dedicated worktree (write path), and the caller MUST await `release()`
 * exactly once when it is done with the directory (see
 * {@link JobManager.executeJob}).
 */
export type WorkspaceResolver = (
  ref: WorkspaceRef,
  owner: string,
  job: { jobId: JobId; type: JobType },
) => Promise<WorkspaceHandle>;

export interface JobManagerOptions {
  /** One executor per supported job type; a duplicate type is a config error. */
  executors: Executor[];
  resolveWorkspace: WorkspaceResolver;
  /** Defaults to {@link DEFAULT_MAX_CONCURRENT_JOBS}. */
  maxConcurrentJobs?: number;
  /** Defaults to {@link DEFAULT_MAX_QUEUED_JOBS}. */
  maxQueuedJobs?: number;
  /** Defaults to {@link DEFAULT_MAX_RETAINED_JOBS}. Should be >= concurrent + queued. */
  maxRetainedJobs?: number;
  /** Defaults to {@link DEFAULT_CANCEL_UNWIND_TIMEOUT_MS}. */
  cancelUnwindTimeoutMs?: number;
  /** Diagnostic sink for evictions and dropped events; defaults to a no-op. */
  logger?: (message: string) => void;
  /**
   * Called with the id of every job record this manager drops: retention
   * eviction ({@link JobManager.evictIfNeeded}) and the wholesale record
   * teardown in {@link JobManager.stop}. The daemon uses it to reap
   * per-job resources that outlive the run itself (a write job's artifact
   * bundle in the ArtifactStore). Shielded: a throwing hook is logged and
   * never breaks eviction or shutdown.
   */
  onJobEvicted?: (jobId: JobId) => void;
}

/** Distributes `Omit` across a union so each member keeps its own shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** What the manager appends before it stamps `{ jobId, seq, ts }`. */
type JobEventInput = DistributiveOmit<JobEvent, "jobId" | "seq" | "ts">;

/** The handle {@link JobManager.subscribe} returns to the SSE route. */
export interface JobSubscription {
  /** Stop receiving live events and release the registration. */
  unsubscribe(): void;
  /**
   * The job was already terminal at subscribe time: all in-range buffered
   * events (including the terminal `result`, if within range) were replayed
   * synchronously and no live events will follow, so the route may end.
   */
  isTerminal: boolean;
}

export class JobManager {
  private readonly executors: Map<JobType, Executor>;
  private readonly resolveWorkspace: WorkspaceResolver;
  private readonly maxConcurrentJobs: number;
  private readonly maxQueuedJobs: number;
  private readonly maxRetainedJobs: number;
  private readonly cancelUnwindTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly onJobEvicted: (jobId: JobId) => void;

  /** All retained jobs (active + terminal), keyed by id, insertion-ordered. */
  private readonly records = new Map<string, JobRecord>();
  /** Ids of jobs waiting for a run slot, FIFO. */
  private readonly queue: string[] = [];
  /** Ids of jobs currently running. */
  private readonly running = new Set<string>();
  /** Ids of terminal jobs in the order they terminated (eviction order). */
  private readonly terminalOrder: string[] = [];
  private stopped = false;

  constructor(options: JobManagerOptions) {
    this.executors = new Map();
    for (const executor of options.executors) {
      if (this.executors.has(executor.type)) {
        throw new Error(
          `duplicate executor registered for job type "${executor.type}"`,
        );
      }
      this.executors.set(executor.type, executor);
    }
    this.resolveWorkspace = options.resolveWorkspace;
    this.maxConcurrentJobs =
      options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.maxQueuedJobs = options.maxQueuedJobs ?? DEFAULT_MAX_QUEUED_JOBS;
    this.maxRetainedJobs = options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS;
    this.cancelUnwindTimeoutMs =
      options.cancelUnwindTimeoutMs ?? DEFAULT_CANCEL_UNWIND_TIMEOUT_MS;
    this.log = options.logger ?? (() => {});
    this.onJobEvicted = options.onJobEvicted ?? (() => {});
    if (this.maxConcurrentJobs < 1) {
      throw new Error("maxConcurrentJobs must be >= 1");
    }
  }

  /**
   * Number of jobs currently RUNNING. Feeds `NodeInfo.activeJobs` so peers
   * see this worker's live load in the `hello` handshake. Queued jobs are
   * deliberately NOT counted: the queue is not part of the advertised
   * profile, so a scheduler must not assume this reflects total backlog.
   */
  get activeJobs(): number {
    return this.running.size;
  }

  /**
   * The effective concurrency limit (constructor option or
   * {@link DEFAULT_MAX_CONCURRENT_JOBS}). Exposed so the NodeInfo assembly
   * advertises the number this manager actually enforces instead of
   * re-deriving it from config defaults.
   */
  get maxConcurrent(): number {
    return this.maxConcurrentJobs;
  }

  /**
   * Accepts a job for `owner`. Rejects (typed) an unsupported job type or a
   * full worker; otherwise mints a job id, records the job `queued`, and
   * starts it if a slot is free.
   */
  submit(params: JobParams, owner: string): { jobId: string } {
    if (this.stopped) {
      throw new JobDispatchError("INTERNAL", "job manager is stopped");
    }
    if (!this.executors.has(params.type)) {
      throw new JobDispatchError(
        "UNSUPPORTED_JOB_TYPE",
        `this worker does not support job type "${params.type}"`,
        { type: params.type },
      );
    }
    // Bound the queue: accept only if a slot is free (starts immediately) or
    // the queue has room. Never let peer submissions grow state without bound.
    if (
      this.running.size >= this.maxConcurrentJobs &&
      this.queue.length >= this.maxQueuedJobs
    ) {
      throw new JobDispatchError(
        "BUSY",
        `worker is busy (maxConcurrentJobs=${this.maxConcurrentJobs}, ` +
          `maxQueuedJobs=${this.maxQueuedJobs})`,
      );
    }

    const jobId = randomUUID();
    const record: JobRecord = {
      jobId,
      owner,
      params,
      status: "queued",
      events: [],
      subscribers: new Set(),
      abort: new AbortController(),
      createdAt: Date.now(),
    };
    this.records.set(jobId, record);
    this.queue.push(jobId);
    this.pump();
    return { jobId };
  }

  /** Polling view of a job, owner-checked. */
  snapshot(jobId: string, owner: string): JobSnapshot {
    const record = this.getOwned(jobId, owner);
    return JobSnapshotSchema.parse({
      jobId: record.jobId,
      status: record.status,
      ...(record.result !== undefined ? { result: record.result } : {}),
    });
  }

  /**
   * Requests cancellation, owner-checked. A queued job is canceled without
   * ever running; a running job is aborted and its terminal unwind awaited;
   * an already-terminal job is a no-op returning its terminal status.
   */
  async cancel(jobId: string, owner: string): Promise<CancelResponse> {
    const record = this.getOwned(jobId, owner);

    if (isTerminalJobStatus(record.status)) {
      return CancelResponseSchema.parse({
        jobId: record.jobId,
        status: record.status,
      });
    }

    if (record.status === "queued") {
      const index = this.queue.indexOf(jobId);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      this.finishJob(record, this.canceledResult(record));
      return CancelResponseSchema.parse({
        jobId: record.jobId,
        status: record.status,
      });
    }

    // Running: abort the executor and await the terminal transition so the
    // response reflects the true outcome (usually canceled; possibly a
    // succeeded/failed that raced the cancel). Bounded so a misbehaving
    // executor cannot hang the cancel handler: on overrun we return the
    // current (still non-terminal) status, which is truthful — cancellation
    // was requested and the abort fired; the unwind just has not completed.
    record.abort.abort();
    if (record.execution !== undefined) {
      const settled = await this.awaitBounded(record.execution);
      if (!settled) {
        this.log(
          `cancel(${jobId}): executor did not unwind within ` +
            `${this.cancelUnwindTimeoutMs}ms; reporting current status ` +
            `"${record.status}"`,
        );
      }
    }
    return CancelResponseSchema.parse({
      jobId: record.jobId,
      status: record.status,
    });
  }

  /**
   * Subscribes to a job's event stream, owner-checked. Buffered events with
   * `seq >= fromSeq` are replayed to `subscriber.onEvent` SYNCHRONOUSLY
   * (before this returns), then — for a still-live job — the subscriber is
   * registered for live events. Throws {@link JobDispatchError} `UNKNOWN_JOB`
   * for an absent or non-owned job (before any event is delivered), so the
   * SSE route can answer a JSON 404 before opening the stream.
   */
  subscribe(
    jobId: string,
    owner: string,
    fromSeq: number,
    subscriber: JobSubscriber,
  ): JobSubscription {
    const record = this.getOwned(jobId, owner);
    const start = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 0;

    // Snapshot-then-register is atomic (no await between): an emit cannot
    // interleave, so every event is delivered exactly once — replayed if it
    // predates registration, pushed live if it follows.
    const terminalNow = isTerminalJobStatus(record.status);
    for (const event of record.events) {
      if (event.seq >= start) {
        this.deliver(subscriber, event);
      }
    }
    if (terminalNow) {
      // No further events will come; nothing to unsubscribe.
      return { unsubscribe: () => {}, isTerminal: true };
    }

    record.subscribers.add(subscriber);
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) {
          return;
        }
        active = false;
        record.subscribers.delete(subscriber);
      },
      isTerminal: false,
    };
  }

  /**
   * Diagnostic: number of live subscribers on a job the caller owns.
   * Owner-checked like every other accessor, so it never leaks the existence
   * of another peer's (or an absent) job — it throws `UNKNOWN_JOB` instead.
   */
  subscriberCount(jobId: string, owner: string): number {
    return this.getOwned(jobId, owner).subscribers.size;
  }

  /**
   * Aborts every running job, cancels every queued job, ends all live
   * subscriptions, and awaits the in-flight executors so no handle outlives
   * the manager. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    // Cancel queued jobs (they never ran).
    const queued = this.queue.splice(0);
    for (const jobId of queued) {
      const record = this.records.get(jobId);
      if (record !== undefined && record.status === "queued") {
        this.finishJob(record, this.canceledResult(record));
      }
    }

    // Abort running jobs and await their unwind — bounded, so a misbehaving
    // executor cannot wedge shutdown: on overrun we log and tear down anyway.
    const executions: Promise<void>[] = [];
    for (const jobId of this.running) {
      const record = this.records.get(jobId);
      if (record !== undefined) {
        record.abort.abort();
        if (record.execution !== undefined) {
          executions.push(record.execution);
        }
      }
    }
    const settled = await this.awaitBounded(Promise.allSettled(executions));
    if (!settled) {
      this.log(
        `stop(): ${executions.length} executor(s) did not unwind within ` +
          `${this.cancelUnwindTimeoutMs}ms; proceeding with teardown`,
      );
    }

    // Any subscriber still attached (e.g. never saw its result): force-close.
    // Then clear every retained record, notifying the eviction hook for each
    // — stop() is the last time per-job resources (a write job's artifact)
    // can be reaped through this manager, so teardown counts as eviction.
    for (const record of this.records.values()) {
      for (const subscriber of record.subscribers) {
        this.closeSubscriber(subscriber);
      }
      record.subscribers.clear();
      this.notifyEvicted(record.jobId);
    }
    this.records.clear();
    this.terminalOrder.length = 0;
  }

  /**
   * Awaits `work`, but never longer than the unwind timeout. Returns whether
   * `work` settled in time (`false` == the guard fired first). The guard
   * timer is unref'd and always cleared, so it holds nothing open.
   */
  private async awaitBounded(work: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.cancelUnwindTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        work.then(
          () => {},
          () => {},
        ),
        guard,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return !timedOut;
  }

  /** Resolves an id to a record the caller owns, or throws UNKNOWN_JOB. */
  private getOwned(jobId: string, owner: string): JobRecord {
    const record = this.records.get(jobId);
    if (record === undefined || record.owner !== owner) {
      // Absent and not-owned are deliberately indistinguishable: existence
      // must not leak to a peer that did not submit the job.
      throw new JobDispatchError("UNKNOWN_JOB", `no job with id "${jobId}"`, {
        jobId,
      });
    }
    return record;
  }

  /** Starts queued jobs while slots are free (FIFO). */
  private pump(): void {
    if (this.stopped) {
      return;
    }
    while (
      this.running.size < this.maxConcurrentJobs &&
      this.queue.length > 0
    ) {
      const jobId = this.queue.shift();
      if (jobId === undefined) {
        break;
      }
      const record = this.records.get(jobId);
      // A job canceled or evicted while queued is skipped.
      if (record === undefined || record.status !== "queued") {
        continue;
      }
      // runJob's synchronous prefix adds to `running` and emits the running
      // status before its first await, so the loop condition stays accurate.
      record.execution = this.runJob(record);
    }
  }

  /**
   * Drives one job from `running` to a terminal result. Launched unawaited
   * by {@link pump}, so it MUST NOT reject: any escape is a backstop-finished
   * `INTERNAL` failure, and the slot is always released and `pump` re-run.
   */
  private async runJob(record: JobRecord): Promise<void> {
    this.running.add(record.jobId);
    try {
      await this.executeJob(record);
    } catch (error) {
      this.log(`runJob backstop for ${record.jobId}: ${describeError(error)}`);
      if (!isTerminalJobStatus(record.status)) {
        try {
          this.finishJob(
            record,
            this.errorResult(record, "INTERNAL", describeError(error)),
          );
        } catch (finishError) {
          this.log(
            `failed to finalize ${record.jobId}: ${describeError(finishError)}`,
          );
        }
      }
    } finally {
      this.running.delete(record.jobId);
      record.execution = undefined;
      this.pump();
    }
  }

  /** The actual queued -> running -> terminal work for one job. */
  private async executeJob(record: JobRecord): Promise<void> {
    record.status = "running";
    record.startedAt = Date.now();
    this.append(record, { type: "status", status: "running" });

    // Acquire the workspace as a release handle: for as long as `handle` is
    // held the checkout is PINNED against eviction (read path) or the job's
    // dedicated write worktree is live, so the store cannot yank a directory
    // this job is using. The job's {jobId, type} identity is what lets the
    // resolver route a write job to its own worktree. A resolution FAILURE is
    // caught here — nothing was acquired, so there is nothing to release.
    let handle: WorkspaceHandle;
    try {
      handle = await this.resolveWorkspace(
        record.params.workspace,
        record.owner,
        { jobId: record.jobId, type: record.params.type },
      );
    } catch (error) {
      this.finishJob(record, this.workspaceUnavailableResult(record, error));
      return;
    }

    // Past acquisition: `release()` must run (and be awaited) exactly once on
    // EVERY terminal path (abort-after-resolve, missing executor, executor
    // success/throw), so wrap the rest in a finally. `release()` is
    // idempotent in the store, but this finally is the single caller and
    // fires it just once. Awaiting is safe: both stores' releases log
    // teardown failures rather than throw.
    try {
      if (record.abort.signal.aborted) {
        this.finishJob(record, this.canceledResult(record));
        return;
      }

      const executor = this.executors.get(record.params.type);
      if (executor === undefined) {
        // Guarded at submit; here only if the registry changed under us.
        this.finishJob(
          record,
          this.errorResult(record, "UNSUPPORTED_JOB_TYPE", "no executor"),
        );
        return;
      }

      const context: ExecutionContext = {
        jobId: record.jobId,
        workspaceDir: handle.dir,
        emit: (payload) => this.emitExecutorEvent(record, payload),
        signal: record.abort.signal,
      };

      let result: JobResult;
      try {
        result = await executor.execute(
          // The registry key equals params.type, so this cast is sound.
          record.params as never,
          context,
        );
      } catch (error) {
        // Executors resolve in every outcome; a throw is a programmer error.
        result = this.errorResult(
          record,
          "INTERNAL",
          `executor threw: ${describeError(error)}`,
        );
      }
      this.finishJob(record, result);
    } finally {
      // Awaiting (not fire-and-forget) deliberately holds this job's
      // concurrency slot through workspace teardown: a write worktree's
      // removal is real disk churn on this machine, so the slot stays
      // occupied until it completes. Task 12's throughput measurements
      // should expect terminal-state-to-slot-free latency to include it.
      await handle.release();
    }
  }

  /**
   * Records a terminal result and emits the terminal status event THEN the
   * terminal result event (result is always last). Idempotent: a job that is
   * already terminal is left untouched.
   */
  private finishJob(record: JobRecord, result: JobResult): void {
    if (isTerminalJobStatus(record.status)) {
      return;
    }
    record.status = result.status;
    record.result = result;
    record.terminalAt = Date.now();
    this.terminalOrder.push(record.jobId);
    this.append(record, { type: "status", status: result.status });
    this.append(record, { type: "result", result });
    this.evictIfNeeded();
  }

  /** Delivers an executor-emitted payload (log/tool_call/tool_result only). */
  private emitExecutorEvent(
    record: JobRecord,
    payload: ExecutorEventPayload,
  ): void {
    // The manager — not the executor — owns status/result events. The payload
    // type forbids them at compile time; this allow-list re-checks at runtime
    // (executor code is external) and rejects a post-terminal straggler so the
    // `result` event is always last.
    const type = (payload as { type?: string }).type;
    if (type !== "log" && type !== "tool_call" && type !== "tool_result") {
      this.log(
        `dropping executor event of type "${type}" for job ${record.jobId}`,
      );
      return;
    }
    if (isTerminalJobStatus(record.status)) {
      this.log(`dropping post-terminal executor event for job ${record.jobId}`);
      return;
    }
    try {
      this.append(record, payload);
    } catch (error) {
      // An observability failure must never change a job's outcome.
      this.log(
        `dropped malformed executor event for job ${record.jobId}: ${describeError(error)}`,
      );
    }
  }

  /** Stamps `{ jobId, seq, ts }`, buffers, and notifies live subscribers. */
  private append(record: JobRecord, input: JobEventInput): void {
    const event = JobEventSchema.parse({
      ...input,
      jobId: record.jobId,
      seq: record.events.length,
      ts: new Date().toISOString(),
    });
    record.events.push(event);
    for (const subscriber of record.subscribers) {
      this.deliver(subscriber, event);
    }
  }

  /** Shielded event delivery: a dead socket must not crash the daemon. */
  private deliver(subscriber: JobSubscriber, event: JobEvent): void {
    try {
      subscriber.onEvent(event);
    } catch (error) {
      this.log(`subscriber onEvent threw: ${describeError(error)}`);
    }
  }

  private closeSubscriber(subscriber: JobSubscriber): void {
    try {
      subscriber.onClose();
    } catch (error) {
      this.log(`subscriber onClose threw: ${describeError(error)}`);
    }
  }

  /** Evicts oldest-terminal jobs until within the retention cap. */
  private evictIfNeeded(): void {
    while (
      this.records.size > this.maxRetainedJobs &&
      this.terminalOrder.length > 0
    ) {
      const oldest = this.terminalOrder.shift();
      if (oldest === undefined) {
        break;
      }
      const record = this.records.get(oldest);
      if (record === undefined || !isTerminalJobStatus(record.status)) {
        continue;
      }
      this.records.delete(oldest);
      for (const subscriber of record.subscribers) {
        this.closeSubscriber(subscriber);
      }
      record.subscribers.clear();
      this.notifyEvicted(record.jobId);
      this.log(
        `evicted terminal job ${oldest} (retention cap ${this.maxRetainedJobs} reached)`,
      );
    }
  }

  /** Shielded eviction notification: a throwing hook must not break eviction. */
  private notifyEvicted(jobId: JobId): void {
    try {
      this.onJobEvicted(jobId);
    } catch (error) {
      this.log(`onJobEvicted threw for ${jobId}: ${describeError(error)}`);
    }
  }

  private elapsedMs(record: JobRecord): number {
    return record.startedAt === undefined ? 0 : Date.now() - record.startedAt;
  }

  private canceledResult(record: JobRecord): JobResult {
    return {
      jobId: record.jobId,
      type: record.params.type,
      status: "canceled",
      stats: { toolCalls: 0, wallMs: this.elapsedMs(record) },
      error: { code: "CANCELED", message: "job canceled" },
    };
  }

  private workspaceUnavailableResult(
    record: JobRecord,
    error: unknown,
  ): JobResult {
    return {
      jobId: record.jobId,
      type: record.params.type,
      status: "failed",
      stats: { toolCalls: 0, wallMs: this.elapsedMs(record) },
      error: {
        code: "WORKSPACE_UNAVAILABLE",
        message: `workspace unavailable: ${describeError(error)}`,
        details: { workspace: record.params.workspace },
      },
    };
  }

  private errorResult(
    record: JobRecord,
    code: "INTERNAL" | "UNSUPPORTED_JOB_TYPE",
    message: string,
  ): JobResult {
    return {
      jobId: record.jobId,
      type: record.params.type,
      status: "failed",
      stats: { toolCalls: 0, wallMs: this.elapsedMs(record) },
      error: { code, message },
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
