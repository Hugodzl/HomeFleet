import { afterEach, expect, test } from "vitest";
import { MockOpenAiEndpoint } from "../test-fixtures.js";
import {
  EndpointHttpError,
  MalformedEndpointResponseError,
  OpenAiClient,
  type ToolDefinition,
} from "./openai-client.js";

const endpoints: MockOpenAiEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) {
    await endpoint.close();
  }
});

async function startEndpoint(
  script: Parameters<typeof MockOpenAiEndpoint.start>[0],
): Promise<MockOpenAiEndpoint> {
  const endpoint = await MockOpenAiEndpoint.start(script);
  endpoints.push(endpoint);
  return endpoint;
}

const sampleTool: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
};

function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

test("posts model, messages, and tools; parses content and usage", async () => {
  const endpoint = await startEndpoint([
    {
      kind: "content",
      content: "the summary",
      usage: { promptTokens: 12, completionTokens: 3 },
    },
  ]);
  const client = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  const completion = await client.chat({
    model: "qwen3.5-9b",
    messages: [{ role: "user", content: "hello" }],
    tools: [sampleTool],
    signal: neverAborts(),
  });
  expect(completion).toEqual({
    content: "the summary",
    toolCalls: [],
    usage: { promptTokens: 12, completionTokens: 3 },
  });
  expect(endpoint.requests).toHaveLength(1);
  expect(endpoint.requests[0]?.body).toEqual({
    model: "qwen3.5-9b",
    messages: [{ role: "user", content: "hello" }],
    tools: [sampleTool],
    stream: false,
  });
});

test("parses tool calls, preserving raw JSON argument text", async () => {
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        { id: "call_abc", name: "read_file", arguments: { path: "a.txt" } },
        { name: "grep", arguments: { pattern: "TODO" } },
      ],
    },
  ]);
  const client = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  const completion = await client.chat({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    signal: neverAborts(),
  });
  expect(completion.content).toBeNull();
  expect(completion.toolCalls).toEqual([
    { id: "call_abc", name: "read_file", arguments: '{"path":"a.txt"}' },
    {
      id: expect.stringMatching(/^call_/),
      name: "grep",
      arguments: '{"pattern":"TODO"}',
    },
  ]);
  // Absent usage is tolerated, not an error.
  expect(completion.usage).toBeUndefined();
});

test("omits the tools field entirely when no tools are passed", async () => {
  const endpoint = await startEndpoint([{ kind: "content", content: "ok" }]);
  const client = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  await client.chat({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    signal: neverAborts(),
  });
  const body = endpoint.requests[0]?.body as Record<string, unknown>;
  expect("tools" in body).toBe(false);
});

test("sends Authorization: Bearer only when an apiKey is configured", async () => {
  const endpoint = await startEndpoint([
    { kind: "content", content: "a" },
    { kind: "content", content: "b" },
  ]);
  const withKey = new OpenAiClient({
    baseUrl: endpoint.baseUrl,
    apiKey: "sk-test",
  });
  await withKey.chat({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    signal: neverAborts(),
  });
  const withoutKey = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  await withoutKey.chat({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    signal: neverAborts(),
  });
  expect(endpoint.requests[0]?.headers.authorization).toBe("Bearer sk-test");
  expect(endpoint.requests[1]?.headers.authorization).toBeUndefined();
});

test("a trailing slash on baseUrl does not break the URL", async () => {
  const endpoint = await startEndpoint([{ kind: "content", content: "ok" }]);
  const client = new OpenAiClient({ baseUrl: `${endpoint.baseUrl}/` });
  const completion = await client.chat({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    signal: neverAborts(),
  });
  expect(completion.content).toBe("ok");
});

test("a schema-invalid response throws MalformedEndpointResponseError", async () => {
  const endpoint = await startEndpoint([{ kind: "malformed" }]);
  const client = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  await expect(
    client.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      signal: neverAborts(),
    }),
  ).rejects.toThrow(MalformedEndpointResponseError);
});

test("a non-2xx response throws EndpointHttpError with the status", async () => {
  // An empty script means the first request already exhausts it -> 500.
  const endpoint = await startEndpoint([]);
  const client = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  const failure = client.chat({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    signal: neverAborts(),
  });
  await expect(failure).rejects.toThrow(EndpointHttpError);
  await expect(failure).rejects.toMatchObject({ status: 500 });
});

test("aborting the signal rejects a pending request", async () => {
  const endpoint = await startEndpoint([
    { kind: "content", content: "too late", delayMs: 30_000 },
  ]);
  const client = new OpenAiClient({ baseUrl: endpoint.baseUrl });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await expect(
    client.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});
