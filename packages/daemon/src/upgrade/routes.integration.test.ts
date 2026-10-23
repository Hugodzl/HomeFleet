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
): Promise<Node> {
  const dataDir = resolveDataDir({
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
    daemonVersion: "0.5.0",
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
