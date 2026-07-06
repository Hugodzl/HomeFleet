import { expect, test } from "vitest";
import {
  type JobEvent,
  JobEventSchema,
  LogEventSchema,
  ResultEventSchema,
  StatusEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
} from "./events.js";
import { validJobId, validJobResult } from "./test-fixtures.js";

const base = { jobId: validJobId, seq: 0, ts: "2026-07-06T12:00:00Z" };

test("StatusEventSchema round-trips", () => {
  const event = { ...base, type: "status", status: "running" };
  expect(StatusEventSchema.parse(event)).toEqual(event);
});

test("LogEventSchema round-trips every level", () => {
  for (const level of ["debug", "info", "warn", "error"]) {
    const event = { ...base, type: "log", level, message: "hello" };
    expect(LogEventSchema.parse(event)).toEqual(event);
  }
});

test("ToolCallEventSchema round-trips", () => {
  const event = {
    ...base,
    type: "tool_call",
    name: "grep",
    argsSummary: "pattern=TODO",
  };
  expect(ToolCallEventSchema.parse(event)).toEqual(event);
});

test("ToolResultEventSchema round-trips", () => {
  const event = {
    ...base,
    type: "tool_result",
    name: "grep",
    resultSummary: "3 matches",
    isError: false,
  };
  expect(ToolResultEventSchema.parse(event)).toEqual(event);
});

test("ResultEventSchema round-trips a terminal result", () => {
  const event = { ...base, seq: 12, type: "result", result: validJobResult };
  expect(ResultEventSchema.parse(event)).toEqual(event);
});

test("JobEventSchema parses each variant through the union", () => {
  const events = [
    { ...base, type: "status", status: "queued" },
    { ...base, seq: 1, type: "log", level: "info", message: "starting" },
    {
      ...base,
      seq: 2,
      type: "tool_call",
      name: "read_file",
      argsSummary: "path=README.md",
    },
    {
      ...base,
      seq: 3,
      type: "tool_result",
      name: "read_file",
      resultSummary: "1KB",
      isError: false,
    },
    { ...base, seq: 4, type: "result", result: validJobResult },
  ];
  for (const event of events) {
    expect(JobEventSchema.parse(event)).toEqual(event);
  }
});

test("JobEventSchema rejects an unknown event type", () => {
  expect(JobEventSchema.safeParse({ ...base, type: "heartbeat" }).success).toBe(
    false,
  );
});

test("JobEventSchema rejects a negative or non-integer seq", () => {
  const event = { ...base, type: "status", status: "running" };
  expect(JobEventSchema.safeParse({ ...event, seq: -1 }).success).toBe(false);
  expect(JobEventSchema.safeParse({ ...event, seq: 1.5 }).success).toBe(false);
});

test("JobEventSchema rejects a malformed ts", () => {
  const event = { ...base, type: "status", status: "running" };
  expect(JobEventSchema.safeParse({ ...event, ts: "not-a-date" }).success).toBe(
    false,
  );
  expect(JobEventSchema.safeParse({ ...event, ts: "2026-07-06" }).success).toBe(
    false,
  );
});

test("JobEvent narrows through a switch on type", () => {
  const summarize = (event: JobEvent): string => {
    switch (event.type) {
      case "status":
        return event.status;
      case "log":
        return `${event.level}: ${event.message}`;
      case "tool_call":
        return `${event.name}(${event.argsSummary})`;
      case "tool_result":
        return `${event.name} -> ${event.resultSummary}`;
      case "result":
        return event.result.status;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  };
  expect(
    summarize(
      JobEventSchema.parse({
        ...base,
        seq: 5,
        type: "result",
        result: validJobResult,
      }),
    ),
  ).toBe("succeeded");
});
