/**
 * Two real in-process daemons prove the upgrade HFP routes end to end: A (the
 * requester) caches a signed release and pushes it to B (the peer), which
 * verifies it with its own key and pulls the tarball back from A over the
 * pinned HFP client — falling back to its own (fake) GitHub source when it
 * has no endpoint for A. The tarball route's refusals are pinned here too:
 * it must never serve anything `readVerifiedCache` does not confirm.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UpgradeAcceptedSchema } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { ControlClient } from "../cli/control-client.js";
import { resolveDataDir } from "../config/paths.js";
import { Daemon, type DaemonOptions } from "../daemon.js";
import { createDaemonHarness, HOST } from "../test-fixtures.js";
import { HfpRequestError } from "../transport/client.js";
import { STATE_FILE, upgradesDir } from "./files.js";
import {
  manifestFileName,
  releaseFileName,
  signatureFileName,
} from "./manifest.js";
import { prepareRelease } from "./prepare.js";
import type { RolloutStatus } from "./rollout.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./test-release.js";

const h = createDaemonHarness({ tempPrefix: "homefleet-upgrade-routes" });
const keys = makeTestKeys();
const VERSION = "0.5.1";

/**
 * Records which versions were fetched: the coordinator also fetches the
 * CURRENT version for the rollback copy (never from the peer), which is not
 * what these tests are about.
 */
class RecordingSource extends FakeReleaseSource {
  readonly fetched: string[] = [];

  override async fetchRelease(version: string, destDir: string) {
    this.fetched.push(version);
    return super.fetchRelease(version, destDir);
  }
}

interface Node {
  daemon: Daemon;
  dataDir: string;
  source: RecordingSource;
  spawned: string[];
  shutdowns: string[];
}

async function startNode(
  name: string,
  originDir: string,
  overrides: Record<string, unknown> = {},
  existing: { dataDir: string; version: string } | undefined = undefined,
): Promise<Node> {
  const dataDir =
    existing?.dataDir ??
    resolveDataDir({
      HOMEFLEET_DATA_DIR: await h.tempDir(`homefleet-upgrade-routes-${name}-`),
    });
  const source = new RecordingSource(originDir, VERSION);
  const spawned: string[] = [];
  const shutdowns: string[] = [];
  const options: DaemonOptions = {
    dataDir,
    config: h.testConfig(name, overrides),
    releaseSource: source,
    requestShutdown: (reason) => shutdowns.push(reason),
    daemonVersion: existing?.version ?? "0.5.0",
    upgradeSeams: {
      publicKeys: [keys.publicKey],
      shutdownDelayMs: 0,
      spawnUpdater: (_updater, statePath) => spawned.push(statePath),
      runtime: {
        pid: 4242,
        execPath: process.execPath,
        argv: [
          process.execPath,
          "/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js",
        ],
        platform: process.platform,
      },
    },
  };
  const daemon = new Daemon(options);
  await daemon.start();
  h.onCleanup(() => daemon.stop());
  return { daemon, dataDir, source, spawned, shutdowns };
}

/** A requester A with 0.5.1 cached, and a peer B; paired A -> B. */
async function setup(
  peerOverrides: Record<string, unknown> = { upgrade: { allowRemote: true } },
) {
  const originDir = await h.tempDir("homefleet-upgrade-routes-origin-");
  await writeSignedRelease(originDir, VERSION, keys);
  const a = await startNode("requester", originDir);
  const b = await startNode("peer", originDir, peerOverrides);
  await h.pair(a.daemon, b.daemon);
  await prepareRelease({
    source: new FakeReleaseSource(originDir, VERSION),
    upgradesDir: upgradesDir(a.dataDir),
    version: VERSION,
    publicKeys: [keys.publicKey],
  });
  return { a, b };
}

async function pushBody(a: Node, tamper = false) {
  const dir = path.join(upgradesDir(a.dataDir), VERSION);
  let manifest = await readFile(path.join(dir, manifestFileName(VERSION)));
  if (tamper) {
    manifest = Buffer.concat([manifest, Buffer.from(" ")]);
  }
  const signature = (
    await readFile(path.join(dir, signatureFileName(VERSION)), "utf8")
  ).trim();
  return {
    version: VERSION,
    manifest: manifest.toString("base64"),
    signature,
  };
}

