/**
 * Release candidates end to end, on real in-process daemons with temp data
 * dirs and a fake updater: A (the requester) rolls a candidate out to a peer
 * B through the control API. Two signed builds of 0.8.0 stand for rc.1 and
 * rc.2, so everything that tells them apart is the tarball hash: the
 * selection, the push (`candidate: true`), the bytes A's tarball route
 * serves, B's state file, and the success check after B "restarts".
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { UpgradeAcceptedSchema } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { ControlClient } from "../cli/control-client.js";
import { resolveDataDir } from "../config/paths.js";
import { readControlTokenSync } from "../control/control-token.js";
import { Daemon, type DaemonOptions } from "../daemon.js";
import { createDaemonHarness, HOST } from "../test-fixtures.js";
import { HfpRequestError } from "../transport/client.js";
import {
  STATE_FILE,
  type UpgradeState,
  upgradesDir,
  writeInstalledRelease,
} from "./files.js";
import { hashFile } from "./manifest.js";
import { prepareRelease, RELEASES_DIRNAME } from "./prepare.js";
import type { FetchOptions } from "./release-source.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./test-release.js";

const h = createDaemonHarness({ tempPrefix: "homefleet-candidate" });
const keys = makeTestKeys();
const V = "0.8.0";
const RC1 = "v0.8.0-rc.1";
const RC2 = "v0.8.0-rc.2";
const ENTRY = "/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js";

/** A fake GitHub that records every fetch (version + tag). */
class RecordingSource extends FakeReleaseSource {
  readonly fetched: string[] = [];

  override async fetchRelease(
    version: string,
    destDir: string,
    options: FetchOptions = {},
  ) {
    this.fetched.push(`${version}${options.tag ? `@${options.tag}` : ""}`);
    return super.fetchRelease(version, destDir, options);
  }
}

interface Builds {
  originRc1: string;
  originRc2: string;
  sha1: string;
  sha2: string;
}

async function builds(): Promise<Builds> {
  const originRc1 = await h.tempDir("homefleet-candidate-rc1-");
  const originRc2 = await h.tempDir("homefleet-candidate-rc2-");
  const a = await writeSignedRelease(originRc1, V, keys, { content: "rc.1" });
  const b = await writeSignedRelease(originRc2, V, keys, { content: "rc.2" });
  return {
    originRc1,
    originRc2,
    sha1: (await hashFile(a.tarballPath)).sha256,
    sha2: (await hashFile(b.tarballPath)).sha256,
  };
}

interface Node {
  daemon: Daemon;
  dataDir: string;
  source: RecordingSource;
  spawned: string[];
}

async function startNode(
  name: string,
  b: Builds,
  opts: {
    version?: string;
    /** installed-release.json written before boot. */
    installed?: string;
    dataDir?: string;
    overrides?: Record<string, unknown>;
  } = {},
): Promise<Node> {
  const version = opts.version ?? V;
  const dataDir =
    opts.dataDir ??
    resolveDataDir({
      HOMEFLEET_DATA_DIR: await h.tempDir(`homefleet-candidate-${name}-`),
    });
  if (opts.installed !== undefined) {
    await writeInstalledRelease(dataDir, {
      version,
      sha256: opts.installed,
    });
  }
  // GitHub has the candidates under their tags; no final 0.8.0 yet.
  const source = new RecordingSource(b.originRc1, V, {
    [RC1]: b.originRc1,
    [RC2]: b.originRc2,
  });
  const spawned: string[] = [];
  const options: DaemonOptions = {
    dataDir,
    config: h.testConfig(name, {
      upgrade: { allowRemote: true },
      ...opts.overrides,
    }),
    releaseSource: source,
    requestShutdown: () => undefined,
    daemonVersion: version,
    upgradeSeams: {
      publicKeys: [keys.publicKey],
      shutdownDelayMs: 0,
      spawnUpdater: (_updater, statePath) => spawned.push(statePath),
      runtime: {
        pid: 4242,
        execPath: process.execPath,
        argv: [process.execPath, ENTRY],
        platform: process.platform,
      },
    },
  };
  const daemon = new Daemon(options);
  await daemon.start();
  h.onCleanup(() => daemon.stop());
  return { daemon, dataDir, source, spawned };
}

async function seed(from: Node, to: Node): Promise<void> {
  await from.daemon.knownNodes.record({
    deviceId: to.daemon.deviceId,
    host: HOST,
    port: to.daemon.hfpPort,
    lastSeenAt: new Date().toISOString(),
    source: "static",
  });
}

function controlOf(node: Node): ControlClient {
  return new ControlClient({
    host: HOST,
    port: node.daemon.controlPort,
    token: readControlTokenSync(node.dataDir),
  });
}

async function stateOf(node: Node): Promise<UpgradeState> {
  return JSON.parse(
    await readFile(path.join(upgradesDir(node.dataDir), STATE_FILE), "utf8"),
  ) as UpgradeState;
}

/** Stops `node` and starts it again on the same data dir and HFP port. */
async function restart(
  node: Node,
  name: string,
  b: Builds,
  opts: { version?: string; installed?: string },
): Promise<Node> {
  const port = node.daemon.hfpPort;
  await node.daemon.stop();
  let restarted: Node | undefined;
  await h.waitUntil(
    async () => {
      try {
        restarted = await startNode(name, b, {
          ...opts,
          dataDir: node.dataDir,
          overrides: { hfp: { host: HOST, port } },
        });
        return true;
      } catch {
        return false;
      }
    },
    15_000,
    `${name} restarted on its HFP port`,
  );
  return restarted as Node;
}

