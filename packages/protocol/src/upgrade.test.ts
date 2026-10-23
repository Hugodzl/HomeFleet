import { expect, test } from "vitest";
import { NodeInfoSchema } from "./node.js";
import { validNodeInfo } from "./test-fixtures.js";
import {
  LastUpgradeSchema,
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
