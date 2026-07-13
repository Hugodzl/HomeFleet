/**
 * The write-capable agent executor (v0.2 code-writing delegation, design:
 * docs/specs/2026-07-10-code-writing-delegation-design.md): the shared tool
 * loop (loop.ts) driving the write toolset plus a `finish_task` terminal
 * tool, followed by a caller-injected finalize step (worktree commit and
 * bundle bookkeeping — wired up by a later task) and an optional report-only
 * verify command.
 *
 * Policy owned here, mirroring what AgentExecutor owns for recon: the
 * context-window floor, the WRITE system prompt (never recon's read-only
 * one), summary capping, commit-message fallback and truncation, the
 * verifyCommand allowlist gate, and the ToolLoopOutcome → JobResult mapping.
 *
 * The failure taxonomy is unchanged: tool-level failures (sandbox and
 * git-admin refusals, unknown tools, unparseable arguments) return to the
 * model as error tool-results and the loop continues; budget exhaustion,
 * cancellation, and endpoint failures end the job WITHOUT finalize — no
 * half-finished work is ever committed (`docs/specs` outcome rules).
 */
import {
  type CommandOutput,
  type JobId,
  type JobResult,
  JobResultSchema,
  type JobStats,
  type VerifyCommand,
  type VerifyReport,
  type WriteArtifact,
  type WriteJobParams,
} from "@homefleet/protocol";
import { z } from "zod";
import type { ExecutionContext, Executor } from "../executor.js";
import { type CommandAllowlist, safeSpawn } from "../spawn.js";
import {
  type AgentEndpointOptions,
  capSummary,
  MIN_AGENT_CONTEXT_WINDOW,
} from "./agent-executor.js";
import { runToolLoop, type ToolLoopStats } from "./loop.js";
import { OpenAiClient } from "./openai-client.js";
import type { AgentTool } from "./tools.js";
import { buildToolset } from "./toolset.js";

/** The terminal tool a write job's model calls to declare the task done. */
export const FINISH_TASK_TOOL_NAME = "finish_task";

/**
 * Mirror of WriteArtifactSchema's commitMessage cap (UTF-16 code units).
 * Every commit message — model-supplied or fallback — is truncated to this
 * BEFORE finalize runs: an oversized one would otherwise fail result
 * validation AFTER the work is already committed. `JobResultSchema.parse`
 * in execute() is the backstop that keeps this mirror honest.
 */
export const MAX_COMMIT_MESSAGE_CHARS = 4096;

/** Characters kept from the END of the verify output (UTF-16 code units). */
export const VERIFY_OUTPUT_TAIL_CHARS = 8192;

/**
 * Floor for the verify command's timeout. The verify budget is the job's
 * REMAINING wall time, but the loop can finish with almost nothing left, and
 * killing a requested verify at ~0ms would make its report pure noise. One
 * second matches the minimum the budgets schema puts on maxWallMs itself; a
 * verify can therefore overshoot the job's wall budget by up to this much.
 */
export const MIN_VERIFY_TIMEOUT_MS = 1000;

const FinishTaskArgsSchema = z.object({
  commitMessage: z.string().optional(),
  summary: z.string(),
});

/**
 * finish_task as a full AgentTool, so it is advertised alongside the real
 * toolset. Deliberately NOT built with makeTool: the loop intercepts every
 * PARSED finish_task call before dispatch (terminalTools), and an
 * unparseable-JSON call is answered by dispatch's own JSON guard without
 * ever reaching execute — so reaching execute means the terminal
 * interception broke, and that must fail loudly as a programmer error, not
 * be swallowed into an error tool-result.
 */
const finishTaskTool: AgentTool = {
  name: FINISH_TASK_TOOL_NAME,
  definition: {
    type: "function",
    function: {
      name: FINISH_TASK_TOOL_NAME,
      description:
        "Declare the write task complete. Call this exactly once, after all " +
        "edits are applied, with a short summary of what changed and a " +
        "one-line commit message. Do not call it if nothing worth keeping " +
        "was changed.",
      parameters: {
        type: "object",
        properties: {
          commitMessage: {
            type: "string",
            description: "One-line commit message describing the change",
          },
          summary: {
            type: "string",
            description: "What was changed and why",
          },
        },
        required: ["summary"],
      },
    },
  },
  execute: () => {
    throw new Error(
      "finish_task.execute is unreachable: the loop must intercept terminal calls",
    );
  },
};

