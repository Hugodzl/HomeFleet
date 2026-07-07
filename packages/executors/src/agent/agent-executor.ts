/**
 * The minimal agent loop (ADR-0003): drives an OpenAI-compatible model
 * through a read-only recon task with workspace-sandboxed tools, hard
 * budgets, and structured events — a purpose-built loop, deliberately NOT a
 * wrapper around an existing agent harness.
 *
 * Failure taxonomy: tool-level failures (sandbox rejections, unknown tool
 * names, unparseable arguments, command refusals) are returned TO THE MODEL
 * as error tool-results and the loop continues; only infrastructure
 * failures — the endpoint unreachable or answering garbage — fail the job.
 */
import {
  type JobResult,
  JobResultSchema,
  type JobStats,
  type ReconJobParams,
} from "@homefleet/protocol";
import type { ExecutionContext, Executor } from "../executor.js";
import type { CommandAllowlist } from "../spawn.js";
import { decodeUtf8Capped, truncateChars } from "../truncation.js";
import {
  type ChatMessage,
  OpenAiClient,
  type WireToolCall,
} from "./openai-client.js";
import {
  type AgentTool,
  buildToolset,
  type ToolResultPayload,
} from "./tools.js";

/**
 * Locked design decision: endpoints advertising less than 16k context are
 * refused outright. Model servers commonly default to 4k, which silently
 * breaks agentic use — the conversation (system prompt + tool results)
 * overflows and the model loses the thread mid-task. Raise the served
 * context window instead of lowering this floor.
 */
export const MIN_AGENT_CONTEXT_WINDOW = 16_384;

/** Cap for tool_call/tool_result event summaries (UTF-16 code units). */
export const EVENT_SUMMARY_MAX_CHARS = 512;

/**
 * Byte cap for the job summary (the model's final content). Every other
 * model/child-controlled string in M4 is capped so a result always fits the
 * transport's 1 MiB body limit (`MAX_BODY_BYTES`); the summary was the one
 * uncapped survivor. 256 KiB matches the per-stream capture cap.
 *
 * Enforced here in the executor, NOT as a `.max()` on JobResultSchema:
 * tightening the wire contract is an RFC-sync change (M-later hardening),
 * and doing it schema-side would turn an oversized summary into a validation
 * throw rather than a graceful truncation. Future hardening: mirror this cap
 * in the schema once the RFC is updated.
 */
export const MAX_SUMMARY_BYTES = 262_144;

/** Appended to a summary cut at {@link MAX_SUMMARY_BYTES}. */
export const SUMMARY_TRUNCATION_MARKER = `\n[summary truncated: exceeded ${MAX_SUMMARY_BYTES} bytes]`;

/**
 * Caps the model's final content to {@link MAX_SUMMARY_BYTES}, cutting on a
 * UTF-8 character boundary (no split multi-byte char) and appending the
 * marker on overflow. Reuses the same byte-capping machinery as the spawn
 * capture and read_file.
 */
function capSummary(content: string): string {
  const { text, truncated } = decodeUtf8Capped(
    Buffer.from(content, "utf8"),
    MAX_SUMMARY_BYTES,
  );
  return truncated ? text + SUMMARY_TRUNCATION_MARKER : text;
}

export interface AgentEndpointOptions {
  /** OpenAI-compatible base URL; `/chat/completions` is appended. */
  baseUrl: string;
  /** Sent as a Bearer token when present. */
  apiKey?: string;
  /** Default model ID; a job's `params.model` overrides it (same endpoint). */
  model: string;
  /** Context window served by the endpoint, in tokens. */
  contextWindow: number;
}

export interface AgentExecutorOptions {
  endpoint: AgentEndpointOptions;
  /**
   * Allowlist for the run_command tool; absent or empty disables the tool
   * AND omits it from the definitions advertised to the model.
   */
  commandAllowlist?: CommandAllowlist;
}

function systemPrompt(workspaceDir: string, toolset: AgentTool[]): string {
  const toolNames = toolset.map((tool) => tool.name).join(", ");
  return (
    "You are a read-only reconnaissance agent. Investigate the repository " +
    `checked out at ${workspaceDir} and answer the user's request. You ` +
    "cannot modify anything; inspect the workspace with the available " +
    `tools (${toolNames}), using workspace-relative paths. When you have ` +
    "enough information, reply with a plain-text summary — that reply " +
    "ends the job."
  );
}

export class AgentExecutor implements Executor<"recon"> {
  readonly type = "recon" as const;
  private readonly endpoint: AgentEndpointOptions;
  private readonly commandAllowlist: CommandAllowlist;
  private readonly client: OpenAiClient;

  constructor(options: AgentExecutorOptions) {
    this.endpoint = options.endpoint;
    this.commandAllowlist = options.commandAllowlist ?? {};
    this.client = new OpenAiClient({
      baseUrl: options.endpoint.baseUrl,
      ...(options.endpoint.apiKey !== undefined
        ? { apiKey: options.endpoint.apiKey }
        : {}),
    });
  }

  async execute(
    params: ReconJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    // The schema's cross-field rules are the contract.
    return JobResultSchema.parse(await this.run(params, context));
  }

