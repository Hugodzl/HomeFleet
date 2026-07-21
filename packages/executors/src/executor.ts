/**
 * The pluggable executor contract (ADR-0003): the same interface the no-LLM
 * command executor and the minimal agent loop implement, and the interface
 * the M5 job manager consumes. Executors run on the WORKER node and are
 * invoked locally — no network or daemon wiring lives here.
 */
import type {
  JobId,
  JobParams,
  JobResult,
  JobType,
  LogEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@homefleet/protocol";

/**
 * The base fields the M5 job manager stamps onto every event. Executors
 * never mint these — jobId/seq/ts are the manager's business, as are the
 * `status` and `result` lifecycle events (which executors never emit).
 */
type JobEventBaseFields = "jobId" | "seq" | "ts";

/**
 * Executor-emitted observability events, WITHOUT the base fields. Derived
 * from the protocol event types via Omit so the payload shapes cannot drift
 * from the wire schemas.
 */
export type LogEventPayload = Omit<LogEvent, JobEventBaseFields>;
export type ToolCallEventPayload = Omit<ToolCallEvent, JobEventBaseFields>;
export type ToolResultEventPayload = Omit<ToolResultEvent, JobEventBaseFields>;
export type ExecutorEventPayload =
  | LogEventPayload
  | ToolCallEventPayload
  | ToolResultEventPayload;

/** The resolved model endpoint an agent/write execution talks to, per job. */
export interface AgentEndpointOptions {
  /** OpenAI-compatible base URL; `/chat/completions` is appended. */
  baseUrl: string;
  /** Sent as a Bearer token when present. */
  apiKey?: string;
  /** Model ID to request. */
  model: string;
  /**
   * Context window served by the endpoint, in tokens. Reserved for future
   * history-trimming (ADR-0003); the executor does not read it today — the
   * daemon's model resolver uses it to enforce the floor at dispatch.
   */
  contextWindow: number;
}

/** Everything an executor needs from the job manager to run one job. */
export interface ExecutionContext {
  jobId: JobId;
  /**
   * Absolute path to an already-materialized workspace. Workspace transfer
   * (git bundles, ADR-0005) is M7; executors just use the directory.
   */
  workspaceDir: string;
  /**
   * Fire-and-forget event sink; must never throw into the executor.
   * Executors additionally shield themselves from a throwing implementation
   * — an observability failure must never change a job's outcome.
   */
  emit: (event: ExecutorEventPayload) => void;
  /** Cancellation. Aborting yields a `canceled` result, not a rejection. */
  signal: AbortSignal;
  /**
   * Resolved model endpoint for this job (agent/write jobs only; the daemon's
   * catalog resolver sets it at submit time). Absent for command jobs.
   */
  endpoint?: AgentEndpointOptions;
}

/**
 * One job-execution engine. `execute()` RESOLVES with a `JobResult` in
 * every outcome — success, failure, timeout, budget exhaustion, and
 * cancellation are all encoded as a terminal status plus error per the
 * `JobResultSchema` cross-field rules; it rejects only on programmer error.
 * Implementations validate their constructed result with
 * `JobResultSchema.parse` before returning, and hold no shared mutable
 * state between `execute()` calls so they are safe to run concurrently.
 */
export interface Executor<T extends JobType = JobType> {
  readonly type: T;
  execute(
    params: Extract<JobParams, { type: T }>,
    context: ExecutionContext,
  ): Promise<JobResult>;
}
