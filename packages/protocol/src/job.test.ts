import { expect, test } from "vitest";
import {
  CommandJobParamsSchema,
  CommandOutputSchema,
  isTerminalJobStatus,
  JobBudgetsSchema,
  JobIdSchema,
  type JobParams,
  JobParamsSchema,
  JobResultSchema,
  JobStatsSchema,
  JobStatusSchema,
  JobTypeSchema,
  ReconJobParamsSchema,
  TERMINAL_JOB_STATUSES,
  TerminalJobStatusSchema,
  WorkspaceRefSchema,
} from "./job.js";
import { validJobId, validJobResult, validWorkspace } from "./test-fixtures.js";

test("JobIdSchema accepts a UUID and rejects non-UUIDs", () => {
  expect(JobIdSchema.parse(validJobId)).toBe(validJobId);
  expect(JobIdSchema.safeParse("not-a-uuid").success).toBe(false);
  expect(JobIdSchema.safeParse("").success).toBe(false);
});

test("JobIdSchema rejects uppercase UUIDs (canonical form is lowercase)", () => {
  expect(JobIdSchema.safeParse(validJobId.toUpperCase()).success).toBe(false);
});

test("JobIdSchema enforces the RFC 4122 version and variant nibbles", () => {
  // Nil UUID: version nibble 0 — not a valid RFC 4122 UUID.
  expect(
    JobIdSchema.safeParse("00000000-0000-0000-0000-000000000000").success,
  ).toBe(false);
  // Version nibble 9 does not exist.
  expect(
    JobIdSchema.safeParse("0b294587-2342-9718-b6bb-2b3c837e2a9c").success,
  ).toBe(false);
  // Variant nibble must be 8, 9, a, or b.
  expect(
    JobIdSchema.safeParse("0b294587-2342-4718-c6bb-2b3c837e2a9c").success,
  ).toBe(false);
  expect(
    JobIdSchema.safeParse("0b294587-2342-4718-76bb-2b3c837e2a9c").success,
  ).toBe(false);
});

test("JobIdSchema accepts crypto.randomUUID() output", () => {
  for (let i = 0; i < 32; i += 1) {
    const id = crypto.randomUUID();
    expect(JobIdSchema.parse(id)).toBe(id);
  }
});

test("JobTypeSchema accepts defined job types and rejects others", () => {
  expect(JobTypeSchema.parse("recon")).toBe("recon");
  expect(JobTypeSchema.parse("command")).toBe("command");
  expect(JobTypeSchema.safeParse("shell").success).toBe(false);
});

test("WorkspaceRefSchema round-trips a valid reference", () => {
  expect(WorkspaceRefSchema.parse(validWorkspace)).toEqual(validWorkspace);
});

test("WorkspaceRefSchema rejects a malformed headCommit", () => {
  expect(
    WorkspaceRefSchema.safeParse({ ...validWorkspace, headCommit: "abc123" })
      .success,
  ).toBe(false);
  expect(
    WorkspaceRefSchema.safeParse({
      ...validWorkspace,
      headCommit: validWorkspace.headCommit.toUpperCase(),
    }).success,
  ).toBe(false);
});

test("JobBudgetsSchema applies defaults for omitted fields", () => {
  expect(JobBudgetsSchema.parse({})).toEqual({
    maxToolCalls: 50,
    maxWallMs: 600000,
  });
  expect(JobBudgetsSchema.parse({ maxToolCalls: 10 })).toEqual({
    maxToolCalls: 10,
    maxWallMs: 600000,
  });
});

test("JobBudgetsSchema enforces bounds", () => {
  expect(JobBudgetsSchema.safeParse({ maxToolCalls: 0 }).success).toBe(false);
  expect(JobBudgetsSchema.safeParse({ maxToolCalls: 201 }).success).toBe(false);
  expect(JobBudgetsSchema.safeParse({ maxWallMs: 999 }).success).toBe(false);
  expect(JobBudgetsSchema.safeParse({ maxWallMs: 3600001 }).success).toBe(
    false,
  );
});

test("JobBudgetsSchema accepts boundary values", () => {
  const budgets = { maxToolCalls: 200, maxWallMs: 3600000 };
  expect(JobBudgetsSchema.parse(budgets)).toEqual(budgets);
  expect(JobBudgetsSchema.parse({ maxToolCalls: 1, maxWallMs: 1000 })).toEqual({
    maxToolCalls: 1,
    maxWallMs: 1000,
  });
});

