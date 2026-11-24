import { expect, test } from "vitest";
import { NodeInfoSchema } from "./node.js";
import { validNodeInfo } from "./test-fixtures.js";
import {
  LastUpgradeSchema,
  ReleaseSha256Schema,
  UpgradeAcceptedSchema,
  UpgradeRequestSchema,
} from "./upgrade.js";

test("UpgradeRequestSchema accepts a well-formed push", () => {
  const body = { version: "0.5.2", manifest: "eyJ9", signature: "c2ln" };
  expect(UpgradeRequestSchema.parse(body)).toEqual(body);
});

test("UpgradeRequestSchema rejects a non-semver version and non-base64 manifest", () => {
  const ok = { version: "0.5.2", manifest: "eyJ9", signature: "c2ln" };
  expect(
    UpgradeRequestSchema.safeParse({ ...ok, version: "latest" }).success,
  ).toBe(false);
  expect(
    UpgradeRequestSchema.safeParse({ ...ok, manifest: "not base64!!" }).success,
  ).toBe(false);
});

test("UpgradeAcceptedSchema requires accepted: true", () => {
  expect(
    UpgradeAcceptedSchema.safeParse({ accepted: true, version: "0.5.2" })
      .success,
  ).toBe(true);
  expect(
    UpgradeAcceptedSchema.safeParse({ accepted: false, version: "0.5.2" })
      .success,
  ).toBe(false);
});

test("LastUpgradeSchema takes ISO timestamps, not epoch ms", () => {
  const ok = { version: "0.5.2", outcome: "succeeded" as const };
  expect(
    LastUpgradeSchema.safeParse({ ...ok, at: "2026-10-22T18:09:49.982Z" })
      .success,
  ).toBe(true);
  expect(
    LastUpgradeSchema.safeParse({ ...ok, at: 1761156589982 }).success,
  ).toBe(false);
});

test("NodeInfoSchema still parses a 0.3 peer with neither new field", () => {
  const parsed = NodeInfoSchema.parse(validNodeInfo);
  expect(parsed.upgrade).toBeUndefined();
  expect(parsed.lastUpgrade).toBeUndefined();
});

test("NodeInfoSchema keeps upgrade and lastUpgrade", () => {
  const extra = {
    upgrade: { allowRemote: true },
    lastUpgrade: {
      version: "0.5.2",
      outcome: "rolled-back" as const,
      reason: "x",
      at: "2026-10-22T18:00:00.000Z",
    },
  };
  expect(NodeInfoSchema.parse({ ...validNodeInfo, ...extra })).toMatchObject(
    extra,
  );
});

test("UpgradeRequestSchema accepts candidate: true, and its absence (an older pusher)", () => {
  const ok = { version: "0.8.0", manifest: "eyJ9", signature: "c2ln" };
  expect(UpgradeRequestSchema.parse({ ...ok, candidate: true })).toEqual({
    ...ok,
    candidate: true,
  });
  expect(UpgradeRequestSchema.parse(ok)).toEqual(ok);
  expect(
    UpgradeRequestSchema.safeParse({ ...ok, candidate: "yes" }).success,
  ).toBe(false);
});

test("ReleaseSha256Schema accepts 64 lower-case hex only", () => {
  expect(ReleaseSha256Schema.safeParse("a".repeat(64)).success).toBe(true);
  expect(ReleaseSha256Schema.safeParse("A".repeat(64)).success).toBe(false);
  expect(ReleaseSha256Schema.safeParse("a".repeat(63)).success).toBe(false);
});

test("NodeInfoSchema takes an optional releaseSha256; a v0.7.0 shape still parses", () => {
  const sha = "b".repeat(64);
  expect(
    NodeInfoSchema.parse({ ...validNodeInfo, releaseSha256: sha })
      .releaseSha256,
  ).toBe(sha);
  expect(NodeInfoSchema.parse(validNodeInfo).releaseSha256).toBeUndefined();
  expect(
    NodeInfoSchema.safeParse({
      ...validNodeInfo,
      releaseSha256: "B".repeat(64),
    }).success,
  ).toBe(false);
});
