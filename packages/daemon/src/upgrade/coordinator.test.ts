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
import { hashFile } from "./manifest.js";
import {
  prepareRelease,
  RELEASES_DIRNAME,
  readVerifiedCache,
} from "./prepare.js";
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

/** `file` is `<upgradesDir>/releases/<sha256>/<name>`. */
function expectCached(
  file: string | undefined,
  dir: string,
  name: string,
): void {
  expect(file).toBeDefined();
  const entry = path.dirname(file ?? "");
  expect(path.dirname(entry)).toBe(path.join(dir, RELEASES_DIRNAME));
  expect(path.basename(entry)).toMatch(/^[0-9a-f]{64}$/);
  expect(path.basename(file ?? "")).toBe(name);
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
  await expect(coordinator.upgradeSelf({})).resolves.toMatchObject({
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
  expectCached(state.tarballPath, dir, "homefleet-0.5.1.tgz");
  expectCached(state.rollbackTarballPath, dir, "homefleet-0.5.0.tgz");
  expect(state.toSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(state.rollbackTarballPath).not.toBe(state.tarballPath);
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
  expectCached(
    state.rollbackTarballPath,
    upgradesDir(root),
    "homefleet-0.5.0.tgz",
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
  await expect(local).resolves.toMatchObject({ from: "0.5.0", to: "0.5.1" });
  expect(spawned).toHaveLength(1);
});

test("two overlapping upgradeSelf calls → second locked", async () => {
  const { source, coordinator, spawned } = await setup();
  const gated = gatedSource(source);
  const first = coordinator.upgradeSelf({ source: gated.source });
  await gated.downloading;
  await expect(codeOf(coordinator.upgradeSelf({}))).resolves.toBe("locked");
  gated.open();
  await expect(first).resolves.toMatchObject({ from: "0.5.0", to: "0.5.1" });
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

test("upgradeSelf is refused locked while the daemon is shutting down, before any download", async () => {
  let stopping = false;
  const { coordinator, source, spawned, shutdowns } = await setup({
    isShuttingDown: () => stopping,
  });
  stopping = true;
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("locked");
  expect(source.fetchCount).toBe(0);
  expect(spawned).toEqual([]);
  expect(shutdowns).toEqual([]);
  // And not stuck: once no longer stopping, an upgrade goes through.
  stopping = false;
  await expect(coordinator.upgradeSelf({})).resolves.toMatchObject({
    to: "0.5.1",
  });
});

test("acceptRemote is refused locked while the daemon is shutting down", async () => {
  const { coordinator } = await setup({
    allowRemote: true,
    isShuttingDown: () => true,
  });
  const error = await coordinator
    .acceptRemote({
      request: {
        version: "0.5.1",
        manifest: "",
        signature: "",
      } as unknown as HfpUpgradeRequest,
      requesterDeviceId: "d".repeat(64),
      client: { fetchUpgradeTarball: vi.fn() },
    })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  expect((error as UpgradeError).code).toBe("locked");
  expect((error as UpgradeError).message).toContain("shutting down");
});

// --- release candidates ---

/**
 * A node running 0.8.0. Two signed builds of 0.8.0 exist: A (rc.1) and B
 * (rc.2); GitHub serves F under v0.8.0 (or A itself when finalIsA). 0.9.0
 * is a newer candidate's bytes.
 */
async function candidateSetup(
  opts: {
    currentSha256?: "A" | "B";
    cacheA?: boolean;
    finalIsA?: boolean;
    overrides?: Partial<UpgradeCoordinatorOptions>;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "hf-coord-rc-"));
  roots.push(root);
  const keys = makeTestKeys();
  const dirA = path.join(root, "a");
  const dirB = path.join(root, "b");
  const dirF = path.join(root, "f");
  const dirN = path.join(root, "n");
  const a = await writeSignedRelease(dirA, "0.8.0", keys, { content: "A" });
  const b = await writeSignedRelease(dirB, "0.8.0", keys, { content: "B" });
  await writeSignedRelease(dirF, "0.8.0", keys, {
    content: opts.finalIsA === true ? "A" : "F",
  });
  await writeSignedRelease(dirN, "0.9.0", keys, { content: "N" });
  const shaA = (await hashFile(a.tarballPath)).sha256;
  const shaB = (await hashFile(b.tarballPath)).sha256;
  const source = new FakeReleaseSource(dirF, "0.8.0", {
    "v0.8.0-rc.1": dirA,
    "v0.8.0-rc.2": dirB,
    "v0.7.0-rc.1": dirA,
  });
  if (opts.cacheA === true) {
    await prepareRelease({
      source: new FakeReleaseSource(dirA, "0.8.0", { "v0.8.0-rc.1": dirA }),
      upgradesDir: upgradesDir(root),
      version: "0.8.0",
      tag: "v0.8.0-rc.1",
      publicKeys: [keys.publicKey],
    });
  }
  const spawned: Array<{ updaterPath: string; statePath: string }> = [];
  const currentSha256 =
    opts.currentSha256 === "A"
      ? shaA
      : opts.currentSha256 === "B"
        ? shaB
        : undefined;
  const coordinator = new UpgradeCoordinator({
    dataDir: root,
    currentVersion: "0.8.0",
    ...(currentSha256 !== undefined ? { currentSha256 } : {}),
    localHfpVersion: "0.3.0",
    source,
    activeJobs: () => 0,
    controlEndpoint: () => ({ host: "127.0.0.1", port: 56373 }),
    requestShutdown: () => undefined,
    spawnUpdater: (updaterPath, statePath) =>
      spawned.push({ updaterPath, statePath }),
    runtime: {
      pid: 4242,
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", INSTALLED_ENTRY],
      platform: "linux",
    },
    publicKeys: [keys.publicKey],
    shutdownDelayMs: 0,
    allowRemote: true,
    resolvePeer: () => PEER,
    ...opts.overrides,
  });
  const readState = async () =>
    JSON.parse(
      await readFile(path.join(upgradesDir(root), STATE_FILE), "utf8"),
    ) as UpgradeState;
  /** A push of the release in dir, a candidate push unless told otherwise. */
  const push = async (
    dir: string,
    version: string,
    candidate = true,
  ): Promise<HfpUpgradeRequest> => {
    const manifestBytes = await readFile(
      path.join(dir, `homefleet-${version}.manifest.json`),
    );
    const signature = (
      await readFile(
        path.join(dir, `homefleet-${version}.manifest.sig`),
        "utf8",
      )
    ).trim();
    return {
      version,
      manifest: manifestBytes.toString("base64"),
      signature,
      ...(candidate ? { candidate: true } : {}),
    };
  };
  return {
    root,
    keys,
    source,
    coordinator,
    spawned,
    shaA,
    shaB,
    dirA,
    dirB,
    dirN,
    readState,
    push,
  };
}

test("candidate self: same version, different hash → state has candidate, toSha256, fromSha256 and the rollback copy from the cache by hash", async () => {
  const { root, coordinator, readState, shaA, shaB, spawned } =
    await candidateSetup({ currentSha256: "A", cacheA: true });
  await expect(
    coordinator.upgradeSelf({ candidate: { tag: "v0.8.0-rc.2" } }),
  ).resolves.toEqual({
    from: "0.8.0",
    to: "0.8.0",
    sha256: shaB,
    candidate: true,
  });
  expect(spawned).toHaveLength(1);
  const state = await readState();
  expect(state).toMatchObject({
    from: "0.8.0",
    to: "0.8.0",
    candidate: true,
    toSha256: shaB,
    fromSha256: shaA,
  });
  expect(state.rollbackTarballPath).toBe(
    path.join(upgradesDir(root), RELEASES_DIRNAME, shaA, "homefleet-0.8.0.tgz"),
  );
});

test("candidate self: same version, own hash unknown → proceeds with no rollback copy", async () => {
  const { coordinator, readState } = await candidateSetup({ cacheA: true });
  await coordinator.upgradeSelf({ candidate: { tag: "v0.8.0-rc.2" } });
  const state = await readState();
  expect(state.candidate).toBe(true);
  expect(state.fromSha256).toBeUndefined();
  expect(state.rollbackTarballPath).toBeUndefined();
});

test("candidate self: same hash → same-release, nothing spawned", async () => {
  const { coordinator, spawned } = await candidateSetup({
    currentSha256: "B",
  });
  await expect(
    codeOf(coordinator.upgradeSelf({ candidate: { tag: "v0.8.0-rc.2" } })),
  ).resolves.toBe("same-release");
  expect(spawned).toEqual([]);
});

test("candidate self by hash: the running hash → same-release before any download", async () => {
  const { coordinator, source, shaB } = await candidateSetup({
    currentSha256: "B",
  });
  await expect(
    codeOf(
      coordinator.upgradeSelf({
        version: "0.8.0",
        candidate: { sha256: shaB },
      }),
    ),
  ).resolves.toBe("same-release");
  expect(source.fetchCount).toBe(0);
});

test("candidate self: an older tag → not-newer before any download", async () => {
  const { coordinator, source } = await candidateSetup();
  await expect(
    codeOf(coordinator.upgradeSelf({ candidate: { tag: "v0.7.0-rc.1" } })),
  ).resolves.toBe("not-newer");
  expect(source.fetchCount).toBe(0);
});

test("plain self to the same version is still not-newer", async () => {
  const { coordinator, source } = await candidateSetup({ currentSha256: "A" });
  await expect(
    codeOf(coordinator.upgradeSelf({ version: "0.8.0" })),
  ).resolves.toBe("not-newer");
  expect(source.fetchCount).toBe(0);
});

test("pushed candidate: same version, different hash → accepted; the target comes from the peer only", async () => {
  const { coordinator, source, spawned, readState, push, dirB, shaA, shaB } =
    await candidateSetup({ currentSha256: "A", cacheA: true });
  const peer = fakeClient(dirB);
  await expect(
    coordinator.acceptRemote({
      request: await push(dirB, "0.8.0"),
      requesterDeviceId: "peer-1",
      client: peer.client,
    }),
  ).resolves.toEqual({ version: "0.8.0" });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  expect(peer.fetched).toEqual(["0.8.0"]);
  expect(source.fetchCount).toBe(0); // the rollback copy A came from the cache
  expect(await readState()).toMatchObject({
    candidate: true,
    toSha256: shaB,
    fromSha256: shaA,
  });
});

test("pushed candidate: when the peer fetch fails the own source is never asked for it, and lastUpgrade records failed", async () => {
  const { root, coordinator, source, spawned, push, dirB } =
    await candidateSetup({ currentSha256: "A", cacheA: true });
  await coordinator.acceptRemote({
    request: await push(dirB, "0.8.0"),
    requesterDeviceId: "peer-1",
    client: fakeClient(dirB, true).client,
  });
  await vi.waitFor(() =>
    expect(readUpgradeResultSync(root)).toMatchObject({
      to: "0.8.0",
      outcome: "failed",
    }),
  );
  expect(source.fetchCount).toBe(0);
  expect(spawned).toEqual([]);
});

test("pushed candidate of a newer version, own hash unknown → the rollback copy of the running version comes from the own source by version", async () => {
  const { coordinator, source, spawned, readState, push, dirN } =
    await candidateSetup();
  await coordinator.acceptRemote({
    request: await push(dirN, "0.9.0"),
    requesterDeviceId: "peer-1",
    client: fakeClient(dirN).client,
  });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  expect(source.tags).toEqual(["v0.8.0"]);
  const state = await readState();
  expect(state.rollbackTarballPath).toMatch(/homefleet-0\.8\.0\.tgz$/);
  expect(state.fromSha256).toBeUndefined();
});

test("pushed candidate of a newer version, own hash known → the rollback copy comes from the cache by hash", async () => {
  const { coordinator, source, spawned, readState, push, dirN, shaA } =
    await candidateSetup({ currentSha256: "A", cacheA: true });
  await coordinator.acceptRemote({
    request: await push(dirN, "0.9.0"),
    requesterDeviceId: "peer-1",
    client: fakeClient(dirN).client,
  });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  expect(source.fetchCount).toBe(0);
  const state = await readState();
  expect(state.rollbackTarballPath).toContain(shaA);
  expect(state.fromSha256).toBe(shaA);
});

test("pushed candidate of a newer version, own hash known but not cached → the own source's copy is refused if its hash differs", async () => {
  const { coordinator, source, spawned, readState, push, dirN } =
    await candidateSetup({ currentSha256: "A" });
  await coordinator.acceptRemote({
    request: await push(dirN, "0.9.0"),
    requesterDeviceId: "peer-1",
    client: fakeClient(dirN).client,
  });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  expect(source.fetchCount).toBe(1); // asked, got F, refused it
  expect((await readState()).rollbackTarballPath).toBeUndefined();
});

test("pushed candidate with no address for the requester → refused before replying (fetch-failed)", async () => {
  const { coordinator, source, push, dirB } = await candidateSetup({
    currentSha256: "A",
    overrides: { resolvePeer: () => undefined },
  });
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request: await push(dirB, "0.8.0"),
        requesterDeviceId: "stranger",
        client: fakeClient(dirB).client,
      }),
    ),
  ).resolves.toBe("fetch-failed");
  expect(source.fetchCount).toBe(0);
});

