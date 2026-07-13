/**
 * Tests for runToolLoop's terminalTools short-circuit — the ONE piece of the
 * extracted loop that is new code (everything else moved verbatim from
 * AgentExecutor and stays covered by agent-executor.test.ts). Uses the
 * MockOpenAiEndpoint fixture; the tools are stubs that record execution,
 * because non-execution is exactly what is being asserted.
 */
import { afterEach, expect, test } from "vitest";
import type { ExecutorEventPayload } from "../executor.js";
import { MockOpenAiEndpoint, type MockScriptEntry } from "../test-fixtures.js";
import { runToolLoop } from "./loop.js";
import { OpenAiClient } from "./openai-client.js";
import type { AgentTool } from "./tools.js";

const endpoints: MockOpenAiEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) {
    await endpoint.close();
  }
});

async function startEndpoint(
  script: MockScriptEntry[],
): Promise<MockOpenAiEndpoint> {
  const endpoint = await MockOpenAiEndpoint.start(script);
  endpoints.push(endpoint);
  return endpoint;
}

/** A tool that records every execution into `executions`. */
function recordingTool(name: string, executions: unknown[]): AgentTool {
  return {
    name,
    definition: {
      type: "function",
      function: {
        name,
        description: `stub ${name}`,
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async (args) => {
      executions.push(args);
      return { content: `${name} ran`, isError: false };
    },
  };
}

test("a terminal tool call ends the loop as terminal_call without executing the tool", async () => {
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "finish_task", arguments: { message: "done" } }],
    },
  ]);
  const executions: unknown[] = [];
  const events: ExecutorEventPayload[] = [];

  const outcome = await runToolLoop({
    client: new OpenAiClient({ baseUrl: endpoint.baseUrl }),
    model: "test-model",
    systemPrompt: "system prompt",
    userPrompt: "user prompt",
    tools: [recordingTool("finish_task", executions)],
    budgets: { maxToolCalls: 10, maxWallMs: 30_000 },
    terminalTools: ["finish_task"],
    toolContext: { workspaceDir: "unused-by-stub-tools" },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
  });

  expect(outcome.kind).toBe("terminal_call");
  if (outcome.kind !== "terminal_call") {
    throw new Error("unreachable");
  }
  expect(outcome.terminalCall).toEqual({
    name: "finish_task",
    args: { message: "done" },
  });
  // The call was returned, not executed: no execution, no tool-call budget
  // consumed, no tool events, no further model traffic.
  expect(executions).toHaveLength(0);
  expect(outcome.stats.toolCalls).toBe(0);
  expect(events).toHaveLength(0);
  expect(endpoint.requests).toHaveLength(1);
});

test("a non-terminal tool still executes when terminalTools is set", async () => {
  const endpoint = await startEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [{ name: "gather", arguments: { step: 1 } }],
    },
    { kind: "content", content: "all done" },
  ]);
  const gatherExecutions: unknown[] = [];
  const finishExecutions: unknown[] = [];
  const events: ExecutorEventPayload[] = [];

  const outcome = await runToolLoop({
    client: new OpenAiClient({ baseUrl: endpoint.baseUrl }),
    model: "test-model",
    systemPrompt: "system prompt",
    userPrompt: "user prompt",
    tools: [
      recordingTool("gather", gatherExecutions),
      recordingTool("finish_task", finishExecutions),
    ],
    budgets: { maxToolCalls: 10, maxWallMs: 30_000 },
    terminalTools: ["finish_task"],
    toolContext: { workspaceDir: "unused-by-stub-tools" },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
  });

  expect(outcome.kind).toBe("content");
  if (outcome.kind !== "content") {
    throw new Error("unreachable");
  }
  expect(outcome.finalContent).toBe("all done");
  expect(gatherExecutions).toEqual([{ step: 1 }]);
  expect(finishExecutions).toHaveLength(0);
  expect(outcome.stats.toolCalls).toBe(1);
  expect(events.map((event) => event.type)).toEqual([
    "tool_call",
    "tool_result",
  ]);
});