  private async run(
    params: ReconJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    const startedAt = Date.now();
    let toolCallsUsed = 0;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    // Shield against a throwing emit: an observability failure must never
    // change a job's outcome (see the ExecutionContext contract).
    const emit: ExecutionContext["emit"] = (event) => {
      try {
        context.emit(event);
      } catch {
        // Dropped by design.
      }
    };

    const stats = (): JobStats => ({
      toolCalls: toolCallsUsed,
      wallMs: Date.now() - startedAt,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
    });
    const failed = (
      code: "INVALID_REQUEST" | "BUDGET_EXCEEDED" | "INTERNAL",
      message: string,
    ): JobResult => ({
      jobId: context.jobId,
      type: this.type,
      status: "failed",
      stats: stats(),
      error: { code, message },
    });
    const canceled = (): JobResult => ({
      jobId: context.jobId,
      type: this.type,
      status: "canceled",
      stats: stats(),
      error: { code: "CANCELED", message: "job canceled" },
    });

    // NOTE: contextWindow is validated-at-floor here (>= MIN_AGENT_CONTEXT_
    // WINDOW) ONLY. It is NOT yet used to bound message-history growth: the
    // loop appends every assistant turn and tool result without trimming, so
    // this value must not be mistaken for "context remaining". Budgets
    // (maxToolCalls / maxWallMs) are what bound a run today; ADR-0003's
    // minimal loop is the deliberate v0 decision and history-trimming is
    // future work, not built here.
    if (this.endpoint.contextWindow < MIN_AGENT_CONTEXT_WINDOW) {
      return failed(
        "INVALID_REQUEST",
        `endpoint contextWindow ${this.endpoint.contextWindow} is below the ` +
          `required minimum of ${MIN_AGENT_CONTEXT_WINDOW}: model servers ` +
          "commonly default to 4k contexts, which silently break agentic " +
          "tool use; raise the served context window instead.",
      );
    }

    const toolset = buildToolset(this.commandAllowlist);
    const toolsByName = new Map(toolset.map((tool) => [tool.name, tool]));
    const toolDefinitions = toolset.map((tool) => tool.definition);
    const model = params.model ?? this.endpoint.model;
    const { maxToolCalls, maxWallMs } = params.budgets;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(context.workspaceDir, toolset) },
      { role: "user", content: params.prompt },
    ];

    while (true) {
      if (context.signal.aborted) {
        return canceled();
      }
      const remainingMs = maxWallMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        return failed(
          "BUDGET_EXCEEDED",
          `wall-time budget exceeded (maxWallMs=${maxWallMs})`,
        );
      }

      // The wall budget is enforced ON the fetch too, so a hung endpoint
      // cannot blow past it. Composed by hand rather than AbortSignal.any:
      // the listener on the job signal is deterministically removed every
      // iteration instead of accumulating until GC.
      const fetchController = new AbortController();
      const onAbort = (): void => fetchController.abort();
      context.signal.addEventListener("abort", onAbort, { once: true });
      const wallTimer = setTimeout(() => fetchController.abort(), remainingMs);

      let completion: Awaited<ReturnType<OpenAiClient["chat"]>>;
      try {
        completion = await this.client.chat({
          model,
          messages,
          tools: toolDefinitions,
          signal: fetchController.signal,
        });
      } catch (error) {
        if (context.signal.aborted) {
          return canceled();
        }
        if (Date.now() - startedAt >= maxWallMs) {
          return failed(
            "BUDGET_EXCEEDED",
            `wall-time budget exceeded during a model call (maxWallMs=${maxWallMs})`,
          );
        }
        return failed(
          "INTERNAL",
          `endpoint failure: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(wallTimer);
        context.signal.removeEventListener("abort", onAbort);
      }

      if (completion.usage !== undefined) {
        promptTokens = (promptTokens ?? 0) + completion.usage.promptTokens;
        completionTokens =
          (completionTokens ?? 0) + completion.usage.completionTokens;
      }

      if (completion.toolCalls.length === 0) {
        if (completion.content === null) {
          return failed(
            "INTERNAL",
            "endpoint returned neither content nor tool calls",
          );
        }
        // Plain content is the summary: the job is done. Capped so the
        // result always fits the transport body limit (see MAX_SUMMARY_BYTES).
        return {
          jobId: context.jobId,
          type: this.type,
          status: "succeeded",
          summary: capSummary(completion.content),
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
        if (toolCallsUsed >= maxToolCalls) {
          return failed(
            "BUDGET_EXCEEDED",
            `tool-call budget exceeded (maxToolCalls=${maxToolCalls})`,
          );
        }
        toolCallsUsed += 1;
        emit({
          type: "tool_call",
          name: call.name,
          argsSummary: truncateChars(call.arguments, EVENT_SUMMARY_MAX_CHARS),
        });
        const result = await this.invokeTool(toolsByName, call, context, {
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
        if (context.signal.aborted) {
          return canceled();
        }
      }
    }
  }

  /**
   * Runs one tool call. Unknown names and unparseable arguments are error
   * tool-results like any other tool failure — the model gets to react.
   */
  private async invokeTool(
    toolsByName: Map<string, AgentTool>,
    call: { name: string; arguments: string },
    context: ExecutionContext,
    budget: { commandTimeoutMs: number },
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
    return tool.execute(args, {
      workspaceDir: context.workspaceDir,
      signal: context.signal,
      commandTimeoutMs: budget.commandTimeoutMs,
    });
  }
}