test("pushed candidate, same hash → same-release before replying", async () => {
  const { coordinator, push, dirB } = await candidateSetup({
    currentSha256: "B",
  });
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request: await push(dirB, "0.8.0"),
        requesterDeviceId: "peer-1",
        client: fakeClient(dirB).client,
      }),
    ),
  ).resolves.toBe("same-release");
});

test("a push without the candidate field to the same version → not-newer", async () => {
  const { coordinator, push, dirB } = await candidateSetup({
    currentSha256: "A",
  });
  await expect(
    codeOf(
      coordinator.acceptRemote({
        request: await push(dirB, "0.8.0", false),
        requesterDeviceId: "peer-1",
        client: fakeClient(dirB).client,
      }),
    ),
  ).resolves.toBe("not-newer");
});

test("a plain push caches the pushed bytes without the final tag", async () => {
  const { root, keys, coordinator, spawned, push, dirN } =
    await candidateSetup();
  await coordinator.acceptRemote({
    request: await push(dirN, "0.9.0", false),
    requesterDeviceId: "peer-1",
    client: fakeClient(dirN).client,
  });
  await vi.waitFor(() => expect(spawned).toHaveLength(1));
  // Found by hash, never by a plain by-version lookup.
  expect(
    await readVerifiedCache(upgradesDir(root), { version: "0.9.0" }, [
      keys.publicKey,
    ]),
  ).toBeUndefined();
});
