/**
 * HomeFleet executors (ADR-0003): the pluggable Executor contract, the
 * command executor, and the minimal agent loop. M4 surface — the M5 job
 * manager consumes these locally on the worker node.
 */
export type {
  ExecutionContext,
  Executor,
  ExecutorEventPayload,
  LogEventPayload,
  ToolCallEventPayload,
  ToolResultEventPayload,
} from "./executor.js";
export {
  type CommandAllowlist,
  type CommandAllowlistEntry,
  MAX_CAPTURED_STREAM_BYTES,
  resolveSpawnInvocation,
  type SafeSpawnOutcome,
  type SafeSpawnRequest,
  STREAM_TRUNCATION_MARKER,
  safeSpawn,
} from "./spawn.js";
