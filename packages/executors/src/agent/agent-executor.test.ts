import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type JobResult,
  JobResultSchema,
  type ReconJobParams,
  ReconJobParamsSchema,
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
  AgentExecutor,
  EVENT_SUMMARY_MAX_CHARS,
  MAX_SUMMARY_BYTES,
  SUMMARY_TRUNCATION_MARKER,
} from "./agent-executor.js";

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

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

async function makeWorkspace(): Promise<string> {
  const ws = await tempDir();
  await writeFile(path.join(ws, "README.md"), "# HomeFleet\nTODO: docs\n");
  await mkdir(path.join(ws, "src"));
  await writeFile(
    path.join(ws, "src", "index.ts"),
    'export const x = "TODO";\n',
  );
  return ws;
}

async function startEndpoint(
  script: MockScriptEntry[],
): Promise<MockOpenAiEndpoint> {
  const endpoint = await MockOpenAiEndpoint.start(script);
  endpoints.push(endpoint);
  return endpoint;
}

function makeExecutor(
  overrides: { commandAllowlist?: CommandAllowlist } = {},
): AgentExecutor {
  return new AgentExecutor(
    overrides.commandAllowlist !== undefined
      ? { commandAllowlist: overrides.commandAllowlist }
      : {},
  );
}

/** Parses through the schema so budget defaults apply. */
function params(overrides: Record<string, unknown> = {}): ReconJobParams {
  return ReconJobParamsSchema.parse({
    type: "recon",
    workspace: { repoId: "homefleet", headCommit: "0".repeat(40) },
    prompt: "Summarize the repo layout.",
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
      endpoint: {
        baseUrl: "http://unused/v1",
        model: "default-model",
        contextWindow: 32768,
      },
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

test("happy path: two tool calls, then the content becomes the summary", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }],
      usage: { promptTokens: 10, completionTokens: 2 },
    },
    {
      kind: "tool_calls",
      toolCalls: [{ name: "grep", arguments: { pattern: "TODO" } }],
      usage: { promptTokens: 20, completionTokens: 3 },
    },
    {
      kind: "content",
      content: "A pnpm monorepo with protocol/daemon/executors packages.",
      usage: { promptTokens: 30, completionTokens: 5 },
    },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.summary).toBe(
    "A pnpm monorepo with protocol/daemon/executors packages.",
  );
  expect(result.error).toBeUndefined();
  expect(result.stats.toolCalls).toBe(2);
  // Usage is summed across all three responses.
  expect(result.stats.promptTokens).toBe(60);
  expect(result.stats.completionTokens).toBe(10);

  // Events: tool_call/tool_result pairs, in order, with summaries.
  expect(events.map((event) => event.type)).toEqual([
    "tool_call",
    "tool_result",
    "tool_call",
    "tool_result",
  ]);
  expect(events[0]).toEqual({
    type: "tool_call",
    name: "read_file",
    argsSummary: '{"path":"README.md"}',
  });
  expect(events[1]).toMatchObject({
    type: "tool_result",
    name: "read_file",
    isError: false,
    resultSummary: expect.stringContaining("# HomeFleet"),
  });

  // The conversation threads correctly: system+user first, then the
  // assistant tool_calls echo and the tool result.
  expect(endpoint.requests).toHaveLength(3);
  const first = body(endpoint, 0);
  expect(first.model).toBe("default-model");
  expect(first.messages[0]).toMatchObject({
    role: "system",
    content: expect.stringContaining(ws),
  });
  expect(String(first.messages[0]?.content)).toMatch(/read-?only/i);
  expect(first.messages[1]).toEqual({
    role: "user",
    content: "Summarize the repo layout.",
  });
  const second = body(endpoint, 1);
  expect(second.messages).toHaveLength(4);
  const assistant = second.messages[2] as {
    role: string;
    tool_calls: { id: string; function: { name: string } }[];
  };
  expect(assistant.role).toBe("assistant");
  expect(assistant.tool_calls[0]?.function.name).toBe("read_file");
  expect(second.messages[3]).toMatchObject({
    role: "tool",
    tool_call_id: assistant.tool_calls[0]?.id,
    content: expect.stringContaining("# HomeFleet"),
  });
});

test("every tool is drivable through the loop", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }],
    },
    {
      kind: "tool_calls",
      toolCalls: [{ name: "list_dir", arguments: { path: "." } }],
    },
    {
      kind: "tool_calls",
      toolCalls: [{ name: "grep", arguments: { pattern: "TODO" } }],
    },
    {
      kind: "tool_calls",
      toolCalls: [{ name: "glob", arguments: { pattern: "**/*.ts" } }],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "run_command",
          arguments: { command: "node", args: ["-e", ""] },
        },
      ],
    },
    { kind: "content", content: "done" },
  ]);
  const executor = makeExecutor({ commandAllowlist: nodeAllowlist });
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.stats.toolCalls).toBe(5);
  const toolResults = events.filter((event) => event.type === "tool_result");
  expect(toolResults.map((event) => event.name)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "run_command",
  ]);
  for (const event of toolResults) {
    expect(event.isError).toBe(false);
  }
});