function writeSystemPrompt(
  workspaceDir: string,
  toolset: AgentTool[],
  pathHints: string[] | undefined,
): string {
  const toolNames = toolset.map((tool) => tool.name).join(", ");
  const hints =
    pathHints !== undefined && pathHints.length > 0
      ? ` Start with these paths: ${pathHints.join(", ")}.`
      : "";
  return (
    "You are a code-writing agent. Make the requested change to the " +
    `repository checked out at ${workspaceDir} using the available tools ` +
    `(${toolNames}), with workspace-relative paths.${hints} Read the ` +
    "relevant files first, then apply changes with edit_file (exact-match " +
    "replace) or write_file (create or replace a whole file). When the " +
    "change is complete, call finish_task with a short summary and a " +
    "one-line commit message describing the change. If there is nothing " +
    "worth keeping, do NOT call finish_task — reply with a plain-text " +
    "explanation instead and the job ends without a commit."
  );
}

/**
 * Truncates a commit message to {@link MAX_COMMIT_MESSAGE_CHARS}. A plain
 * slice rather than truncateChars: the schema counts UTF-16 code units, and
 * an appended ellipsis would push a message cut exactly at the cap PAST it.
 * A trailing lone high surrogate from the cut is dropped so the message
 * stays a well-formed string.
 */
function capCommitMessage(message: string): string {
  if (message.length <= MAX_COMMIT_MESSAGE_CHARS) {
    return message;
  }
  let cut = message.slice(0, MAX_COMMIT_MESSAGE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

/**
 * Fallback commit message when the model supplied none (or a blank one):
 * the first line of the trimmed instructions (design doc §2, "Commit").
 * Instructions that are pure whitespace — the params schema only requires
 * length ≥ 1 — get a constant, since WriteArtifactSchema requires a
 * non-empty commitMessage.
 */
function fallbackCommitMessage(instructions: string): string {
  const firstLine = instructions.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine === "" ? "homefleet write job" : firstLine;
}

/**
 * safeSpawn captures the two streams separately, so true interleaving is
 * unavailable; stderr (the diagnostic stream) goes first, stdout after.
 * The TAIL of the combination is what ships — test runners put their
 * failure summaries at the end.
 */
function combineOutput(output: CommandOutput): string {
  return [output.stderr, output.stdout]
    .filter((stream) => stream !== "")
    .join("\n");
}

/**
 * Keeps the LAST `maxChars` code units (including a leading ellipsis marker
 * when cut, inside the budget); a leading lone low surrogate exposed by the
 * cut is dropped so the tail stays a well-formed string.
 */
function tailChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let tail = text.slice(text.length - (maxChars - 1));
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) {
    tail = tail.slice(1);
  }
  return `…${tail}`;
}

/**
 * The injected finalize step: stages and commits the workspace's changes
 * under `commitMessage` and returns the resulting artifact, or `null` for a
 * clean tree (the model declared done without changing anything worth
 * keeping). The real implementation (ephemeral worktree commit, branch and
 * bundle bookkeeping) arrives with the workspace tasks; injecting it keeps
 * this executor free of git plumbing. A rejection here fails the job with
 * INTERNAL — the work may be committed, but it cannot be delivered.
 */
export type FinalizeWriteFn = (input: {
  jobId: JobId;
  workspaceDir: string;
  commitMessage: string;
  signal: AbortSignal;
}) => Promise<WriteArtifact | null>;

export interface WriteExecutorOptions {
  endpoint: AgentEndpointOptions;
  /**
   * Allowlist for the run_command tool AND the gate `verifyCommand.name`
   * must pass; absent or empty disables both.
   */
  commandAllowlist?: CommandAllowlist;
  finalize: FinalizeWriteFn;
}