function push(a: Node, b: Node, body: unknown) {
  return a.daemon.hfpClient.request({
    host: HOST,
    port: b.daemon.hfpPort,
    expectedDeviceId: b.daemon.deviceId,
    method: "POST",
    path: "/upgrade",
    body,
    responseSchema: UpgradeAcceptedSchema,
  });
}

function seedRequesterEndpoint(a: Node, b: Node) {
  return b.daemon.knownNodes.record({
    deviceId: a.daemon.deviceId,
    host: HOST,
    port: a.daemon.hfpPort,
    lastSeenAt: new Date().toISOString(),
    source: "static",
  });
}

test("push to a peer with allowRemote false -> 403 UPGRADE_DISABLED", async () => {
  const { a, b } = await setup({});
  const error = await push(a, b, await pushBody(a)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HfpRequestError);
  expect((error as HfpRequestError).status).toBe(403);
  expect((error as HfpRequestError).hfpError?.code).toBe("UPGRADE_DISABLED");
});

test("push with a tampered manifest -> 422 UPGRADE_REJECTED verify-failed", async () => {
  const { a, b } = await setup();
  const error = await push(a, b, await pushBody(a, true)).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HfpRequestError);
  expect((error as HfpRequestError).status).toBe(422);
  expect((error as HfpRequestError).hfpError?.code).toBe("UPGRADE_REJECTED");
  expect((error as HfpRequestError).hfpError?.details).toEqual({
    reason: "verify-failed",
  });
});

test("push -> 202, the peer pulls the tarball from the requester, writes state and spawns the updater", async () => {
  const { a, b } = await setup();
  await seedRequesterEndpoint(a, b);
  const accepted = await push(a, b, await pushBody(a));
  expect(accepted).toEqual({ accepted: true, version: VERSION });
  await h.waitUntil(() => b.spawned.length > 0, 10_000, "updater spawned");
  const state = JSON.parse(
    await readFile(path.join(upgradesDir(b.dataDir), STATE_FILE), "utf8"),
  ) as { to: string };
  expect(state.to).toBe(VERSION);
  expect(b.source.fetched.filter((v) => v === VERSION)).toEqual([]);
  expect(b.shutdowns.length).toBe(1);
});

test("a peer with no endpoint for the requester falls back to GitHub", async () => {
  const { a, b } = await setup();
  const accepted = await push(a, b, await pushBody(a));
  expect(accepted.accepted).toBe(true);
  await h.waitUntil(() => b.spawned.length > 0, 10_000, "updater spawned");
  expect(b.source.fetched).toContain(VERSION);
});

test("the tarball route refuses unverified or non-semver versions and serves verified bytes", async () => {
  const { a, b } = await setup();
  const target = {
    host: HOST,
    port: a.daemon.hfpPort,
    expectedDeviceId: a.daemon.deviceId,
  };
  const dest = path.join(await h.tempDir("homefleet-upgrade-routes-dl-"), "t");
  const status = async (version: string): Promise<number | undefined> => {
    try {
      await b.daemon.hfpClient.fetchUpgradeTarball(target, version, dest, {
        maxBytes: 1_000_000,
      });
      return 200;
    } catch (error) {
      return error instanceof HfpRequestError ? error.status : undefined;
    }
  };

  expect(await status("latest")).toBe(404);
  expect(await status("0.9.9")).toBe(404);
  expect(await status(VERSION)).toBe(200);
  expect(await readFile(dest, "utf8")).toBe(`fake tarball ${VERSION}`);

  const cached = path.join(
    upgradesDir(a.dataDir),
    VERSION,
    releaseFileName(VERSION),
  );
  await writeFile(cached, "corrupted");
  expect(await status(VERSION)).toBe(404);
});

test("B advertises upgrade.allowRemote in its node info", async () => {
  const { b } = await setup();
  expect(b.daemon.nodeInfo().upgrade).toEqual({ allowRemote: true });
});

/** `upgrade()` answers `{from,to}` for self and a RolloutStatus for the fleet. */
function peersOf(started: object) {
  expect(started).toHaveProperty("peers");
  return (started as RolloutStatus).peers;
}

function controlClientFor(daemon: Daemon): ControlClient {
  return new ControlClient({ host: HOST, port: daemon.controlPort });
}

/** Both directions seeded: A can reach B (rollout) and B can reach A (tarball). */
async function seedBoth(a: Node, b: Node) {
  await seedRequesterEndpoint(a, b);
  await a.daemon.knownNodes.record({
    deviceId: b.daemon.deviceId,
    host: HOST,
    port: b.daemon.hfpPort,
    lastSeenAt: new Date().toISOString(),
    source: "static",
  });
}

