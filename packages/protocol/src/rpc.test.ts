import { expect, test } from "vitest";
import {
  CancelResponseSchema,
  DelegateRequestSchema,
  DelegateResponseSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  JobSnapshotSchema,
} from "./rpc.js";
import {
  validJobId,
  validJobResult,
  validNodeInfo,
  validWorkspace,
} from "./test-fixtures.js";

test("HelloRequestSchema and HelloResponseSchema round-trip", () => {
  const message = { nodeInfo: validNodeInfo };
  expect(HelloRequestSchema.parse(message)).toEqual(message);
  expect(HelloResponseSchema.parse(message)).toEqual(message);
});

test("DelegateRequestSchema applies job param defaults through the wrapper", () => {
  const parsed = DelegateRequestSchema.parse({
    params: { type: "command", workspace: validWorkspace, command: "pnpm" },
  });
  expect(parsed.params).toEqual({
    type: "command",
    workspace: validWorkspace,
    command: "pnpm",
    args: [],
    timeoutMs: 600000,
  });
});

test("DelegateRequestSchema rejects an unknown job type", () => {
  expect(
    DelegateRequestSchema.safeParse({
      params: { type: "deploy", workspace: validWorkspace },
    }).success,
  ).toBe(false);
});

test("DelegateResponseSchema round-trips and rejects a non-UUID jobId", () => {
  expect(DelegateResponseSchema.parse({ jobId: validJobId })).toEqual({
    jobId: validJobId,
  });
  expect(DelegateResponseSchema.safeParse({ jobId: "job-42" }).success).toBe(
    false,
  );
});

test("JobSnapshotSchema accepts a non-terminal snapshot without result", () => {
  const snapshot = { jobId: validJobId, status: "running" };
  expect(JobSnapshotSchema.parse(snapshot)).toEqual(snapshot);
});

test("JobSnapshotSchema accepts a terminal snapshot with result", () => {
  const snapshot = {
    jobId: validJobId,
    status: "succeeded",
    result: validJobResult,
  };
  expect(JobSnapshotSchema.parse(snapshot)).toEqual(snapshot);
});

test("JobSnapshotSchema rejects a terminal snapshot missing result", () => {
  expect(
    JobSnapshotSchema.safeParse({ jobId: validJobId, status: "failed" })
      .success,
  ).toBe(false);
});

test("JobSnapshotSchema rejects a non-terminal snapshot carrying result", () => {
  expect(
    JobSnapshotSchema.safeParse({
      jobId: validJobId,
      status: "queued",
      result: validJobResult,
    }).success,
  ).toBe(false);
});

test("JobSnapshotSchema rejects result.status differing from snapshot status", () => {
  expect(
    JobSnapshotSchema.safeParse({
      jobId: validJobId,
      status: "canceled",
      result: validJobResult, // status: "succeeded"
    }).success,
  ).toBe(false);
});

test("JobSnapshotSchema rejects result.jobId differing from snapshot jobId", () => {
  expect(
    JobSnapshotSchema.safeParse({
      jobId: "11111111-1111-4111-8111-111111111111",
      status: "succeeded",
      result: validJobResult, // jobId: validJobId
    }).success,
  ).toBe(false);
});

test("CancelResponseSchema round-trips", () => {
  const response = { jobId: validJobId, status: "canceled" };
  expect(CancelResponseSchema.parse(response)).toEqual(response);
});
