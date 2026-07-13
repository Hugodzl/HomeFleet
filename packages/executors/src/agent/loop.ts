/**
 * The model-conversation tool loop (ADR-0003), extracted from AgentExecutor
 * so the v0.2 write executor can reuse it: drives an OpenAI-compatible model
 * through tool calls under hard budgets (wall time and tool-call count),
 * emitting structured tool_call/tool_result events.
 *
 * Failure taxonomy (unchanged from the recon loop): tool-level failures
 * (sandbox rejections, unknown tool names, unparseable arguments, command
 * refusals) are returned TO THE MODEL as error tool-results and the loop
 * continues; only infrastructure failures — the endpoint unreachable or
 * answering garbage — end the loop, as an `endpoint_failure` outcome the
 * caller maps to a failed job.
 */
import type { ExecutorEventPayload } from "../executor.js";
import { truncateChars } from "../truncation.js";
import type {
  ChatMessage,
  OpenAiClient,
  WireToolCall,
} from "./openai-client.js";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolResultPayload,
} from "./tools.js";

/** Cap for tool_call/tool_result event summaries (UTF-16 code units). */
export const EVENT_SUMMARY_MAX_CHARS = 512;

export interface ToolLoopOptions {
  client: OpenAiClient;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Toolset advertised to the model AND dispatched by the loop. */
  tools: AgentTool[];
  budgets: { maxToolCalls: number; maxWallMs: number };
  /**
   * Tool names that TERMINATE the loop when the model calls them; the call
   * is returned (parsed, as a `terminal_call` outcome), not executed, and
   * consumes no tool-call budget. Recon passes none. A terminal call whose
   * arguments are not valid JSON falls through to the normal dispatch path,
   * which answers the model with an error tool-result — the tool is still
   * never executed (dispatch parses arguments before running anything).
   */
  terminalTools?: string[];
  /**
   * Workspace the tools operate on. The other {@link ToolExecutionContext}
   * fields are the loop's to provide: `signal` is {@link ToolLoopOptions.signal}
   * and `commandTimeoutMs` is derived per call from the remaining wall budget.
   */
  toolContext: Pick<ToolExecutionContext, "workspaceDir">;
  /** Event sink; the CALLER is responsible for shielding a throwing emit. */
  emit: (event: ExecutorEventPayload) => void;
  /** Cancellation; yields an `aborted` outcome, never a rejection. */
  signal: AbortSignal;
}

/** Structurally identical to the protocol's JobStats. */
export interface ToolLoopStats {
  toolCalls: number;
  wallMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type ToolLoopOutcome =
  | {
      /** The model replied with plain content: the conversation is done. */
      kind: "content";
      finalContent: string;
      stats: ToolLoopStats;
    }
  | {
      /** The model called a {@link ToolLoopOptions.terminalTools} tool. */
      kind: "terminal_call";
      terminalCall: { name: string; args: unknown };
      stats: ToolLoopStats;
    }
  | {
      /** A wall-time or tool-call budget ran out. */
      kind: "budget_exhausted";
      errorMessage: string;
      stats: ToolLoopStats;
    }
  | {
      /** Infrastructure failure: endpoint unreachable or answered garbage. */
      kind: "endpoint_failure";
      errorMessage: string;
      stats: ToolLoopStats;
    }
  | {
      /** {@link ToolLoopOptions.signal} aborted. */
      kind: "aborted";
      stats: ToolLoopStats;
    };

/**
 * Runs the conversation until the model produces content, a terminal tool
 * call arrives, a budget runs out, the endpoint fails, or the signal aborts.
 * Every outcome is a resolution — the loop rejects only on programmer error.
 *
 * NOTE: message history grows unbounded — every assistant turn and tool
 * result is appended without trimming; budgets (maxToolCalls / maxWallMs)
 * are what bound a run. ADR-0003's minimal loop is the deliberate v0
 * decision and history-trimming is future work, not built here.
 */
export async function runToolLoop(
  options: ToolLoopOptions,
): Promise<ToolLoopOutcome> {
  const { client, model, tools, emit, signal } = options;
  const { maxToolCalls, maxWallMs } = options.budgets;
  const terminalTools = new Set(options.terminalTools ?? []);
  const startedAt = Date.now();
  let toolCallsUsed = 0;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  const stats = (): ToolLoopStats => ({
    toolCalls: toolCallsUsed,
    wallMs: Date.now() - startedAt,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  });

  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolDefinitions = tools.map((tool) => tool.definition);

  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];

