import { expect, test } from "vitest";
import {
  DeviceIdSchema,
  ExecutorKindSchema,
  GpuInfoSchema,
  ModelInfoSchema,
  NodeInfoSchema,
  NodeRoleSchema,
} from "./node.js";
import { validDeviceId, validNodeInfo } from "./test-fixtures.js";

test("DeviceIdSchema accepts a 64-char lowercase hex string", () => {
  expect(DeviceIdSchema.parse(validDeviceId)).toBe(validDeviceId);
});

test("DeviceIdSchema rejects wrong length", () => {
  expect(DeviceIdSchema.safeParse(validDeviceId.slice(0, 63)).success).toBe(
    false,
  );
  expect(DeviceIdSchema.safeParse(`${validDeviceId}0`).success).toBe(false);
  expect(DeviceIdSchema.safeParse("").success).toBe(false);
});

test("DeviceIdSchema rejects uppercase hex", () => {
  expect(DeviceIdSchema.safeParse(validDeviceId.toUpperCase()).success).toBe(
    false,
  );
});

test("DeviceIdSchema rejects non-hex characters", () => {
  expect(DeviceIdSchema.safeParse(`${"g".repeat(64)}`).success).toBe(false);
});

test("GpuInfoSchema round-trips with and without vramBytes", () => {
  const full = { name: "RX 6700 XT", vramBytes: 12884901888 };
  const minimal = { name: "GTX 1060" };
  expect(GpuInfoSchema.parse(full)).toEqual(full);
  expect(GpuInfoSchema.parse(minimal)).toEqual(minimal);
});

test("ModelInfoSchema round-trips with and without contextWindow", () => {
  const full = { id: "qwen3.5-4b", contextWindow: 32768 };
  const minimal = { id: "qwen3.6-35b-a3b" };
  expect(ModelInfoSchema.parse(full)).toEqual(full);
  expect(ModelInfoSchema.parse(minimal)).toEqual(minimal);
});

test("NodeRoleSchema accepts defined roles and rejects others", () => {
  expect(NodeRoleSchema.parse("inference")).toBe("inference");
  expect(NodeRoleSchema.parse("execution")).toBe("execution");
  expect(NodeRoleSchema.safeParse("storage").success).toBe(false);
});

test("ExecutorKindSchema accepts defined kinds and rejects others", () => {
  expect(ExecutorKindSchema.parse("command")).toBe("command");
  expect(ExecutorKindSchema.parse("agent")).toBe("agent");
  expect(ExecutorKindSchema.safeParse("shell").success).toBe(false);
});

test("NodeInfoSchema round-trips a valid node", () => {
  expect(NodeInfoSchema.parse(validNodeInfo)).toEqual(validNodeInfo);
});

test("NodeInfoSchema rejects an empty name", () => {
  expect(NodeInfoSchema.safeParse({ ...validNodeInfo, name: "" }).success).toBe(
    false,
  );
});

test("NodeInfoSchema rejects a name longer than 64 chars", () => {
  expect(
    NodeInfoSchema.safeParse({ ...validNodeInfo, name: "x".repeat(65) })
      .success,
  ).toBe(false);
});

test("NodeInfoSchema rejects an invalid platform", () => {
  expect(
    NodeInfoSchema.safeParse({ ...validNodeInfo, platform: "freebsd" }).success,
  ).toBe(false);
});

test("NodeInfoSchema rejects maxConcurrentJobs below 1 or non-integer", () => {
  expect(
    NodeInfoSchema.safeParse({ ...validNodeInfo, maxConcurrentJobs: 0 })
      .success,
  ).toBe(false);
  expect(
    NodeInfoSchema.safeParse({ ...validNodeInfo, maxConcurrentJobs: 1.5 })
      .success,
  ).toBe(false);
});

test("NodeInfoSchema rejects negative activeJobs", () => {
  expect(
    NodeInfoSchema.safeParse({ ...validNodeInfo, activeJobs: -1 }).success,
  ).toBe(false);
});
