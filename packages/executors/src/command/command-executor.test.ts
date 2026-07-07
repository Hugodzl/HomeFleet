import { existsSync } from "node:fs";
import path from "node:path";
import {
  type CommandJobParams,
  CommandJobParamsSchema,
  type JobResult,
  JobResultSchema,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import type { ExecutionContext, ExecutorEventPayload } from "../executor.js";
import type { CommandAllowlist } from "../spawn.js";
import { makeTempDir, removeTempDir } from "../test-fixtures.js";
import { CommandExecutor } from "./command-executor.js";

const jobId = "0b294587-2342-4718-b6bb-2b3c837e2a9c";

const nodeAllowlist: CommandAllowlist = {
  node: { executable: process.execPath },
};

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function workspace(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

/** Parses through the schema so defaults (args, timeoutMs) apply. */
function params(overrides: Record<string, unknown>): CommandJobParams {
  return CommandJobParamsSchema.parse({
    type: "command",
    workspace: { repoId: "homefleet", headCommit: "0".repeat(40) },
    command: "node",
    ...overrides,
  });
}

interface Harness {
  context: ExecutionContext;
  events: ExecutorEventPayload[];
}

function harness(
  workspaceDir: string,
  overrides: Partial<ExecutionContext> = {},
): Harness {
  const events: ExecutorEventPayload[] = [];
  return {
    events,
    context: {
      jobId,
      workspaceDir,
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      ...overrides,
    },
  };
}

/** Every result must satisfy the schema's cross-field rules — the contract. */
function assertValid(result: JobResult): JobResult {
  return JobResultSchema.parse(result);
}

test("exit code 0 yields a succeeded result with the captured output", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const { context } = harness(cwd);
  const result = await executor.execute(
    params({
      args: ["-e", 'process.stdout.write("out");process.stderr.write("err")'],
    }),
    context,
  );
  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.jobId).toBe(jobId);
  expect(result.type).toBe("command");
  expect(result.output).toEqual({ stdout: "out", stderr: "err", exitCode: 0 });
  expect(result.error).toBeUndefined();
  expect(result.stats.toolCalls).toBe(0);
  expect(result.stats.wallMs).toBeGreaterThanOrEqual(0);
});

test("emits a start log event before running", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const { context, events } = harness(cwd);
  await executor.execute(params({ args: ["-e", ""] }), context);
  expect(events[0]).toEqual({
    type: "log",
    level: "info",
    message: expect.stringContaining("node"),
  });
});

test("a nonzero exit is a failed result that still carries the full output", async () => {
  // A failing test suite is the canonical case: the delegating side needs
  // stdout/stderr precisely when the command fails.
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const { context } = harness(cwd);
  const result = await executor.execute(
    params({
      args: [
        "-e",
        'process.stdout.write("3 tests failed");process.stderr.write("boom");process.exit(3)',
      ],
    }),
    context,
  );
  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error).toEqual({
    code: "INTERNAL",
    message: expect.stringContaining("3"),
    details: { exitCode: 3 },
  });
  expect(result.output).toEqual({
    stdout: "3 tests failed",
    stderr: "boom",
    exitCode: 3,
  });
});

test("a non-allowlisted command fails with COMMAND_NOT_ALLOWED and never spawns", async () => {
  const executor = new CommandExecutor({ allowlist: {} });
  const cwd = await workspace();
  const sentinel = path.join(cwd, "sentinel.txt");
  const { context } = harness(cwd);
  const result = await executor.execute(
    params({
      args: [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
      ],
    }),
    context,
  );
  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("COMMAND_NOT_ALLOWED");
  expect(result.output).toBeUndefined();
  expect(existsSync(sentinel)).toBe(false);
});

test("a missing workspace directory fails with WORKSPACE_UNAVAILABLE", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const { context } = harness(path.join(cwd, "not-materialized"));
  const result = await executor.execute(params({ args: ["-e", ""] }), context);
  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("WORKSPACE_UNAVAILABLE");
});

test("a timeout fails with TIMEOUT and a null exit code", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const { context } = harness(cwd);
  const result = await executor.execute(
    params({
      args: [
        "-e",
        'process.stdout.write("partial");setInterval(() => {}, 1000)',
      ],
      timeoutMs: 1000,
    }),
    context,
  );
  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error).toEqual({
    code: "TIMEOUT",
    message: expect.stringContaining("1000"),
    details: { timeoutMs: 1000 },
  });
  expect(result.output).toEqual({
    stdout: "partial",
    stderr: "",
    exitCode: null,
  });
}, 10_000);

test("cancellation yields a canceled result carrying a CANCELED error", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const controller = new AbortController();
  const { context } = harness(cwd, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const result = await executor.execute(
    params({ args: ["-e", "setInterval(() => {}, 1000)"] }),
    context,
  );
  assertValid(result);
  expect(result.status).toBe("canceled");
  expect(result.error?.code).toBe("CANCELED");
  expect(result.output?.exitCode).toBeNull();
});

test("a throwing emit does not change the job outcome", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const cwd = await workspace();
  const { context } = harness(cwd, {
    emit: () => {
      throw new Error("observability blew up");
    },
  });
  const result = await executor.execute(
    params({ args: ["-e", 'process.stdout.write("fine")'] }),
    context,
  );
  expect(result.status).toBe("succeeded");
  expect(result.output?.stdout).toBe("fine");
});

test("concurrent execute() calls do not interfere", async () => {
  const executor = new CommandExecutor({ allowlist: nodeAllowlist });
  const [cwdA, cwdB] = [await workspace(), await workspace()];
  const [a, b] = await Promise.all([
    executor.execute(
      params({ args: ["-e", 'process.stdout.write("A")'] }),
      harness(cwdA).context,
    ),
    executor.execute(
      params({ args: ["-e", 'process.stdout.write("B")'] }),
      harness(cwdB).context,
    ),
  ]);
  expect(a.output?.stdout).toBe("A");
  expect(b.output?.stdout).toBe("B");
});