  while (true) {
    if (signal.aborted) {
      return { kind: "aborted", stats: stats() };
    }
    const remainingMs = maxWallMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return {
        kind: "budget_exhausted",
        errorMessage: `wall-time budget exceeded (maxWallMs=${maxWallMs})`,
        stats: stats(),
      };
    }

    // The wall budget is enforced ON the fetch too, so a hung endpoint
    // cannot blow past it. Composed by hand rather than AbortSignal.any:
    // the listener on the job signal is deterministically removed every
    // iteration instead of accumulating until GC.
    const fetchController = new AbortController();
    const onAbort = (): void => fetchController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const wallTimer = setTimeout(() => fetchController.abort(), remainingMs);

    let completion: Awaited<ReturnType<OpenAiClient["chat"]>>;
    try {
      completion = await client.chat({
        model,
        messages,
        tools: toolDefinitions,
        signal: fetchController.signal,
      });
    } catch (error) {
      if (signal.aborted) {
        return { kind: "aborted", stats: stats() };
      }
      if (Date.now() - startedAt >= maxWallMs) {
        return {
          kind: "budget_exhausted",
          errorMessage: `wall-time budget exceeded during a model call (maxWallMs=${maxWallMs})`,
          stats: stats(),
        };
      }
      return {
        kind: "endpoint_failure",
        errorMessage: `endpoint failure: ${error instanceof Error ? error.message : String(error)}`,
        stats: stats(),
      };
    } finally {
      clearTimeout(wallTimer);
      signal.removeEventListener("abort", onAbort);
    }

    if (completion.usage !== undefined) {
      promptTokens = (promptTokens ?? 0) + completion.usage.promptTokens;
      completionTokens =
        (completionTokens ?? 0) + completion.usage.completionTokens;
    }

    if (completion.toolCalls.length === 0) {
      if (completion.content === null) {
        return {
          kind: "endpoint_failure",
          errorMessage: "endpoint returned neither content nor tool calls",
          stats: stats(),
        };
      }
      // Plain content: the conversation is done.
      return {
        kind: "content",
        finalContent: completion.content,
        stats: stats(),
      };
    }

    // Echo the assistant turn, then answer every tool call in order.
    messages.push({
      role: "assistant",
      content: completion.content,
      tool_calls: completion.toolCalls.map(
        (call): WireToolCall => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }),
      ),
    });

    for (const call of completion.toolCalls) {
      if (terminalTools.has(call.name)) {
        let args: unknown;
        let parsed = false;
        try {
          args = JSON.parse(call.arguments);
          parsed = true;
        } catch {
          // Fall through to the normal dispatch below: it answers the model
          // with the standard invalid-JSON error tool-result WITHOUT ever
          // executing the tool (arguments are parsed before execution).
        }
        if (parsed) {
          return {
            kind: "terminal_call",
            terminalCall: { name: call.name, args },
            stats: stats(),
          };
        }
      }
      if (toolCallsUsed >= maxToolCalls) {
        return {
          kind: "budget_exhausted",
          errorMessage: `tool-call budget exceeded (maxToolCalls=${maxToolCalls})`,
          stats: stats(),
        };
      }
      toolCallsUsed += 1;
      emit({
        type: "tool_call",
        name: call.name,
        argsSummary: truncateChars(call.arguments, EVENT_SUMMARY_MAX_CHARS),
      });
      const result = await invokeTool(toolsByName, call, {
        workspaceDir: options.toolContext.workspaceDir,
        signal,
        commandTimeoutMs: Math.max(1, maxWallMs - (Date.now() - startedAt)),
      });
      emit({
        type: "tool_result",
        name: call.name,
        resultSummary: truncateChars(result.content, EVENT_SUMMARY_MAX_CHARS),
        isError: result.isError,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content,
      });
      if (signal.aborted) {
        return { kind: "aborted", stats: stats() };
      }
    }
  }
}

/**
 * Runs one tool call. Unknown names and unparseable arguments are error
 * tool-results like any other tool failure — the model gets to react.
 */
async function invokeTool(
  toolsByName: Map<string, AgentTool>,
  call: { name: string; arguments: string },
  context: ToolExecutionContext,
): Promise<ToolResultPayload> {
  const tool = toolsByName.get(call.name);
  if (tool === undefined) {
    return { isError: true, content: `unknown tool: ${call.name}` };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return {
      isError: true,
      content: `tool arguments are not valid JSON: ${truncateChars(call.arguments, 256)}`,
    };
  }
  return tool.execute(args, context);
}
