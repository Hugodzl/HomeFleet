/**
 * The no-LLM command executor: runs one allowlisted command in the job's
 * workspace over the safe-spawn core and encodes the outcome as a
 * JobResult.
 *
 * Status rule (locked for M8's "run the tests over there" demo): succeeded
 * means the process completed with exit code 0. A nonzero exit — a failing
 * test suite, say — is a FAILED result whose error carries the exit code
 * and whose output still ships the full stdout/stderr: the delegating side
 * needs them precisely when the command fails.
 */
import {
  type CommandJobParams,
  type JobResult,
  JobResultSchema,
} from "@homefleet/protocol";
import type { ExecutionContext, Executor } from "../executor.js";
import { type CommandAllowlist, safeSpawn } from "../spawn.js";

export interface CommandExecutorOptions {
  /** Which logical commands this worker will run, and how. */
  allowlist: CommandAllowlist;
}

export class CommandExecutor implements Executor<"command"> {
  readonly type = "command" as const;
  private readonly allowlist: CommandAllowlist;

  constructor(options: CommandExecutorOptions) {
    this.allowlist = options.allowlist;
  }

  async execute(
    params: CommandJobParams,
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

    emit({
      type: "log",
      level: "info",
      message: `running command "${params.command}" (${params.args.length} args)`,
    });

    const outcome = await safeSpawn({
      command: params.command,
      args: params.args,
      cwd: context.workspaceDir,
      timeoutMs: params.timeoutMs,
      signal: context.signal,
      allowlist: this.allowlist,
    });

    const base = {
      jobId: context.jobId,
      type: this.type,
      stats: { toolCalls: 0, wallMs: Date.now() - startedAt },
    };

    let result: JobResult;
    switch (outcome.kind) {
      case "completed":
        result =
          outcome.output.exitCode === 0
            ? { ...base, status: "succeeded", output: outcome.output }
            : {
                ...base,
                status: "failed",
                output: outcome.output,
                error: {
                  code: "INTERNAL",
                  message:
                    outcome.output.exitCode === null
                      ? "command was killed before exiting"
                      : `command exited with code ${outcome.output.exitCode}`,
                  details: { exitCode: outcome.output.exitCode },
                },
              };
        break;
      case "timeout":
        result = {
          ...base,
          status: "failed",
          output: outcome.output,
          error: {
            code: "TIMEOUT",
            message: `command timed out after ${params.timeoutMs}ms`,
            details: { timeoutMs: params.timeoutMs },
          },
        };
        break;
      case "canceled":
        result = {
          ...base,
          status: "canceled",
          output: outcome.output,
          error: { code: "CANCELED", message: "job canceled" },
        };
        break;
      case "refused":
        // Never spawned: no output to attach.
        result = { ...base, status: "failed", error: outcome.error };
        break;
    }
    // The schema's cross-field rules are the contract.
    return JobResultSchema.parse(result);
  }
}
