import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { UpgradeError } from "./errors.js";
import { createFleetUpgradeSurface } from "./fleet-upgrade.js";
import { manifestFileName, signatureFileName } from "./manifest.js";
import type { PreparedRelease } from "./prepare.js";
import type { RolloutStartInput, RolloutStatus } from "./rollout.js";

const PEER = "b".repeat(64);
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function status(state: RolloutStatus["state"]): RolloutStatus {
  return {
    id: "r1",
    target: "0.5.2",
    startedAt: "2026-10-22T10:00:00.000Z",
    state,
    peers: [],
    self: { state: "pending" },
  };
}

async function harness(
  opts: { running?: boolean; prepare?: () => Promise<PreparedRelease> } = {},
) {
  const upgradesDir = await mkdtemp(path.join(tmpdir(), "hf-fleet-"));
  dirs.push(upgradesDir);
  const dir = path.join(upgradesDir, "0.5.2");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, manifestFileName("0.5.2")), "MANIFEST");
  await writeFile(path.join(dir, signatureFileName("0.5.2")), "SIG\n");
  const prepared = { version: "0.5.2" } as PreparedRelease;
  const calls = {
    start: [] as RolloutStartInput[],
    prepare: [] as string[],
    self: [] as unknown[],
  };
  let current: RolloutStatus | undefined = opts.running
    ? status("running")
    : undefined;
  const surface = createFleetUpgradeSurface({
    rollout: {
      start: async (input) => {
        calls.start.push(input);
        current = status("running");
        return current;
      },
      status: () => current,
    },
    coordinator: {
      check: async () => ({
        current: "0.5.0",
        latest: "0.5.2",
        available: true,
      }),
      upgradeSelf: async (input) => {
        calls.self.push(input);
        return { from: "0.5.0", to: "0.5.2" };
      },
    },
    pairedDeviceIds: () => [PEER],
    prepare:
      opts.prepare ??
      (async (version) => {
        calls.prepare.push(version);
        return prepared;
      }),
    upgradesDir,
  });
  return { surface, calls };
}

test("a self request goes straight to the coordinator", async () => {
  const { surface, calls } = await harness();
  await expect(
    surface.upgrade({ targets: "self", version: "0.5.2", force: true }),
  ).resolves.toEqual({ from: "0.5.0", to: "0.5.2" });
  expect(calls.self).toEqual([{ version: "0.5.2", force: true }]);
  expect(calls.start).toEqual([]);
});

test("a fleet request resolves latest, prepares, and pushes the cached bytes", async () => {
  const { surface, calls } = await harness();
  const result = await surface.upgrade({ targets: "fleet", forceLocal: true });
  expect(result).toMatchObject({ state: "running" });
  expect(calls.prepare).toEqual(["0.5.2"]);
  expect(calls.start).toHaveLength(1);
  expect(calls.start[0]?.manifestBytes.toString()).toBe("MANIFEST");
  expect(calls.start[0]?.signature).toBe("SIG");
  expect(calls.start[0]?.forceLocal).toBe(true);
  expect(calls.start[0]?.nodes).toBeUndefined();
  expect(surface.upgrades()?.state).toBe("running");
});

test("a second start while a rollout runs is refused as locked and touches nothing", async () => {
  const { surface, calls } = await harness({ running: true });
  const error = await surface
    .upgrade({ targets: "fleet" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  expect((error as UpgradeError).code).toBe("locked");
  expect(calls.prepare).toEqual([]);
  expect(calls.start).toEqual([]);
  expect(surface.upgrades()?.id).toBe("r1");
});

test("two overlapping starts: the second is locked while the first is still preparing", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { surface, calls } = await harness({
    prepare: async () => {
      await gate;
      return { version: "0.5.2" } as PreparedRelease;
    },
  });
  const first = surface.upgrade({ targets: "fleet" });
  await expect(surface.upgrade({ targets: "fleet" })).rejects.toMatchObject({
    code: "locked",
  });
  release?.();
  await first;
  expect(calls.start).toHaveLength(1);
});

test("an unknown device id is refused before anything is prepared", async () => {
  const { surface, calls } = await harness();
  const error = await surface
    .upgrade({ targets: [PEER, "c".repeat(64)] })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "unknown-node" });
  expect((error as Error).message).toContain("c".repeat(64));
  expect((error as Error).message).not.toContain(PEER);
  expect(calls.prepare).toEqual([]);
  expect(calls.start).toEqual([]);
});

test("paired device ids are passed to the rollout as nodes", async () => {
  const { surface, calls } = await harness();
  await surface.upgrade({ targets: [PEER], version: "0.5.2" });
  expect(calls.start[0]?.nodes).toEqual([PEER]);
});

test("a prepare failure surfaces as its UpgradeError and frees the lock", async () => {
  let fail = true;
  const { surface, calls } = await harness({
    prepare: async () => {
      if (fail) {
        throw new UpgradeError("verify-failed", "bad signature");
      }
      return { version: "0.5.2" } as PreparedRelease;
    },
  });
  await expect(surface.upgrade({ targets: "fleet" })).rejects.toMatchObject({
    code: "verify-failed",
  });
  fail = false;
  await surface.upgrade({ targets: "fleet" });
  expect(calls.start).toHaveLength(1);
});
