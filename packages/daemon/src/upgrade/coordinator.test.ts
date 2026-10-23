import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpgradeRequest as HfpUpgradeRequest } from "@homefleet/protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { HfpTarget } from "../transport/client.js";
import {
  UpgradeCoordinator,
  type UpgradeCoordinatorOptions,
} from "./coordinator.js";
import { UpgradeError } from "./errors.js";
import {
  readUpgradeResultSync,
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
  return { root, origin, keys, source, coordinator, spawned, shutdowns };
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

// --- acceptRemote (fleet push) ---

const PEER: HfpTarget = {
  host: "10.0.0.2",
  port: 7001,
  expectedDeviceId: "peer-1",
};

async function pushOf(
  origin: string,
  keys: ReturnType<typeof makeTestKeys>,
  version: string,
  releaseDir = origin,
): Promise<HfpUpgradeRequest> {
  const release = await writeSignedRelease(releaseDir, version, keys);
  return {
    version,
    manifest: release.manifestBytes.toString("base64"),
    signature: release.signature,
  };
}

/** A requester that serves tarballs out of `origin`, counting fetches. */
function fakeClient(origin: string, fail = false) {
  const fetched: string[] = [];
  return {
    fetched,
    client: {
      async fetchUpgradeTarball(
        _target: HfpTarget,
        version: string,
        destPath: string,
      ) {
        fetched.push(version);
        if (fail) throw new Error("peer is gone");
        await copyFile(path.join(origin, `homefleet-${version}.tgz`), destPath);
      },
    },
  };
}

test("acceptRemote refuses when allowRemote is false", async () => {
  const { origin, keys, coordinator, spawned } = await setup({
    allowRemote: false,
  });
  const request = await pushOf(origin, keys, "0.5.1");
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request,
        requesterDeviceId: "peer-1",
        client: fakeClient(origin).client,
      }),
    ),
  ).resolves.toBe("disabled");
  expect(spawned).toEqual([]);
});

test("acceptRemote rejects a manifest signed by an unknown key", async () => {
  const { origin, source, coordinator } = await setup({ allowRemote: true });
  const request = await pushOf(origin, makeTestKeys(), "0.5.1", `${origin}-x`);
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request,
        requesterDeviceId: "peer-1",
        client: fakeClient(origin).client,
      }),
    ),
  ).resolves.toBe("verify-failed");
  expect(source.fetchCount).toBe(0);
});

test("acceptRemote rejects a not-newer push", async () => {
  const { origin, keys, coordinator } = await setup({ allowRemote: true });
  const request = await pushOf(origin, keys, "0.5.0");
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request,
        requesterDeviceId: "peer-1",
        client: fakeClient(origin).client,
      }),
    ),
  ).resolves.toBe("not-newer");
});

test("acceptRemote rejects a manifest for a different version than requested", async () => {
  const { origin, keys, coordinator } = await setup({ allowRemote: true });
  const request = {
    ...(await pushOf(origin, keys, "0.5.1")),
    version: "0.5.2",
  };
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request,
        requesterDeviceId: "peer-1",
        client: fakeClient(origin).client,
      }),
    ),
  ).resolves.toBe("verify-failed");
});

test("acceptRemote downloads from the requester first", async () => {
  const { root, origin, keys, coordinator, spawned, source } = await setup({
    allowRemote: true,
    resolvePeer: () => PEER,
  });
  const request = await pushOf(origin, keys, "0.5.1");
  const peer = fakeClient(origin);
  await expect(
    coordinator.acceptRemote({
      request,
      requesterDeviceId: "peer-1",
      client: peer.client,
    }),
  ).resolves.toEqual({ version: "0.5.1" });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  expect(peer.fetched).toEqual(["0.5.1"]);
  // Target from the peer; the rollback copy (0.5.0) from the fake GitHub.
  expect(source.fetchCount).toBe(1);
  const state = JSON.parse(
    await readFile(path.join(upgradesDir(root), STATE_FILE), "utf8"),
  ) as UpgradeState;
  expect(state.rollbackTarballPath).toBe(
    path.join(upgradesDir(root), "0.5.0", "homefleet-0.5.0.tgz"),
  );
});

test("acceptRemote falls back to GitHub when the requester is unknown", async () => {
  const { origin, keys, coordinator, spawned, source } = await setup({
    allowRemote: true,
    resolvePeer: () => undefined,
  });
  const request = await pushOf(origin, keys, "0.5.1");
  const peer = fakeClient(origin);
  await coordinator.acceptRemote({
    request,
    requesterDeviceId: "stranger",
    client: peer.client,
  });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  expect(peer.fetched).toEqual([]);
  expect(source.fetchCount).toBeGreaterThan(0);
});

