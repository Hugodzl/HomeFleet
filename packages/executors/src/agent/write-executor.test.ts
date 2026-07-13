/**
 * Tests for the write-capable agent executor (v0.2 code-writing delegation):
 * the finish_task terminal protocol, finalize/verify sequencing, and the
 * ToolLoopOutcome → JobResult mapping. The mock endpoint scripts the model;
 * the workspace, tools, and verify processes are all real — finalize is the
 * ONE injected fake here (its real implementation, git worktree commit and
 * bundle-out, arrives in a later task).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type JobResult,
  JobResultSchema,
  jobId12,
  type WriteArtifact,
  type WriteJobParams,
  WriteJobParamsSchema,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import type { ExecutionContext, ExecutorEventPayload } from "../executor.js";
import type { CommandAllowlist } from "../spawn.js";
import {
  MockOpenAiEndpoint,
  type MockScriptEntry,
  makeTempDir,
  removeTempDir,
} from "../test-fixtures.js";
import {
  MAX_SUMMARY_BYTES,
  MIN_AGENT_CONTEXT_WINDOW,
  SUMMARY_TRUNCATION_MARKER,
} from "./agent-executor.js";
import {
  type FinalizeWriteFn,
  MAX_COMMIT_MESSAGE_CHARS,
  WriteExecutor,
} from "./write-executor.js";

const jobId = "0b294587-2342-4718-b6bb-2b3c837e2a9c";

const nodeAllowlist: CommandAllowlist = {
  node: { executable: process.execPath },
};

const tempDirs: string[] = [];
const endpoints: MockOpenAiEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) {
    await endpoint.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function makeWorkspace(): Promise<string> {
  const ws = await makeTempDir();
  tempDirs.push(ws);
  await writeFile(path.join(ws, "README.md"), "# HomeFleet\nTODO: docs\n");
  return ws;
}

async function startEndpoint(
  script: MockScriptEntry[],
): Promise<MockOpenAiEndpoint> {
  const endpoint = await MockOpenAiEndpoint.start(script);
  endpoints.push(endpoint);
  return endpoint;
}

function makeArtifact(commitMessage: string): WriteArtifact {
  return {
    branchName: `homefleet/${jobId12(jobId)}`,
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    diffStat: { filesChanged: 1, insertions: 2, deletions: 0 },
    commitMessage,
  };
}

interface FinalizeInput {
  jobId: string;
  workspaceDir: string;
  commitMessage: string;
  signal: AbortSignal;
}

/**
 * Recording fake for the injected finalize step. The default implementation
 * echoes the received commitMessage into a canned artifact, so an executor
 * that failed to truncate an oversized message would blow up the result's
 * schema validation (WriteArtifactSchema caps commitMessage).
 */
function fakeFinalize(
  impl?: (input: FinalizeInput) => Promise<WriteArtifact | null>,
): { calls: FinalizeInput[]; fn: FinalizeWriteFn } {
  const calls: FinalizeInput[] = [];
  const fn: FinalizeWriteFn = async (input) => {
    calls.push(input);
    return impl !== undefined ? impl(input) : makeArtifact(input.commitMessage);
  };
  return { calls, fn };
}

function makeExecutor(
  endpoint: MockOpenAiEndpoint,
  finalize: FinalizeWriteFn,
  overrides: {
    contextWindow?: number;
    commandAllowlist?: CommandAllowlist;
  } = {},
): WriteExecutor {
  return new WriteExecutor({
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: overrides.contextWindow ?? 32_768,
    },
    ...(overrides.commandAllowlist !== undefined
      ? { commandAllowlist: overrides.commandAllowlist }
      : {}),
    finalize,
  });
}

/** Parses through the schema so budget defaults apply. */
function params(overrides: Record<string, unknown> = {}): WriteJobParams {
  return WriteJobParamsSchema.parse({
    type: "write",
    workspace: { repoId: "homefleet", headCommit: "0".repeat(40) },
    instructions: "Add a friendly greeting to the README.",
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

interface RequestBody {
  model: string;
  messages: Record<string, unknown>[];
  tools?: { function: { name: string } }[];
}

function body(endpoint: MockOpenAiEndpoint, index: number): RequestBody {
  const request = endpoint.requests[index];
  if (request === undefined) {
    throw new Error(`no request recorded at index ${index}`);
  }
  return request.body as RequestBody;
}

// ---------------------------------------------------------------------------
// 1. verifyCommand allowlist gate
// ---------------------------------------------------------------------------

test("an unknown verifyCommand name fails with COMMAND_NOT_ALLOWED before any model call", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "never" }]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn, {
    commandAllowlist: nodeAllowlist,
  });

  const result = await executor.execute(
    params({ verifyCommand: { name: "pnpm", args: ["test"] } }),
    harness(ws).context,
  );

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("COMMAND_NOT_ALLOWED");
  expect(result.error?.message).toContain("pnpm");
  // Refused before any model traffic, and nothing was ever committed.
  expect(endpoint.requests).toHaveLength(0);
  expect(finalize.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 2. toolset + finish_task terminal protocol
// ---------------------------------------------------------------------------

test("the model is offered the write toolset plus finish_task", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "a" },
    { kind: "content", content: "b" },
  ]);
  const withoutCommands = makeExecutor(endpoint, fakeFinalize().fn);
  await withoutCommands.execute(params(), harness(ws).context);
  const withCommands = makeExecutor(endpoint, fakeFinalize().fn, {
    commandAllowlist: nodeAllowlist,
  });
  await withCommands.execute(params(), harness(ws).context);

  const names = (index: number): string[] =>
    (body(endpoint, index).tools ?? []).map((tool) => tool.function.name);
  expect(names(0)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "finish_task",
  ]);
  expect(names(1)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "run_command",
    "finish_task",
  ]);
});