export class WriteExecutor implements Executor<"write"> {
  readonly type = "write" as const;
  private readonly endpoint: AgentEndpointOptions;
  private readonly commandAllowlist: CommandAllowlist;
  private readonly finalize: FinalizeWriteFn;
  private readonly client: OpenAiClient;

  constructor(options: WriteExecutorOptions) {
    this.endpoint = options.endpoint;
    this.commandAllowlist = options.commandAllowlist ?? {};
    this.finalize = options.finalize;
    this.client = new OpenAiClient({
      baseUrl: options.endpoint.baseUrl,
      ...(options.endpoint.apiKey !== undefined
        ? { apiKey: options.endpoint.apiKey }
        : {}),
    });
  }

  async execute(
    params: WriteJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    // The schema's cross-field rules are the contract — including the
    // present-or-null artifact requirement on succeeded write results.
    return JobResultSchema.parse(await this.run(params, context));
  }

  private async run(
    params: WriteJobParams,
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
      code:
        | "INVALID_REQUEST"
        | "COMMAND_NOT_ALLOWED"
        | "BUDGET_EXCEEDED"
        | "INTERNAL",
      message: string,
      stats: JobStats,
    ): JobResult => ({
      jobId: context.jobId,
      type: this.type,
      status: "failed",
      stats,
      error: { code, message },
    });

    // verifyCommand gate FIRST — before any model traffic. Object.hasOwn for
    // the same reason as safeSpawn: the name is job-controlled and the
    // allowlist is a plain object, so prototype keys must never match. The
    // same check runs again inside safeSpawn when verify executes; this one
    // exists so a doomed job never burns a model conversation first.
    if (
      params.verifyCommand !== undefined &&
      !Object.hasOwn(this.commandAllowlist, params.verifyCommand.name)
    ) {
      return failed(
        "COMMAND_NOT_ALLOWED",
        `verifyCommand "${params.verifyCommand.name}" is not on this worker's allowlist`,
        { toolCalls: 0, wallMs: Date.now() - startedAt },
      );
    }

    // Same floor as recon (see MIN_AGENT_CONTEXT_WINDOW's rationale); the
    // same non-guarantee too — it does not bound message-history growth.
    if (this.endpoint.contextWindow < MIN_AGENT_CONTEXT_WINDOW) {
      return failed(
        "INVALID_REQUEST",
        `endpoint contextWindow ${this.endpoint.contextWindow} is below the ` +
          `required minimum of ${MIN_AGENT_CONTEXT_WINDOW}: model servers ` +
          "commonly default to 4k contexts, which silently break agentic " +
          "tool use; raise the served context window instead.",
        { toolCalls: 0, wallMs: Date.now() - startedAt },
      );
    }

    const toolset = [
      ...buildToolset(this.commandAllowlist, { includeWriteTools: true }),
      finishTaskTool,
    ];

    const outcome = await runToolLoop({
      client: this.client,
      model: this.endpoint.model,
      systemPrompt: writeSystemPrompt(
        context.workspaceDir,
        toolset,
        params.pathHints,
      ),
      userPrompt: params.instructions,
      tools: toolset,
      budgets: params.budgets,
      terminalTools: [FINISH_TASK_TOOL_NAME],
      toolContext: { workspaceDir: context.workspaceDir },
      emit,
      signal: context.signal,
    });

    // Unlike recon, wallMs is recomputed at result construction so finalize
    // and verify time is accounted for; tool/token counts stay the loop's.
    const stats = (): JobStats => ({
      ...outcome.stats,
      wallMs: Date.now() - startedAt,
    });