test("ReconJobParamsSchema applies budget defaults when budgets is omitted", () => {
  const parsed = ReconJobParamsSchema.parse({
    type: "recon",
    workspace: validWorkspace,
    prompt: "Summarize the repo layout.",
  });
  expect(parsed.budgets).toEqual({ maxToolCalls: 50, maxWallMs: 600000 });
  expect(parsed.model).toBeUndefined();
});

test("ReconJobParamsSchema keeps an explicit model and budgets", () => {
  const params = {
    type: "recon",
    workspace: validWorkspace,
    prompt: "List the test frameworks in use.",
    model: "qwen3.5-9b",
    budgets: { maxToolCalls: 20, maxWallMs: 120000 },
  };
  expect(ReconJobParamsSchema.parse(params)).toEqual(params);
});

test("ReconJobParamsSchema rejects an empty or oversized prompt", () => {
  const base = { type: "recon", workspace: validWorkspace };
  expect(ReconJobParamsSchema.safeParse({ ...base, prompt: "" }).success).toBe(
    false,
  );
  expect(
    ReconJobParamsSchema.safeParse({ ...base, prompt: "x".repeat(16385) })
      .success,
  ).toBe(false);
});

test("ReconJobParamsSchema accepts a prompt of exactly 16384 chars", () => {
  const parsed = ReconJobParamsSchema.parse({
    type: "recon",
    workspace: validWorkspace,
    prompt: "x".repeat(16384),
  });
  expect(parsed.prompt).toHaveLength(16384);
});

test("ReconJobParamsSchema strips unknown fields on parse", () => {
  const parsed = ReconJobParamsSchema.parse({
    type: "recon",
    workspace: validWorkspace,
    prompt: "Summarize.",
    futureField: "ignored",
  });
  expect(parsed).not.toHaveProperty("futureField");
});

test("CommandJobParamsSchema applies defaults for args and timeoutMs", () => {
  const parsed = CommandJobParamsSchema.parse({
    type: "command",
    workspace: validWorkspace,
    command: "pnpm",
  });
  expect(parsed.args).toEqual([]);
  expect(parsed.timeoutMs).toBe(600000);
});

test("CommandJobParamsSchema enforces timeoutMs bounds", () => {
  const base = { type: "command", workspace: validWorkspace, command: "pnpm" };
  expect(
    CommandJobParamsSchema.safeParse({ ...base, timeoutMs: 999 }).success,
  ).toBe(false);
  expect(
    CommandJobParamsSchema.safeParse({ ...base, timeoutMs: 3600001 }).success,
  ).toBe(false);
});

test("CommandJobParamsSchema accepts timeoutMs boundary values", () => {
  const base = { type: "command", workspace: validWorkspace, command: "pnpm" };
  expect(
    CommandJobParamsSchema.parse({ ...base, timeoutMs: 1000 }).timeoutMs,
  ).toBe(1000);
  expect(
    CommandJobParamsSchema.parse({ ...base, timeoutMs: 3600000 }).timeoutMs,
  ).toBe(3600000);
});

test("JobParamsSchema parses both variants through the discriminated union", () => {
  const recon = JobParamsSchema.parse({
    type: "recon",
    workspace: validWorkspace,
    prompt: "What does this repo do?",
  });
  expect(recon.type).toBe("recon");
  const command = JobParamsSchema.parse({
    type: "command",
    workspace: validWorkspace,
    command: "pnpm",
    args: ["test"],
  });
  expect(command.type).toBe("command");
});

test("JobParamsSchema rejects an unknown job type", () => {
  expect(
    JobParamsSchema.safeParse({
      type: "shell",
      workspace: validWorkspace,
      command: "rm",
    }).success,
  ).toBe(false);
});

test("JobParams narrows through a switch on type", () => {
  const describe = (params: JobParams): string => {
    switch (params.type) {
      case "recon":
        return params.prompt;
      case "command":
        return [params.command, ...params.args].join(" ");
      default: {
        const exhaustive: never = params;
        return exhaustive;
      }
    }
  };
  expect(
    describe(
      JobParamsSchema.parse({
        type: "command",
        workspace: validWorkspace,
        command: "pnpm",
        args: ["test"],
      }),
    ),
  ).toBe("pnpm test");
});

test("JobStatusSchema accepts all lifecycle states and rejects others", () => {
  for (const status of [
    "queued",
    "running",
    "succeeded",
    "failed",
    "canceled",
  ]) {
    expect(JobStatusSchema.parse(status)).toBe(status);
  }
  expect(JobStatusSchema.safeParse("cancelled").success).toBe(false);
});

