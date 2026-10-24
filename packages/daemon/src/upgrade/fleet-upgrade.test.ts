import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NodeInfo } from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { HfpRequestError } from "../transport/client.js";
import { UpgradeError } from "./errors.js";
import {
  readRolloutStatusSync,
  readUpgradeResultSync,
  writeRolloutStatus,
} from "./files.js";
import {
  createFleetUpgradeSurface,
  type FleetUpgradeSurfaceOptions,
} from "./fleet-upgrade.js";
import { manifestFileName, signatureFileName } from "./manifest.js";
import type { PreparedRelease } from "./prepare.js";
import {
  FleetRollout,
  type RolloutStartInput,
  type RolloutStatus,
  restoreRolloutStatus,
} from "./rollout.js";

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
  opts: {
    running?: boolean;
    prepare?: () => Promise<PreparedRelease>;
    rollout?: FleetUpgradeSurfaceOptions["rollout"];
  } = {},
) {
  const upgradesDir = await mkdtemp(path.join(tmpdir(), "hf-fleet-"));
  dirs.push(upgradesDir);
  const dir = path.join(upgradesDir, "0.5.2");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, manifestFileName("0.5.2")), "MANIFEST");
  await writeFile(path.join(dir, signatureFileName("0.5.2")), "SIG\n");
  const prepared = {
    version: "0.5.2",
    manifest: { size: 4096 },
  } as PreparedRelease;
  const calls = {
    start: [] as RolloutStartInput[],
    prepare: [] as string[],
    self: [] as unknown[],
    check: 0,
  };
  let current: RolloutStatus | undefined = opts.running
    ? status("running")
    : undefined;
  const surface = createFleetUpgradeSurface({
    rollout: opts.rollout ?? {
      start: async (input) => {
        calls.start.push(input);
        current = status("running");
        return current;
      },
      status: () => current,
    },
    coordinator: {
      check: async () => {
        calls.check += 1;
        return {
          current: "0.5.0",
          latest: "0.5.2",
          available: true,
        };
      },
      upgradeSelf: async (input) => {
        calls.self.push(input);
        return { from: "0.5.0", to: "0.5.2" };
      },
    },
    currentVersion: "0.5.1",
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

test("includeSelf is forwarded to the rollout, and absent by default", async () => {
  const { surface, calls } = await harness();
  await surface.upgrade({ targets: "fleet", includeSelf: false });
  expect(calls.start[0]?.includeSelf).toBe(false);
  const other = await harness();
  await other.surface.upgrade({ targets: "fleet" });
  expect(other.calls.start[0]).not.toHaveProperty("includeSelf");
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

test("a self request is refused as locked while a fleet rollout runs", async () => {
  const { surface, calls } = await harness({ running: true });
  const error = await surface
    .upgrade({ targets: "self" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  expect((error as UpgradeError).code).toBe("locked");
  expect(calls.self).toEqual([]);
});

test("a self request is refused as locked while a fleet rollout is still starting", async () => {
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
  await expect(surface.upgrade({ targets: "self" })).rejects.toMatchObject({
    code: "locked",
  });
  expect(calls.self).toEqual([]);
  release?.();
  await first;
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

test("the final rollout survives this node's restart: written at handoff, served (settled) after", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hf-fleet-data-"));
  dirs.push(dataDir);
  const peerEntry = {
    deviceId: PEER,
    name: "tower",
    host: "127.0.0.1",
    port: 1,
    reachable: true,
    nodeInfo: { daemonVersion: "0.5.0" } as NodeInfo,
  };
  const makeRollout = (currentVersion: string) =>
    new FleetRollout({
      peers: {
        list: async () => [peerEntry],
        push: async () => {
          throw new HfpRequestError(
            403,
            { code: "UPGRADE_DISABLED", message: "remote upgrades are off" },
            "forbidden",
          );
        },
        hello: async () => undefined,
      },
      currentVersion,
      upgradeSelf: async () => ({ from: "0.5.0", to: "0.5.2" }),
      persist: (s) => writeRolloutStatus(dataDir, s),
      previous: () => {
        const saved = readRolloutStatusSync(dataDir);
        return (
          saved &&
          restoreRolloutStatus(saved, {
            daemonVersion: currentVersion,
            lastUpgrade: readUpgradeResultSync(dataDir),
          })
        );
      },
    });

  // Before the restart: the peer refuses fast, self hands off.
  const before = makeRollout("0.5.0");
  await before.start({
    prepared: { version: "0.5.2" } as PreparedRelease,
    manifestBytes: Buffer.from("m"),
    signature: "s",
  });
  for (
    let i = 0;
    i < 200 && readRolloutStatusSync(dataDir) === undefined;
    i++
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(readRolloutStatusSync(dataDir)?.self.state).toBe("restarting");

  // After it: a fresh daemon on 0.5.2 serves the saved rollout, settled.
  const after = makeRollout("0.5.2");
  const { surface, calls } = await harness({ rollout: after });
  expect(surface.upgrades()).toMatchObject({
    state: "done",
    peers: [
      { name: "tower", state: "refused", reason: "remote upgrades are off" },
    ],
    self: { state: "succeeded" },
  });
  // ...and it does not count as a running rollout.
  await expect(surface.upgrade({ targets: "fleet" })).resolves.toBeDefined();
  expect(calls.prepare).toEqual(["0.5.2"]);
  await after.abort(); // let the new loop's save land before the temp dir goes
});

test("prepare({}) resolves latest, prepares once, and reports the verified release", async () => {
  const { surface, calls } = await harness();
  await expect(surface.prepare({})).resolves.toEqual({
    current: "0.5.1",
    target: "0.5.2",
    verified: true,
    size: 4096,
  });
  expect(calls.prepare).toEqual(["0.5.2"]);
  expect(calls.start).toEqual([]);
});

test("prepare({version}) prepares exactly that version", async () => {
  const { surface, calls } = await harness();
  await surface.prepare({ version: "0.5.2" });
  expect(calls.prepare).toEqual(["0.5.2"]);
});

test("prepare() rejects with the verify-failed code from the prepare step", async () => {
  const { surface } = await harness({
    prepare: async () => {
      throw new UpgradeError("verify-failed", "bad signature");
    },
  });
  await expect(surface.prepare({})).rejects.toMatchObject({
    code: "verify-failed",
  });
});

test("a fleet upgrade after prepare() reuses the verified cache (one download)", async () => {
  let downloads = 0;
  const cached = new Set<string>();
  const prepared = {
    version: "0.5.2",
    manifest: { size: 4096 },
  } as PreparedRelease;
  const { surface, calls } = await harness({
    prepare: async () => {
      if (!cached.has("0.5.2")) {
        downloads += 1;
        cached.add("0.5.2");
      }
      return prepared;
    },
  });
  await surface.prepare({});
  await surface.upgrade({ targets: "fleet" });
  expect(downloads).toBe(1);
  expect(calls.start).toHaveLength(1);
});

test("an explicit version never needs a release lookup (prepare or fleet upgrade)", async () => {
  const { surface, calls } = await harness();
  await surface.prepare({ version: "0.5.2" });
  await surface.upgrade({ targets: "fleet", version: "0.5.2" });
  expect(calls.check).toBe(0);
  expect(calls.prepare).toEqual(["0.5.2", "0.5.2"]);
});

test("without a version the latest is looked up once; current is the option", async () => {
  const { surface, calls } = await harness();
  await expect(surface.prepare({})).resolves.toMatchObject({
    current: "0.5.1",
    target: "0.5.2",
  });
  expect(calls.check).toBe(1);
  expect(calls.prepare).toEqual(["0.5.2"]);
});
