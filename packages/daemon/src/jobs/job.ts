/**
 * Worker-side job state: the in-memory record the {@link JobManager} keeps
 * per delegated job, the live-subscriber contract the SSE route consumes,
 * and the typed dispatch error that route handlers map to HFP status codes.
 *
 * These are the manager's private data shapes; the wire contract lives in
 * `@homefleet/protocol` (JobParams / JobResult / JobEvent / JobSnapshot).
 */
import type { AgentEndpointOptions } from "@homefleet/executors";
import type {
  HfpError,
  HfpErrorCode,
  JobEvent,
  JobId,
  JobParams,
  JobResult,
  JobStatus,
} from "@homefleet/protocol";

/**
 * A live SSE subscriber. `onEvent` receives every stamped event (buffered
 * replay first, then live) in `seq` order; `onClose` is the manager telling
 * the subscriber to end its stream (e.g. on {@link JobManager.stop} or
 * retention eviction). Both are fire-and-forget: the manager shields itself
 * from a throwing implementation so a dead socket cannot crash a job.
 */
export interface JobSubscriber {
  onEvent(event: JobEvent): void;
  onClose(): void;
}

/**
 * Everything the manager tracks for one job. Events are the ordered,
 * append-only truth: `seq === events index`, and the terminal `result`
 * event is always last.
 */
export interface JobRecord {
  jobId: JobId;
  /** Device ID of the peer that submitted the job — the only peer allowed to see it. */
  owner: string;
  params: JobParams;
  status: JobStatus;
  /**
   * The resolved model endpoint for this job (agent/write jobs only),
   * computed once at submit time by the injected {@link ModelResolver} and
   * threaded into the {@link ExecutionContext} unchanged — the resolver's
   * output is the ONLY source of `context.endpoint`.
   */
  endpoint?: AgentEndpointOptions;
  /** Present iff `status` is terminal. */
  result?: JobResult;
  /** Ordered event buffer; `events[i].seq === i`. */
  events: JobEvent[];
  subscribers: Set<JobSubscriber>;
  /** Aborting cancels the executor (M4 executors resolve `canceled`). */
  abort: AbortController;
  createdAt: number;
  /** When the executor picked the job up (transition to `running`). */
  startedAt?: number;
  /** When the job reached a terminal status. */
  terminalAt?: number;
  /** The in-flight `runJob` promise while the job is running; awaited by cancel/stop. */
  execution?: Promise<void>;
}

/**
 * A typed worker-side failure that a route handler maps to an HTTP status +
 * `HfpError` body. Submit-time rejections (BUSY, UNSUPPORTED_JOB_TYPE) and
 * accessor rejections (UNKNOWN_JOB) both flow through this.
 */
export class JobDispatchError extends Error {
  readonly code: HfpErrorCode;
  readonly details?: HfpError["details"];

  constructor(
    code: HfpErrorCode,
    message: string,
    details?: HfpError["details"],
  ) {
    super(message);
    this.name = "JobDispatchError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  toHfpError(): HfpError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