test("TerminalJobStatusSchema accepts only terminal states", () => {
  for (const status of TERMINAL_JOB_STATUSES) {
    expect(TerminalJobStatusSchema.parse(status)).toBe(status);
  }
  expect(TerminalJobStatusSchema.safeParse("queued").success).toBe(false);
  expect(TerminalJobStatusSchema.safeParse("running").success).toBe(false);
});

test("isTerminalJobStatus narrows terminal from non-terminal statuses", () => {
  expect(isTerminalJobStatus("succeeded")).toBe(true);
  expect(isTerminalJobStatus("failed")).toBe(true);
  expect(isTerminalJobStatus("canceled")).toBe(true);
  expect(isTerminalJobStatus("queued")).toBe(false);
  expect(isTerminalJobStatus("running")).toBe(false);
});

test("CommandOutputSchema round-trips, including null exitCode", () => {
  const clean = { stdout: "ok\n", stderr: "", exitCode: 0 };
  const killed = { stdout: "", stderr: "timed out", exitCode: null };
  expect(CommandOutputSchema.parse(clean)).toEqual(clean);
  expect(CommandOutputSchema.parse(killed)).toEqual(killed);
});

test("CommandOutputSchema rejects a missing exitCode", () => {
  expect(
    CommandOutputSchema.safeParse({ stdout: "", stderr: "" }).success,
  ).toBe(false);
});

test("CommandOutputSchema accepts negative exit codes but rejects non-integers", () => {
  const signaled = { stdout: "", stderr: "", exitCode: -1 };
  expect(CommandOutputSchema.parse(signaled)).toEqual(signaled);
  expect(
    CommandOutputSchema.safeParse({ stdout: "", stderr: "", exitCode: 1.5 })
      .success,
  ).toBe(false);
});

test("JobStatsSchema round-trips and rejects negative counters", () => {
  const stats = { toolCalls: 3, wallMs: 1200 };
  expect(JobStatsSchema.parse(stats)).toEqual(stats);
  expect(JobStatsSchema.safeParse({ toolCalls: -1, wallMs: 0 }).success).toBe(
    false,
  );
  expect(JobStatsSchema.safeParse({ toolCalls: 0, wallMs: -5 }).success).toBe(
    false,
  );
});

test("JobStatsSchema rejects negative token counts", () => {
  expect(
    JobStatsSchema.safeParse({ toolCalls: 0, wallMs: 0, promptTokens: -1 })
      .success,
  ).toBe(false);
  expect(
    JobStatsSchema.safeParse({ toolCalls: 0, wallMs: 0, completionTokens: -1 })
      .success,
  ).toBe(false);
});

test("JobResultSchema round-trips a terminal result", () => {
  expect(JobResultSchema.parse(validJobResult)).toEqual(validJobResult);
});

test("JobResultSchema accepts failed results carrying an HfpError", () => {
  const failed = {
    jobId: validJobId,
    type: "command",
    status: "failed",
    stats: { toolCalls: 0, wallMs: 10 },
    error: { code: "WORKSPACE_UNAVAILABLE", message: "repo not on allowlist" },
  };
  expect(JobResultSchema.parse(failed)).toEqual(failed);
});

test("JobResultSchema rejects non-terminal statuses", () => {
  expect(
    JobResultSchema.safeParse({ ...validJobResult, status: "queued" }).success,
  ).toBe(false);
  expect(
    JobResultSchema.safeParse({ ...validJobResult, status: "running" }).success,
  ).toBe(false);
});

test("JobResultSchema requires a job type", () => {
  const { type: _type, ...withoutType } = validJobResult;
  expect(JobResultSchema.safeParse(withoutType).success).toBe(false);
  expect(
    JobResultSchema.safeParse({ ...validJobResult, type: "shell" }).success,
  ).toBe(false);
});

test("JobResultSchema requires error when status is failed", () => {
  expect(
    JobResultSchema.safeParse({ ...validJobResult, status: "failed" }).success,
  ).toBe(false);
});

test("JobResultSchema forbids error when status is succeeded", () => {
  expect(
    JobResultSchema.safeParse({
      ...validJobResult,
      status: "succeeded",
      error: { code: "INTERNAL", message: "should not be here" },
    }).success,
  ).toBe(false);
});

test("JobResultSchema allows canceled results with or without an error", () => {
  const bare = {
    jobId: validJobId,
    type: "recon",
    status: "canceled",
    stats: { toolCalls: 2, wallMs: 500 },
  };
  const withError = {
    ...bare,
    error: { code: "CANCELED", message: "canceled by delegator" },
  };
  expect(JobResultSchema.parse(bare)).toEqual(bare);
  expect(JobResultSchema.parse(withError)).toEqual(withError);
});
