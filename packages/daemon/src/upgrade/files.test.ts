import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireLock,
  LOCK_FILE,
  RESULT_FILE,
  ROLLOUT_STATUS_FILE,
  readRolloutStatusSync,
  readUpgradeResultSync,
  releaseLock,
  STALE_LOCK_MS,
  toLastUpgrade,
  writeRolloutStatus,
  writeUpgradeResult,
} from "./files.js";
import type { RolloutStatus } from "./rollout.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-files-"));
  dirs.push(dir);
  return dir;
}

/** A PID that is certainly not running. */
const DEAD_PID = 2_147_483_000;

test("acquire, refuse while held, release, re-acquire", async () => {
  const dir = await tempDir();
  expect(await acquireLock(dir, { pid: process.pid, now: 1_000 })).toBe(true);
  expect(await acquireLock(dir, { pid: process.pid, now: 2_000 })).toBe(false);
  await releaseLock(dir);
  expect(await acquireLock(dir, { pid: process.pid, now: 3_000 })).toBe(true);
});

test("a lock older than STALE_LOCK_MS whose pid is dead is taken over", async () => {
  const dir = await tempDir();
  await writeFile(
    path.join(dir, LOCK_FILE),
    JSON.stringify({ pid: DEAD_PID, at: 0 }),
  );
  expect(
    await acquireLock(dir, { pid: process.pid, now: STALE_LOCK_MS + 1 }),
  ).toBe(true);
  const held = JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8"));
  expect(held.pid).toBe(process.pid);
});

test("an old lock whose pid is ALIVE is respected", async () => {
  const dir = await tempDir();
  await writeFile(
    path.join(dir, LOCK_FILE),
    JSON.stringify({ pid: process.pid, at: 0 }),
  );
  expect(
    await acquireLock(dir, { pid: process.pid, now: STALE_LOCK_MS + 1 }),
  ).toBe(false);
});

test("a corrupt lock is treated as stale", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, LOCK_FILE), "not json");
  expect(await acquireLock(dir, { pid: process.pid, now: 1 })).toBe(true);
});

test("readUpgradeResultSync: absent, valid, corrupt", async () => {
  const dataDir = await tempDir();
  expect(readUpgradeResultSync(dataDir)).toBeUndefined();
  await writeFile(
    path.join(dataDir, RESULT_FILE),
    JSON.stringify({
      from: "0.5.0",
      to: "0.5.1",
      outcome: "rolled-back",
      reason: "x",
      at: 5,
    }),
  );
  expect(readUpgradeResultSync(dataDir)).toEqual({
    from: "0.5.0",
    to: "0.5.1",
    outcome: "rolled-back",
    reason: "x",
    at: 5,
  });
  await writeFile(path.join(dataDir, RESULT_FILE), "{");
  expect(readUpgradeResultSync(dataDir)).toBeUndefined();
});

test("toLastUpgrade maps to -> version and epoch ms -> ISO string", () => {
  const at = Date.UTC(2026, 9, 22, 18);
  expect(
    toLastUpgrade({
      from: "0.5.1",
      to: "0.5.2",
      outcome: "rolled-back",
      reason: "r",
      at,
    }),
  ).toEqual({
    version: "0.5.2",
    outcome: "rolled-back",
    reason: "r",
    at: "2026-10-22T18:00:00.000Z",
  });
  const noReason = toLastUpgrade({
    from: "0.5.1",
    to: "0.5.2",
    outcome: "succeeded",
    at,
  });
  expect("reason" in noReason).toBe(false);
});

test("writeUpgradeResult round-trips through readUpgradeResultSync", async () => {
  const dataDir = await tempDir();
  const result = {
    from: "0.5.1",
    to: "0.5.2",
    outcome: "failed" as const,
    reason: "verify-failed",
    at: 1_700_000_000_000,
  };
  await writeUpgradeResult(dataDir, result);
  expect(readUpgradeResultSync(dataDir)).toEqual(result);
  expect(
    (await readFile(path.join(dataDir, RESULT_FILE), "utf8")).endsWith("\n"),
  ).toBe(true);
});

describe("readUpgradeResultSync rejects shape-valid but unusable files", () => {
  const base = { from: "0.5.0", to: "0.5.1", outcome: "failed", at: 5 };
  test.each([
    ["non-semver to", { ...base, to: "latest" }],
    ["non-semver from", { ...base, from: "x" }],
    ["at out of Date range", { ...base, at: 1e20 }],
    ["at null", { ...base, at: null }],
  ])("%s -> undefined", async (_name, body) => {
    const dataDir = await tempDir();
    await writeFile(path.join(dataDir, RESULT_FILE), JSON.stringify(body));
    expect(readUpgradeResultSync(dataDir)).toBeUndefined();
  });

  test("a valid file still parses", async () => {
    const dataDir = await tempDir();
    await writeFile(path.join(dataDir, RESULT_FILE), JSON.stringify(base));
    expect(readUpgradeResultSync(dataDir)).toEqual(base);
  });
});

describe("rollout status store", () => {
  const status: RolloutStatus = {
    id: "r1",
    target: "0.5.3",
    startedAt: "2026-10-23T10:00:00.000Z",
    state: "running",
    peers: [{ deviceId: "t", name: "tower", state: "refused", reason: "off" }],
    self: { state: "restarting" },
  };

  test("absent -> undefined; written -> read back from upgrades/", async () => {
    const dataDir = await tempDir();
    expect(readRolloutStatusSync(dataDir)).toBeUndefined();
    await writeRolloutStatus(dataDir, status);
    expect(
      JSON.parse(
        await readFile(
          path.join(dataDir, "upgrades", ROLLOUT_STATUS_FILE),
          "utf8",
        ),
      ),
    ).toEqual(status);
    expect(readRolloutStatusSync(dataDir)).toEqual(status);
  });

  test("corrupt or wrongly shaped -> undefined", async () => {
    const dataDir = await tempDir();
    await writeRolloutStatus(dataDir, status);
    const file = path.join(dataDir, "upgrades", ROLLOUT_STATUS_FILE);
    await writeFile(file, "{nope");
    expect(readRolloutStatusSync(dataDir)).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...status, peers: "x" }));
    expect(readRolloutStatusSync(dataDir)).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...status, self: null }));
    expect(readRolloutStatusSync(dataDir)).toBeUndefined();
  });
});