test("happy path: a real write_file edit, then finish_task drives finalize", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: {
            path: "src/hello.ts",
            content: "export const hi = 1;\n",
          },
        },
      ],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: {
            commitMessage: "Add hello module",
            summary: "Added src/hello.ts with a hi constant.",
          },
        },
      ],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);
  const { context, events } = harness(ws);

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.summary).toBe("Added src/hello.ts with a hi constant.");
  expect(result.artifact).toMatchObject({ commitMessage: "Add hello module" });
  expect(result.verify).toBeUndefined();
  // finish_task is intercepted before execute and consumes no budget.
  expect(result.stats.toolCalls).toBe(1);

  // The write tool really ran in the real workspace.
  await expect(
    readFile(path.join(ws, "src", "hello.ts"), "utf8"),
  ).resolves.toBe("export const hi = 1;\n");

  expect(finalize.calls).toHaveLength(1);
  expect(finalize.calls[0]).toMatchObject({
    jobId,
    workspaceDir: ws,
    commitMessage: "Add hello module",
  });
  expect(finalize.calls[0]?.signal).toBeInstanceOf(AbortSignal);

  // Only the write_file call produced tool events; finish_task produced none.
  expect(events.map((event) => event.type)).toEqual([
    "tool_call",
    "tool_result",
  ]);
  expect(events[0]).toMatchObject({ type: "tool_call", name: "write_file" });
});

test("a finish_task call with unparseable JSON args falls through as an error tool-result and the loop continues", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "finish_task", argumentsRaw: "{not json" }],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: { commitMessage: "Recovered", summary: "second attempt" },
        },
      ],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);
  const { context, events } = harness(ws);

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.summary).toBe("second attempt");
  // Finish fired exactly once — the malformed call never reached finalize...
  expect(finalize.calls).toHaveLength(1);
  expect(finalize.calls[0]?.commitMessage).toBe("Recovered");
  // ...but it WAS billed as a normal (failed) tool dispatch.
  expect(result.stats.toolCalls).toBe(1);
  const toolResult = events.find((event) => event.type === "tool_result");
  expect(toolResult).toMatchObject({
    name: "finish_task",
    isError: true,
    resultSummary: expect.stringContaining("not valid JSON"),
  });
  // The loop continued: the error went back to the model, which retried.
  expect(endpoint.requests).toHaveLength(2);
  expect(JSON.stringify(body(endpoint, 1).messages)).toContain(
    "not valid JSON",
  );
});

test("finish_task args that are valid JSON but fail the schema fail the job with INTERNAL", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      // summary is required; the loop has already ended the conversation, so
      // there is no way to hand the model an error and continue.
      toolCalls: [{ name: "finish_task", arguments: { commitMessage: 42 } }],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);

  const result = await executor.execute(params(), harness(ws).context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
  expect(result.error?.message).toContain("finish_task");
  expect(finalize.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 3. system prompt
// ---------------------------------------------------------------------------

test("the system prompt is write-specific and states the finish_task protocol", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "nothing to do" },
  ]);
  const executor = makeExecutor(endpoint, fakeFinalize().fn);

  await executor.execute(
    params({ instructions: "Rename the greeting function." }),
    harness(ws).context,
  );

  const first = body(endpoint, 0);
  expect(first.model).toBe("default-model");
  expect(first.messages[0]?.role).toBe("system");
  const system = String(first.messages[0]?.content);
  expect(system).toContain(ws);
  // Never recon's read-only prompt.
  expect(system).not.toMatch(/read-?only/i);
  expect(system).toContain("finish_task");
  expect(system).toContain("edit_file");
  expect(system).toContain("write_file");
  expect(system).toContain("commit message");
  expect(system).not.toContain("Start with these paths");
  expect(first.messages[1]).toEqual({
    role: "user",
    content: "Rename the greeting function.",
  });
});