    switch (outcome.kind) {
      case "terminal_call": {
        // Only finish_task is terminal, and the loop hands over its args
        // JSON-parsed but unvalidated. Invalid args cannot go back to the
        // model — the conversation is already over — so they fail the job
        // before any commit happens.
        const parsed = FinishTaskArgsSchema.safeParse(
          outcome.terminalCall.args,
        );
        if (!parsed.success) {
          return failed(
            "INTERNAL",
            `the model called finish_task with invalid arguments: ${parsed.error.message}`,
            stats(),
          );
        }
        return this.finalizeAndVerify(params, context, {
          summary: capSummary(parsed.data.summary),
          modelCommitMessage: parsed.data.commitMessage,
          loopStats: outcome.stats,
          startedAt,
        });
      }
      case "content":
        // The model declared done in prose instead of calling finish_task:
        // the content is the summary and the commit message falls back to
        // the instructions. finalize still decides whether anything was
        // actually changed (null = clean tree).
        return this.finalizeAndVerify(params, context, {
          summary: capSummary(outcome.finalContent),
          modelCommitMessage: undefined,
          loopStats: outcome.stats,
          startedAt,
        });
      case "budget_exhausted":
        return failed("BUDGET_EXCEEDED", outcome.errorMessage, stats());
      case "endpoint_failure":
        return failed("INTERNAL", outcome.errorMessage, stats());
      case "aborted":
        return {
          jobId: context.jobId,
          type: this.type,
          status: "canceled",
          stats: stats(),
          error: { code: "CANCELED", message: "job canceled" },
        };
    }
  }

  /**
   * The declared-done path: finalize (commit), then the optional verify —
   * strictly in that order, so verify observes the committed state. A
   * throwing finalize fails the job (the Executor contract still resolves)
   * and skips verify; a failing VERIFY never fails the job — report-only.
   */
  private async finalizeAndVerify(
    params: WriteJobParams,
    context: ExecutionContext,
    input: {
      summary: string;
      modelCommitMessage: string | undefined;
      loopStats: ToolLoopStats;
      startedAt: number;
    },
  ): Promise<JobResult> {
    const stats = (): JobStats => ({
      ...input.loopStats,
      wallMs: Date.now() - input.startedAt,
    });
    // A model-supplied message that is blank would fail the artifact schema
    // (min 1), so blank falls back just like absent.
    const commitMessage = capCommitMessage(
      input.modelCommitMessage !== undefined &&
        input.modelCommitMessage.trim() !== ""
        ? input.modelCommitMessage
        : fallbackCommitMessage(params.instructions),
    );

    let artifact: WriteArtifact | null;
    try {
      artifact = await this.finalize({
        jobId: context.jobId,
        workspaceDir: context.workspaceDir,
        commitMessage,
        signal: context.signal,
      });
    } catch (error) {
      return {
        jobId: context.jobId,
        type: this.type,
        status: "failed",
        stats: stats(),
        error: {
          code: "INTERNAL",
          message: `finalize failed after the model declared done: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }

    let verify: VerifyReport | undefined;
    if (params.verifyCommand !== undefined) {
      verify = await this.runVerify(
        params.verifyCommand,
        params.budgets.maxWallMs,
        input.startedAt,
        context,
      );
    }

    return {
      jobId: context.jobId,
      type: this.type,
      status: "succeeded",
      summary: input.summary,
      stats: stats(),
      // Present-or-null is the wire contract on succeeded writes: an absent
      // artifact would be indistinguishable from "no changes".
      artifact,
      ...(verify !== undefined ? { verify } : {}),
    };
  }

  private async runVerify(
    verifyCommand: VerifyCommand,
    maxWallMs: number,
    startedAt: number,
    context: ExecutionContext,
  ): Promise<VerifyReport> {
    const remainingMs = maxWallMs - (Date.now() - startedAt);
    const outcome = await safeSpawn({
      command: verifyCommand.name,
      args: verifyCommand.args,
      cwd: context.workspaceDir,
      timeoutMs: Math.max(MIN_VERIFY_TIMEOUT_MS, remainingMs),
      signal: context.signal,
      allowlist: this.commandAllowlist,
    });
    if (outcome.kind === "refused") {
      // The upfront allowlist gate already passed, so this is workspace loss
      // or a spawn failure. Report-only, like every verify outcome.
      return {
        name: verifyCommand.name,
        args: verifyCommand.args,
        exitCode: null,
        outputTail: `verify did not run: ${outcome.error.message}`,
      };
    }
    return {
      name: verifyCommand.name,
      args: verifyCommand.args,
      // null when our kill path (timeout or cancellation) took the process.
      exitCode: outcome.output.exitCode,
      outputTail: tailChars(
        combineOutput(outcome.output),
        VERIFY_OUTPUT_TAIL_CHARS,
      ),
    };
  }
}
