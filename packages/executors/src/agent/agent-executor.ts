/**
 * The minimal agent loop (ADR-0003): drives an OpenAI-compatible model
 * through a read-only recon task with workspace-sandboxed tools, hard
 * budgets, and structured events — a purpose-built loop, deliberately NOT a
 * wrapper around an existing agent harness. The conversation loop itself
 * lives in loop.ts (shared with the v0.2 write executor); this executor
 * owns the recon-specific policy: the context-window floor, the read-only
 * system prompt, summary capping, and the ToolLoopOutcome → JobResult
 * mapping.
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
import { decodeUtf8Capped } from "../truncation.js";
import { runToolLoop } from "./loop.js";
import { OpenAiClient } from "./openai-client.js";
import type { AgentTool } from "./tools.js";
import { buildToolset } from "./toolset.js";

// Re-exported from its new home (loop.ts) so the package surface and
// existing importers are unaffected by the loop extraction.
export { EVENT_SUMMARY_MAX_CHARS } from "./loop.js";

/**
 * Locked design decision: endpoints advertising less than 16k context are
 * refused outright. Model servers commonly default to 4k, which silently
 * breaks agentic use — the conversation (system prompt + tool results)
 * overflows and the model loses the thread mid-task. Raise the served
 * context window instead of lowering this floor.
 */
export const MIN_AGENT_CONTEXT_WINDOW = 16_384;

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
 * capture and read_file. Exported for the write executor, which caps its
 * summaries (final content or finish_task's summary) identically.
 */
export function capSummary(content: string): string {
  const { text, truncated } = decodeUtf8Capped(
    Buffer.from(content, "utf8"),
    MAX_SUMMARY_BYTES,
  );
  return truncated ? text + SUMMARY_TRUNCATION_MARKER : text;
}

export interface AgentExecutorOptions {
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
  private readonly commandAllowlist: CommandAllowlist;

  constructor(options: AgentExecutorOptions = {}) {
    this.commandAllowlist = options.commandAllowlist ?? {};
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

    // Shield against a throwing emit: an observability failure must never
    // change a job's outcome (see the ExecutionContext contract).
    const emit: ExecutionContext["emit"] = (event) => {
      try {
        context.emit(event);
      } catch {
        // Dropped by design.
      }
    };

    const failed = (
      code: "INVALID_REQUEST" | "BUDGET_EXCEEDED" | "INTERNAL",
      message: string,
      stats: JobStats,
    ): JobResult => ({
      jobId: context.jobId,
      type: this.type,
      status: "failed",
      stats,
      error: { code, message },
    });

    const endpoint = context.endpoint;
    if (endpoint === undefined) {
      return failed("INTERNAL", "no model endpoint was resolved for this job", {
        toolCalls: 0,
        wallMs: Date.now() - startedAt,
      });
    }
    const client = new OpenAiClient({
      baseUrl: endpoint.baseUrl,
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
    });

    const toolset = buildToolset(this.commandAllowlist);

    const outcome = await runToolLoop({
      client,
      model: endpoint.model,
      systemPrompt: systemPrompt(context.workspaceDir, toolset),
      userPrompt: params.prompt,
      tools: toolset,
      budgets: params.budgets,
      // Recon passes no terminalTools: nothing short-circuits the loop.
      toolContext: { workspaceDir: context.workspaceDir },
      emit,
      signal: context.signal,
    });

    const stats: JobStats = outcome.stats;
    switch (outcome.kind) {
      case "content":
        // Plain content is the summary: the job is done. Capped so the
        // result always fits the transport body limit (MAX_SUMMARY_BYTES).
        return {
          jobId: context.jobId,
          type: this.type,
          status: "succeeded",
          summary: capSummary(outcome.finalContent),
          stats,
        };
      case "budget_exhausted":
        return failed("BUDGET_EXCEEDED", outcome.errorMessage, stats);
      case "endpoint_failure":
        return failed("INTERNAL", outcome.errorMessage, stats);
      case "aborted":
        return {
          jobId: context.jobId,
          type: this.type,
          status: "canceled",
          stats,
          error: { code: "CANCELED", message: "job canceled" },
        };
      case "terminal_call":
        // Unreachable: recon advertises no terminal tools. Fail loudly
        // rather than silently succeed if that ever changes.
        return failed(
          "INTERNAL",
          `unexpected terminal tool call: ${outcome.terminalCall.name}`,
          stats,
        );
    }
  }
}
