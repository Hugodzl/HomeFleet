/**
 * HomeFleet executors (ADR-0003): the pluggable Executor contract, the
 * command executor, and the minimal agent loop. M4 surface — the M5 job
 * manager consumes these locally on the worker node. Test fixtures (the
 * scripted mock endpoint) are exported too: the daemon's M5 tests drive
 * the agent executor through them.
 */

export {
  type AgentEndpointOptions,
  AgentExecutor,
  type AgentExecutorOptions,
  EVENT_SUMMARY_MAX_CHARS,
  MAX_SUMMARY_BYTES,
  MIN_AGENT_CONTEXT_WINDOW,
  SUMMARY_TRUNCATION_MARKER,
} from "./agent/agent-executor.js";
export {
  type ChatCompletion,
  type ChatMessage,
  type ChatRequest,
  type ChatToolCall,
  type ChatUsage,
  EndpointHttpError,
  MalformedEndpointResponseError,
  OpenAiClient,
  type OpenAiClientOptions,
  type ToolDefinition,
  type WireToolCall,
} from "./agent/openai-client.js";
export {
  type AgentTool,
  type BuildToolsetOptions,
  buildToolset,
  GREP_MATCH_TIMEOUT_MS,
  MAX_GLOB_RESULTS,
  MAX_GREP_FILE_BYTES,
  MAX_GREP_MATCHES,
  MAX_GREP_TOTAL_BYTES,
  MAX_READ_FILE_BYTES,
  READ_FILE_TRUNCATION_MARKER,
  type ToolExecutionContext,
  type ToolResultPayload,
} from "./agent/tools.js";
export {
  editFileTool,
  MAX_EDIT_TEXT_CHARS,
  MAX_WRITE_FILE_BYTES,
  writeFileTool,
} from "./agent/write-tools.js";
export {
  CommandExecutor,
  type CommandExecutorOptions,
} from "./command/command-executor.js";
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
  KILL_GRACE_MS,
  MAX_CAPTURED_STREAM_BYTES,
  resolveSpawnInvocation,
  type SafeSpawnOutcome,
  type SafeSpawnRequest,
  type SpawnInvocation,
  STREAM_TRUNCATION_MARKER,
  safeSpawn,
} from "./spawn.js";
export {
  MockOpenAiEndpoint,
  type MockScriptEntry,
  type MockToolCall,
  type MockUsage,
  makeTempDir,
  type RecordedRequest,
  removeTempDir,
} from "./test-fixtures.js";