test("pathHints are woven into the system prompt", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "ok" }]);
  const executor = makeExecutor(endpoint, fakeFinalize().fn);

  await executor.execute(
    params({ pathHints: ["src/index.ts", "README.md"] }),
    harness(ws).context,
  );

  const system = String(body(endpoint, 0).messages[0]?.content);
  expect(system).toContain("Start with these paths");
  expect(system).toContain("src/index.ts");
  expect(system).toContain("README.md");
});

// ---------------------------------------------------------------------------
// 4. completion mapping
// ---------------------------------------------------------------------------

test("bare content completes the job: content is the summary, commit message falls back to the instructions' first line", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "Refactored as requested." },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);

  const result = await executor.execute(
    params({
      instructions: "Refactor the greeting module.\nKeep the API stable.",
    }),
    harness(ws).context,
  );

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.summary).toBe("Refactored as requested.");
  expect(finalize.calls).toHaveLength(1);
  expect(finalize.calls[0]?.commitMessage).toBe(
    "Refactor the greeting module.",
  );
  expect(result.artifact).not.toBeNull();
});

test("a fallback commit message over the artifact cap reaches finalize truncated to exactly the cap", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "done" }]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);

  // First line of the instructions is longer than the schema allows; an
  // untruncated pass-through would fail result validation AFTER the work
  // was committed (the fake echoes it into the artifact).
  const result = await executor.execute(
    params({ instructions: "a".repeat(MAX_COMMIT_MESSAGE_CHARS + 1000) }),
    harness(ws).context,
  );

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(finalize.calls[0]?.commitMessage).toBe(
    "a".repeat(MAX_COMMIT_MESSAGE_CHARS),
  );
});

test("a model-supplied commit message over the artifact cap is truncated too", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: {
            commitMessage: "b".repeat(MAX_COMMIT_MESSAGE_CHARS + 500),
            summary: "done",
          },
        },
      ],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);

  const result = await executor.execute(params(), harness(ws).context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(finalize.calls[0]?.commitMessage).toBe(
    "b".repeat(MAX_COMMIT_MESSAGE_CHARS),
  );
});

test("budget exhaustion fails with BUDGET_EXCEEDED and never reaches finalize or verify", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        { name: "read_file", arguments: { path: "README.md" } },
        { name: "read_file", arguments: { path: "README.md" } },
      ],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn, {
    commandAllowlist: nodeAllowlist,
  });

  const result = await executor.execute(
    params({
      budgets: { maxToolCalls: 1 },
      verifyCommand: { name: "node", args: ["-e", ""] },
    }),
    harness(ws).context,
  );

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("BUDGET_EXCEEDED");
  expect(result.error?.message).toMatch(/tool[- ]call/i);
  expect(finalize.calls).toHaveLength(0);
  expect(result.verify).toBeUndefined();
  expect(result.artifact).toBeUndefined();
});

test("cancellation yields canceled and never reaches finalize", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "too late", delayMs: 30_000 },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);
  const controller = new AbortController();
  const { context } = harness(ws, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("canceled");
  expect(result.error?.code).toBe("CANCELED");
  expect(finalize.calls).toHaveLength(0);
});

test("a malformed endpoint response fails with INTERNAL and never reaches finalize", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "malformed" }]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);

  const result = await executor.execute(params(), harness(ws).context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
  expect(finalize.calls).toHaveLength(0);
});

test("a throwing finalize fails the job with INTERNAL naming finalize, and verify is skipped", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "done" }]);
  const finalize = fakeFinalize(async () => {
    throw new Error("bundle-out exploded");
  });
  const executor = makeExecutor(endpoint, finalize.fn, {
    commandAllowlist: nodeAllowlist,
  });

  // The Executor contract: execute RESOLVES in every outcome.
  const result = await executor.execute(
    params({ verifyCommand: { name: "node", args: ["-e", ""] } }),
    harness(ws).context,
  );

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
  expect(result.error?.message).toContain("finalize");
  expect(result.error?.message).toContain("bundle-out exploded");
  expect(result.verify).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 5. verify
// ---------------------------------------------------------------------------

test("a failing verify command is reported without failing the job", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: { commitMessage: "Verify me", summary: "changed things" },
        },
      ],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn, {
    commandAllowlist: nodeAllowlist,
  });
  const verifyArgs = [
    "-e",
    "console.log('checking'); console.error('boom'); process.exitCode = 3;",
  ];

  const result = await executor.execute(
    params({ verifyCommand: { name: "node", args: verifyArgs } }),
    harness(ws).context,
  );

  assertValid(result);
  // Verify exitCode !== 0 does NOT fail the job — report-only.
  expect(result.status).toBe("succeeded");
  expect(result.artifact).not.toBeNull();
  expect(result.verify).toMatchObject({
    name: "node",
    args: verifyArgs,
    exitCode: 3,
  });
  expect(result.verify?.outputTail).toContain("boom");
  expect(result.verify?.outputTail).toContain("checking");
});

