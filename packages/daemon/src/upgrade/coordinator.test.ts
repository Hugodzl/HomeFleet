import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  UpgradeCoordinator,
  type UpgradeCoordinatorOptions,
} from "./coordinator.js";
import { UpgradeError } from "./errors.js";
import {
  STATE_FILE,
  UPDATER_FILE,
  type UpgradeState,
  upgradesDir,
} from "./files.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./test-release.js";

const INSTALLED_ENTRY =
  "/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup(
  overrides: Partial<UpgradeCoordinatorOptions> = {},
  releases = ["0.5.0", "0.5.1"],
) {
  const root = await mkdtemp(path.join(tmpdir(), "hf-coord-"));
  roots.push(root);
  const origin = path.join(root, "origin");
  const keys = makeTestKeys();
  for (const version of releases)
    await writeSignedRelease(origin, version, keys);
  const source = new FakeReleaseSource(origin, "0.5.1");
  const spawned: Array<{ updaterPath: string; statePath: string }> = [];
  const shutdowns: string[] = [];
  const coordinator = new UpgradeCoordinator({
    dataDir: root,
    currentVersion: "0.5.0",
    localHfpVersion: "0.3.0",
    source,
    activeJobs: () => 0,
    controlEndpoint: () => ({ host: "127.0.0.1", port: 56373 }),
    requestShutdown: (reason) => shutdowns.push(reason),
    spawnUpdater: (updaterPath, statePath) =>
      spawned.push({ updaterPath, statePath }),
    runtime: {
      pid: 4242,
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", INSTALLED_ENTRY, "--x"],
      platform: "linux",
    },
    publicKeys: [keys.publicKey],
    shutdownDelayMs: 0,
    ...overrides,
  });
  return { root, source, coordinator, spawned, shutdowns };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  return (error as UpgradeError).code;
}

test("check reports an available upgrade", async () => {
  const { coordinator } = await setup();
  await expect(coordinator.check()).resolves.toEqual({
    current: "0.5.0",
    latest: "0.5.1",
    available: true,
  });
});

test("upgradeSelf prepares, writes state, spawns the updater, then requests shutdown", async () => {
  const { root, coordinator, spawned, shutdowns } = await setup();
  await expect(coordinator.upgradeSelf({})).resolves.toEqual({
    from: "0.5.0",
    to: "0.5.1",
  });

  const dir = upgradesDir(root);
  expect(spawned).toEqual([
    {
      updaterPath: path.join(dir, UPDATER_FILE),
      statePath: path.join(dir, STATE_FILE),
    },
  ]);
  expect((await stat(path.join(dir, UPDATER_FILE))).size).toBeGreaterThan(0);
  const state = JSON.parse(
    await readFile(path.join(dir, STATE_FILE), "utf8"),
  ) as UpgradeState;
  expect(state).toMatchObject({
    from: "0.5.0",
    to: "0.5.1",
    daemonPid: 4242,
    nodePath: "/usr/bin/node",
    argv: [INSTALLED_ENTRY, "--x"],
    controlHost: "127.0.0.1",
    controlPort: 56373,
    installCommand: ["npm", "i", "-g"],
    dataDir: root,
  });
  expect(state.tarballPath).toBe(
    path.join(dir, "0.5.1", "homefleet-0.5.1.tgz"),
  );
  expect(state.rollbackTarballPath).toBe(
    path.join(dir, "0.5.0", "homefleet-0.5.0.tgz"),
  );
  await vi.waitFor(() => expect(shutdowns).toEqual(["upgrading to 0.5.1"]));
});

test("an explicit version wins over latest", async () => {
  const { coordinator, source } = await setup({}, ["0.5.0", "0.5.1", "0.5.2"]);
  source.latest = "0.5.2";
  await expect(
    coordinator.upgradeSelf({ version: "0.5.1" }),
  ).resolves.toMatchObject({ to: "0.5.1" });
});

test("no rollback tarball available → state has none", async () => {
  const { root, coordinator } = await setup({}, ["0.5.1"]);
  await coordinator.upgradeSelf({});
  const state = JSON.parse(
    await readFile(path.join(upgradesDir(root), STATE_FILE), "utf8"),
  ) as UpgradeState;
  expect(state.rollbackTarballPath).toBeUndefined();
});

test("windows uses npm.cmd", async () => {
  const { root, coordinator } = await setup({
    runtime: {
      pid: 1,
      execPath: "C:\\node.exe",
      argv: [
        "C:\\node.exe",
        "C:\\Users\\h\\AppData\\Roaming\\npm\\node_modules\\homefleet\\dist\\bin\\homefleetd.js",
      ],
      platform: "win32",
    },
  });
  await coordinator.upgradeSelf({});
  const state = JSON.parse(
    await readFile(path.join(upgradesDir(root), STATE_FILE), "utf8"),
  ) as UpgradeState;
  expect(state.installCommand).toEqual(["npm.cmd", "i", "-g"]);
});

test("refuses without a shutdown hook", async () => {
  const { coordinator } = await setup({ requestShutdown: undefined });
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("unsupported");
});

test("already current → not-newer, without downloading", async () => {
  const { coordinator, source } = await setup();
  source.latest = "0.5.0";
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("not-newer");
  expect(source.fetchCount).toBe(0);
});

test("busy unless forced", async () => {
  const busy = await setup({ activeJobs: () => 1 });
  expect(await codeOf(busy.coordinator.upgradeSelf({}))).toBe("busy");
  const forced = await setup({ activeJobs: () => 1 });
  await expect(
    forced.coordinator.upgradeSelf({ force: true }),
  ).resolves.toMatchObject({ to: "0.5.1" });
});

test("checkout-run daemon → not-installed, nothing spawned", async () => {
  const { coordinator, spawned } = await setup({
    runtime: {
      pid: 1,
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", "/src/packages/daemon/dist/bin/homefleetd.js"],
      platform: "linux",
    },
  });
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("not-installed");
  expect(spawned).toEqual([]);
});

test("untrusted release → verify-failed", async () => {
  const { coordinator } = await setup({
    publicKeys: [makeTestKeys().publicKey],
  });
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("verify-failed");
});

test("a second upgrade in the same process → locked", async () => {
  const { coordinator } = await setup();
  await coordinator.upgradeSelf({});
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("locked");
});