test("sandbox escapes come back as error tool-results and the loop continues", async () => {
  const ws = await makeWorkspace();
  const outside = await tempDir();
  await writeFile(path.join(outside, "private.txt"), "secret");
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "read_file", arguments: { path: "../x" } }],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "read_file",
          arguments: { path: path.join(outside, "private.txt") },
        },
      ],
    },
    { kind: "content", content: "recovered" },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.summary).toBe("recovered");
  const toolResults = events.filter((event) => event.type === "tool_result");
  expect(toolResults).toHaveLength(2);
  for (const event of toolResults) {
    expect(event.isError).toBe(true);
    expect(event.resultSummary).toContain("escapes the workspace");
  }
  // The model saw the sandbox error, never the file content.
  const finalMessages = JSON.stringify(body(endpoint, 2).messages);
  expect(finalMessages).toContain("escapes the workspace");
  expect(finalMessages).not.toContain("secret");
});

test("a symlink pointing outside the workspace is refused through the loop", async () => {
  const ws = await makeWorkspace();
  const outside = await tempDir();
  await writeFile(path.join(outside, "private.txt"), "secret");
  try {
    await symlink(
      path.join(outside, "private.txt"),
      path.join(ws, "innocent.txt"),
      "file",
    );
  } catch {
    // Windows may refuse file-symlink creation without developer mode or
    // elevation; the lexical escape cases above still run — skip only this
    // realpath-specific case.
    return;
  }
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "read_file", arguments: { path: "innocent.txt" } }],
    },
    { kind: "content", content: "done" },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  expect(result.status).toBe("succeeded");
  const toolResult = events.find((event) => event.type === "tool_result");
  expect(toolResult?.isError).toBe(true);
  expect(toolResult?.resultSummary).toContain("escapes the workspace");
  expect(JSON.stringify(body(endpoint, 1).messages)).not.toContain("secret");
});

test("an unknown tool name is an error tool-result, not a crash", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "launch_missiles", arguments: {} }],
    },
    { kind: "content", content: "sorry, wrong tool" },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.stats.toolCalls).toBe(1);
  const toolResult = events.find((event) => event.type === "tool_result");
  expect(toolResult).toMatchObject({
    isError: true,
    resultSummary: expect.stringContaining("unknown tool"),
  });
  // The error text went back to the model as the tool message.
  expect(JSON.stringify(body(endpoint, 1).messages)).toContain("unknown tool");
});

test("non-JSON tool arguments are an error tool-result, not a crash", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "read_file", argumentsRaw: "{not json" }],
    },
    { kind: "content", content: "retrying differently" },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  expect(result.status).toBe("succeeded");
  const toolResult = events.find((event) => event.type === "tool_result");
  expect(toolResult).toMatchObject({
    isError: true,
    resultSummary: expect.stringContaining("not valid JSON"),
  });
});

test("an oversized model summary is capped so the result can always ship", async () => {
  const ws = await makeWorkspace();
  // A summary well past MAX_SUMMARY_BYTES that ends on a multi-byte char, so
  // the cut must land on a character boundary.
  const euros = Math.ceil(MAX_SUMMARY_BYTES / 3) + 5_000;
  const endpoint = await startEndpoint([
    { kind: "content", content: "€".repeat(euros) },
  ]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  const summary = result.summary ?? "";
  expect(summary.endsWith(SUMMARY_TRUNCATION_MARKER)).toBe(true);
  const kept = summary.slice(0, -SUMMARY_TRUNCATION_MARKER.length);
  expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(
    MAX_SUMMARY_BYTES,
  );
  // No split multi-byte character at the boundary.
  expect(kept.includes("�")).toBe(false);
  expect(kept.endsWith("€")).toBe(true);
});

test("a summary at or below the cap is passed through unchanged", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "concise" },
  ]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  expect(result.summary).toBe("concise");
});

test("a malformed endpoint response fails the job with INTERNAL", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "malformed" }]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
  expect(result.error?.message).toContain("malformed");
});

test("a response with neither content nor tool calls fails with INTERNAL", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "tool_calls", toolCalls: [] }]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
});

test("an unreachable endpoint fails the job with INTERNAL", async () => {
  const ws = await makeWorkspace();
  // Start and immediately close: the port is real but nothing listens.
  const endpoint = await MockOpenAiEndpoint.start([]);
  await endpoint.close();
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
});