test("fleet rollout through the control API pushes the peer, then hands off self", async () => {
  const { a, b } = await setup();
  await seedBoth(a, b);
  const control = controlClientFor(a.daemon);
  const peerPort = b.daemon.hfpPort;

  const started = await control.upgrade({ targets: "fleet", version: VERSION });
  expect(started).toMatchObject({ state: "running", target: VERSION });

  await h.waitUntil(
    () => b.spawned.length > 0,
    10_000,
    "B spawned its updater",
  );
  const bState = JSON.parse(
    await readFile(path.join(upgradesDir(b.dataDir), STATE_FILE), "utf8"),
  ) as { to: string };
  expect(bState.to).toBe(VERSION);
  await h.waitUntil(
    async () => (await control.upgrades())?.peers[0]?.state === "restarting",
    10_000,
    "A shows B restarting",
  );
  // Self goes last: not before the peer is confirmed.
  expect(a.spawned).toEqual([]);

  // B's updater is fake, so simulate the restart: same data dir and HFP port,
  // new version. Windows may not release the port instantly, so retry the bind.
  await b.daemon.stop();
  let restarted: Node | undefined;
  await h.waitUntil(
    async () => {
      try {
        restarted = await startNode(
          "peer",
          "",
          {
            upgrade: { allowRemote: true },
            hfp: { host: HOST, port: peerPort },
          },
          { dataDir: b.dataDir, version: VERSION },
        );
        return true;
      } catch {
        return false;
      }
    },
    15_000,
    "B restarted on its HFP port",
  );
  expect(restarted?.daemon.hfpPort).toBe(peerPort);

  await h.waitUntil(
    async () => {
      const rollout = await control.upgrades();
      return (
        rollout?.peers[0]?.state === "succeeded" &&
        rollout.self.state === "restarting"
      );
    },
    20_000,
    "B succeeded and self restarting",
  );
  expect(a.spawned).toHaveLength(1);
  const aState = JSON.parse(await readFile(a.spawned[0] as string, "utf8")) as {
    to: string;
  };
  expect(aState.to).toBe(VERSION);
  // A's shutdown was requested exactly once, for its own handoff.
  expect(a.shutdowns.length).toBe(1);
});

test("a peer that refuses the push is reported refused and the rollout continues to self", async () => {
  const { a, b } = await setup({});
  await seedBoth(a, b);
  const control = controlClientFor(a.daemon);
  await control.upgrade({ targets: "fleet", version: VERSION });
  await h.waitUntil(
    async () => (await control.upgrades())?.self.state === "restarting",
    15_000,
    "rollout reached self",
  );
  const rollout = await control.upgrades();
  expect(rollout?.peers[0]).toMatchObject({
    deviceId: b.daemon.deviceId,
    state: "refused",
  });
  expect(rollout?.peers[0]?.reason).toMatch(/remote|allow/i);
  expect(b.spawned).toEqual([]);
  expect(a.spawned).toHaveLength(1);
});

test("an explicit targets array selects the paired id", async () => {
  const { a, b } = await setup();
  await seedBoth(a, b);
  const control = controlClientFor(a.daemon);
  const started = await control.upgrade({
    targets: [b.daemon.deviceId],
    version: VERSION,
  });
  expect(peersOf(started).map((p) => p.deviceId)).toEqual([b.daemon.deviceId]);
  await h.waitUntil(
    () => b.spawned.length > 0,
    10_000,
    "B spawned its updater",
  );
});

test("a paired but undiscovered id in an explicit targets array is unreachable, not dropped", async () => {
  const { a, b } = await setup();
  // No knownNodes entry on A for B.
  const control = controlClientFor(a.daemon);
  const started = await control.upgrade({
    targets: [b.daemon.deviceId],
    version: VERSION,
  });
  expect(peersOf(started)).toHaveLength(1);
  expect(peersOf(started)[0]).toMatchObject({
    deviceId: b.daemon.deviceId,
    state: "unreachable",
  });
  await h.waitUntil(
    async () => (await control.upgrades())?.self.state === "restarting",
    15_000,
    "rollout reached self",
  );
  expect((await control.upgrades())?.peers[0]?.state).toBe("unreachable");
  expect(b.spawned).toEqual([]);
});