/** A and B on 0.8.0 rc.1, paired both ways with known endpoints. */
async function fleet(
  peer: {
    /** The peer's installed-release hash; default rc.1. */
    installed?: (b: Builds) => string | undefined;
    version?: string;
  } = {},
) {
  const b = await builds();
  const a = await startNode("requester", b, { installed: b.sha1 });
  const installed = (peer.installed ?? ((x) => x.sha1))(b);
  const p = await startNode("peer", b, {
    ...(installed !== undefined ? { installed } : {}),
    ...(peer.version !== undefined ? { version: peer.version } : {}),
  });
  await h.pair(a.daemon, p.daemon);
  await seed(a, p);
  await seed(p, a);
  return { b, a, p };
}

test("rc.1 → rc.2: A pushes the candidate, B pulls rc.2 from A only, then A follows once B runs rc.2", async () => {
  const { b, a, p } = await fleet();
  // B already holds rc.1 (its rollback copy) from an earlier candidate.
  await prepareRelease({
    source: new FakeReleaseSource(b.originRc1, V, { [RC1]: b.originRc1 }),
    upgradesDir: upgradesDir(p.dataDir),
    version: V,
    tag: RC1,
    publicKeys: [keys.publicKey],
  });
  const control = controlOf(a);

  const started = await control.upgrade({ targets: "fleet", candidate: RC2 });
  expect(started).toMatchObject({
    state: "running",
    target: V,
    candidateSha256: b.sha2,
  });
  await h.waitUntil(() => p.spawned.length > 0, 10_000, "B spawned");

  const state = await stateOf(p);
  expect(state).toMatchObject({
    from: V,
    to: V,
    candidate: true,
    toSha256: b.sha2,
    fromSha256: b.sha1,
  });
  expect(state.rollbackTarballPath).toBe(
    path.join(
      upgradesDir(p.dataDir),
      RELEASES_DIRNAME,
      b.sha1,
      "homefleet-0.8.0.tgz",
    ),
  );
  // rc.2 came from A's tarball route, never from B's GitHub.
  expect(p.source.fetched).toEqual([]);
  expect(await readFile(state.tarballPath, "utf8")).toBe("rc.2");

  // Back on 0.8.0 but still rc.1: not done yet.
  await h.waitUntil(
    async () => (await control.upgrades())?.peers[0]?.state === "restarting",
    10_000,
    "A shows B restarting",
  );
  expect(a.spawned).toEqual([]);

  // B's updater is fake: "restart" it on rc.2's bytes.
  await restart(p, "peer", b, { installed: b.sha2 });
  await h.waitUntil(
    async () => {
      const rollout = await control.upgrades();
      return (
        rollout?.peers[0]?.state === "succeeded" &&
        rollout.self.state === "restarting"
      );
    },
    20_000,
    "B succeeded and A restarting",
  );
  expect(a.spawned).toHaveLength(1);
  expect(
    JSON.parse(await readFile(a.spawned[0] as string, "utf8")),
  ).toMatchObject({
    candidate: true,
    toSha256: b.sha2,
    fromSha256: b.sha1,
  });
});

test("a peer already on rc.2 is skipped", async () => {
  const { a } = await fleet({ installed: (b) => b.sha2 });
  const started = await controlOf(a).upgrade({
    targets: "fleet",
    candidate: RC2,
  });
  expect(started).toMatchObject({ target: V, peers: [] });
});

test("with no endpoint for A, B refuses the candidate before replying and never asks its GitHub", async () => {
  const b = await builds();
  const a = await startNode("requester", b, { installed: b.sha1 });
  const p = await startNode("peer", b, { installed: b.sha1 });
  await h.pair(a.daemon, p.daemon);
  await seed(a, p); // A can reach B, but B has no address for A
  const control = controlOf(a);
  await control.upgrade({
    targets: [p.daemon.deviceId],
    candidate: RC2,
    includeSelf: false,
  });
  await h.waitUntil(
    async () => (await control.upgrades())?.state === "done",
    10_000,
    "rollout done",
  );
  const rollout = await control.upgrades();
  expect(rollout?.peers[0]).toMatchObject({ state: "refused" });
  expect(rollout?.peers[0]?.reason).toMatch(/release candidate/);
  expect(p.spawned).toEqual([]);
  expect(p.source.fetched).toEqual([]);
});

test("a same-version push without the candidate field (an old pusher) is refused not-newer", async () => {
  const { b, a, p } = await fleet();
  const manifest = await readFile(
    path.join(b.originRc2, "homefleet-0.8.0.manifest.json"),
  );
  const signature = (
    await readFile(
      path.join(b.originRc2, "homefleet-0.8.0.manifest.sig"),
      "utf8",
    )
  ).trim();
  const error = await a.daemon.hfpClient
    .request({
      host: HOST,
      port: p.daemon.hfpPort,
      expectedDeviceId: p.daemon.deviceId,
      method: "POST",
      path: "/upgrade",
      body: { version: V, manifest: manifest.toString("base64"), signature },
      responseSchema: UpgradeAcceptedSchema,
    })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HfpRequestError);
  expect((error as HfpRequestError).hfpError?.details).toEqual({
    reason: "not-newer",
  });
});

test("a peer on 0.7.0 whose old updater writes no record counts as succeeded once it reports 0.8.0", async () => {
  const { b, a, p } = await fleet({
    version: "0.7.0",
    installed: () => undefined,
  });
  const control = controlOf(a);
  await control.upgrade({
    targets: "fleet",
    candidate: RC1,
    includeSelf: false,
  });
  await h.waitUntil(() => p.spawned.length > 0, 10_000, "B spawned");
  // The 0.7.0 updater installs and relaunches but records no hash.
  await restart(p, "peer", b, { version: V });
  await h.waitUntil(
    async () => (await control.upgrades())?.peers[0]?.state === "succeeded",
    20_000,
    "B succeeded",
  );
});