test("verify runs AFTER finalize, in the workspace directory", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "done" }]);
  // finalize leaves a marker in the workspace; the verify command can only
  // see it if it runs later, with the workspace as its cwd.
  const finalize = fakeFinalize(async (input) => {
    await writeFile(
      path.join(input.workspaceDir, "finalize-marker.txt"),
      "finalized-first",
    );
    return makeArtifact(input.commitMessage);
  });
  const executor = makeExecutor(endpoint, finalize.fn, {
    commandAllowlist: nodeAllowlist,
  });

  const result = await executor.execute(
    params({
      verifyCommand: {
        name: "node",
        args: [
          "-e",
          "process.stdout.write(require('fs').readFileSync('finalize-marker.txt', 'utf8'))",
        ],
      },
    }),
    harness(ws).context,
  );

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.verify?.exitCode).toBe(0);
  expect(result.verify?.outputTail).toContain("finalized-first");
});

// ---------------------------------------------------------------------------
// 6. context-window floor
// ---------------------------------------------------------------------------

test("contextWindow below the floor is refused with INVALID_REQUEST before any model call", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "x" }]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn, {
    contextWindow: MIN_AGENT_CONTEXT_WINDOW - 1,
  });

  const result = await executor.execute(params(), harness(ws).context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INVALID_REQUEST");
  expect(result.error?.message).toContain(String(MIN_AGENT_CONTEXT_WINDOW));
  expect(endpoint.requests).toHaveLength(0);
  expect(finalize.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 7. summary capping
// ---------------------------------------------------------------------------

test("an oversized finish_task summary is capped so the result can always ship", async () => {
  const ws = await makeWorkspace();
  // Past MAX_SUMMARY_BYTES in multi-byte chars: the cut must land on a
  // character boundary (same discipline as recon's capSummary).
  const euros = Math.ceil(MAX_SUMMARY_BYTES / 3) + 5_000;
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: { commitMessage: "Cap test", summary: "€".repeat(euros) },
        },
      ],
    },
  ]);
  const executor = makeExecutor(endpoint, fakeFinalize().fn);

  const result = await executor.execute(params(), harness(ws).context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  const summary = result.summary ?? "";
  expect(summary.endsWith(SUMMARY_TRUNCATION_MARKER)).toBe(true);
  const kept = summary.slice(0, -SUMMARY_TRUNCATION_MARKER.length);
  expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(
    MAX_SUMMARY_BYTES,
  );
  expect(kept.includes("�")).toBe(false);
  expect(kept.endsWith("€")).toBe(true);
});

// ---------------------------------------------------------------------------
// 8. artifact: null
// ---------------------------------------------------------------------------

test("finalize returning null (clean tree) yields succeeded with an explicit null artifact", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "nothing needed changing" },
  ]);
  const finalize = fakeFinalize(async () => null);
  const executor = makeExecutor(endpoint, finalize.fn);

  const result = await executor.execute(params(), harness(ws).context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  // Present-or-null is the contract: an ABSENT artifact on a succeeded write
  // would be indistinguishable from a finalize bug dropping completed work.
  expect("artifact" in result).toBe(true);
  expect(result.artifact).toBeNull();
});

// ---------------------------------------------------------------------------
// 9. .git write attempt surfaces as a continuing loop
// ---------------------------------------------------------------------------

test("a write into the git admin area is an error tool-result and the loop continues", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: ".git/hooks/x", content: "pwn" },
        },
      ],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: { commitMessage: "Recovered", summary: "backed off" },
        },
      ],
    },
  ]);
  const finalize = fakeFinalize();
  const executor = makeExecutor(endpoint, finalize.fn);
  const { context, events } = harness(ws);

  const result = await executor.execute(params(), context);

  assertValid(result);
  // A refused tool call is NOT a job failure: the model saw the error,
  // reacted, and finished.
  expect(result.status).toBe("succeeded");
  expect(result.stats.toolCalls).toBe(1);
  expect(finalize.calls).toHaveLength(1);
  const toolResult = events.find((event) => event.type === "tool_result");
  expect(toolResult).toMatchObject({
    name: "write_file",
    isError: true,
    resultSummary: expect.stringContaining("git admin"),
  });
  expect(JSON.stringify(body(endpoint, 1).messages)).toContain("git admin");
  // Nothing was planted.
  expect(existsSync(path.join(ws, ".git"))).toBe(false);
});