test("exceeding maxToolCalls fails with BUDGET_EXCEEDED and accurate stats", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        { name: "read_file", arguments: { path: "README.md" } },
        { name: "grep", arguments: { pattern: "TODO" } },
      ],
    },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(
    params({ budgets: { maxToolCalls: 1 } }),
    context,
  );

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("BUDGET_EXCEEDED");
  expect(result.error?.message).toMatch(/tool[- ]call/i);
  // The first call ran; the second was refused before executing.
  expect(result.stats.toolCalls).toBe(1);
  expect(events.filter((event) => event.type === "tool_result")).toHaveLength(
    1,
  );
});

test("exceeding maxWallMs during a slow model call fails with BUDGET_EXCEEDED", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "too late", delayMs: 30_000 },
  ]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(
    params({ budgets: { maxWallMs: 1000 } }),
    context,
  );

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("BUDGET_EXCEEDED");
  expect(result.error?.message).toMatch(/wall/i);
  expect(result.stats.wallMs).toBeGreaterThanOrEqual(1000);
}, 10_000);

test("cancellation mid-loop yields a canceled result with partial stats", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }],
    },
    { kind: "content", content: "never reached" },
  ]);
  const executor = makeExecutor();
  const controller = new AbortController();
  const events: ExecutorEventPayload[] = [];
  const context: ExecutionContext = {
    jobId,
    workspaceDir: ws,
    emit: (event) => {
      events.push(event);
      // Deterministic mid-loop cancellation: abort while the first tool
      // call is in flight.
      if (event.type === "tool_call") {
        controller.abort();
      }
    },
    signal: controller.signal,
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  };

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("canceled");
  expect(result.error?.code).toBe("CANCELED");
  expect(result.stats.toolCalls).toBe(1);
  // The second model call never happened.
  expect(endpoint.requests).toHaveLength(1);
});

test("cancellation during a pending model call yields canceled", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "too late", delayMs: 30_000 },
  ]);
  const executor = makeExecutor();
  const controller = new AbortController();
  const { context } = harness(ws, {
    signal: controller.signal,
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });
  setTimeout(() => controller.abort(), 100);

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("canceled");
  expect(result.error?.code).toBe("CANCELED");
});

test("token stats are omitted when the endpoint never reports usage", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "done" }]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("succeeded");
  expect(result.stats.promptTokens).toBeUndefined();
  expect(result.stats.completionTokens).toBeUndefined();
});

test("a missing context.endpoint fails the job with INTERNAL", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "never" }]);
  const executor = makeExecutor();
  const { context } = harness(ws, { endpoint: undefined });

  const result = await executor.execute(params(), context);

  assertValid(result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("INTERNAL");
  // Bailed before any client was built — no model traffic.
  expect(endpoint.requests).toHaveLength(0);
});

test("run_command is advertised only when the allowlist has entries", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    { kind: "content", content: "a" },
    { kind: "content", content: "b" },
  ]);
  const withCommands = makeExecutor({
    commandAllowlist: nodeAllowlist,
  });
  await withCommands.execute(
    params(),
    harness(ws, {
      endpoint: {
        baseUrl: endpoint.baseUrl,
        model: "default-model",
        contextWindow: 32768,
      },
    }).context,
  );
  const disabled = makeExecutor({ commandAllowlist: {} });
  await disabled.execute(
    params(),
    harness(ws, {
      endpoint: {
        baseUrl: endpoint.baseUrl,
        model: "default-model",
        contextWindow: 32768,
      },
    }).context,
  );

  const names = (index: number): string[] =>
    (body(endpoint, index).tools ?? []).map((tool) => tool.function.name);
  expect(names(0)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "run_command",
  ]);
  expect(names(1)).toEqual(["read_file", "list_dir", "grep", "glob"]);
});

test("uses the model + baseUrl from context.endpoint", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "ok" }]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "qwen3.5-9b",
      contextWindow: 32768,
    },
  });

  await executor.execute(params(), context);

  expect(body(endpoint, 0).model).toBe("qwen3.5-9b");
});

test("event summaries are truncated to the summary cap", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "read_file",
          arguments: { path: `nope-${"x".repeat(2_000)}` },
        },
      ],
    },
    { kind: "content", content: "done" },
  ]);
  const executor = makeExecutor();
  const { context, events } = harness(ws, {
    endpoint: {
      baseUrl: endpoint.baseUrl,
      model: "default-model",
      contextWindow: 32768,
    },
  });

  await executor.execute(params(), context);

  const toolCall = events.find((event) => event.type === "tool_call");
  expect(toolCall?.argsSummary.length).toBeLessThanOrEqual(
    EVENT_SUMMARY_MAX_CHARS + 1, // +1 for the appended ellipsis
  );
  const toolResult = events.find((event) => event.type === "tool_result");
  expect(toolResult?.resultSummary.length).toBeLessThanOrEqual(
    EVENT_SUMMARY_MAX_CHARS + 1,
  );
});