test("a background failure is recorded as a failed lastUpgrade", async () => {
  // Nothing published at the fake GitHub, and the peer fails too.
  const { root, origin, keys, coordinator, spawned } = await setup(
    { allowRemote: true, resolvePeer: () => PEER },
    [],
  );
  const request = await pushOf(origin, keys, "0.5.1", `${origin}-pushed`);
  await coordinator.acceptRemote({
    request,
    requesterDeviceId: "peer-1",
    client: fakeClient(origin, true).client,
  });
  await vi.waitFor(() =>
    expect(readUpgradeResultSync(root)).toMatchObject({
      from: "0.5.0",
      to: "0.5.1",
      outcome: "failed",
    }),
  );
  expect(spawned).toEqual([]);
});

test("two back-to-back acceptRemote calls: exactly one is accepted, the other is refused with locked", async () => {
  const { origin, keys, coordinator, spawned } = await setup({
    allowRemote: true,
  });
  const request = await pushOf(origin, keys, "0.5.1");
  const args = {
    request,
    requesterDeviceId: "peer-1",
    client: fakeClient(origin).client,
  };
  // Both calls await the lock-file read, and Node doesn't finish two fs
  // reads in start order, so EITHER call may win. The guarantee is that
  // exactly one does.
  const results = await Promise.allSettled([
    coordinator.acceptRemote(args),
    coordinator.acceptRemote(args),
  ]);
  const accepted = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected");
  expect(accepted).toHaveLength(1);
  expect((accepted[0] as PromiseFulfilledResult<unknown>).value).toEqual({
    version: "0.5.1",
  });
  expect(refused).toHaveLength(1);
  const reason = (refused[0] as PromiseRejectedResult).reason;
  expect(reason).toBeInstanceOf(UpgradeError);
  expect((reason as UpgradeError).code).toBe("locked");
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
});

test("acceptRemote while a live lock file exists → locked", async () => {
  const { root, origin, keys, coordinator } = await setup({
    allowRemote: true,
  });
  const dir = upgradesDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "upgrade.lock"),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  );
  const request = await pushOf(origin, keys, "0.5.1");
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request,
        requesterDeviceId: "peer-1",
        client: fakeClient(origin).client,
      }),
    ),
  ).resolves.toBe("locked");
});

test("upgradeSelf during a pending remote run → locked", async () => {
  const { origin, keys, coordinator, spawned } = await setup({
    allowRemote: true,
  });
  const request = await pushOf(origin, keys, "0.5.1");
  await coordinator.acceptRemote({
    request,
    requesterDeviceId: "peer-1",
    client: fakeClient(origin).client,
  });
  await expect(codeOf(coordinator.upgradeSelf({}))).resolves.toBe("locked");
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
});

/** Wraps a source so its first `fetchRelease` waits on a gate (a slow download). */
function gatedSource(inner: FakeReleaseSource) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered!: () => void;
  const downloading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let gated = false;
  return {
    open,
    downloading,
    source: {
      latestVersion: () => inner.latestVersion(),
      async fetchRelease(version: string, destDir: string) {
        if (!gated) {
          gated = true;
          entered();
          await gate;
        }
        return inner.fetchRelease(version, destDir);
      },
    },
  };
}

test("remote push during a local upgrade mid-download → locked", async () => {
  const { origin, keys, source, coordinator, spawned } = await setup({
    allowRemote: true,
  });
  const gated = gatedSource(source);
  const local = coordinator.upgradeSelf({ source: gated.source });
  await gated.downloading;
  const request = await pushOf(origin, keys, "0.5.1");
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request,
        requesterDeviceId: "peer-1",
        client: fakeClient(origin).client,
      }),
    ),
  ).resolves.toBe("locked");
  gated.open();
  await expect(local).resolves.toEqual({ from: "0.5.0", to: "0.5.1" });
  expect(spawned).toHaveLength(1);
});

test("two overlapping upgradeSelf calls → second locked", async () => {
  const { source, coordinator, spawned } = await setup();
  const gated = gatedSource(source);
  const first = coordinator.upgradeSelf({ source: gated.source });
  await gated.downloading;
  await expect(codeOf(coordinator.upgradeSelf({}))).resolves.toBe("locked");
  gated.open();
  await expect(first).resolves.toEqual({ from: "0.5.0", to: "0.5.1" });
  expect(spawned).toHaveLength(1);
});

test("a failed local upgrade frees the node for the next one", async () => {
  const { coordinator, source } = await setup();
  source.latest = "0.5.0";
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("not-newer");
  source.latest = "0.5.1";
  await expect(coordinator.upgradeSelf({})).resolves.toMatchObject({
    to: "0.5.1",
  });
});
