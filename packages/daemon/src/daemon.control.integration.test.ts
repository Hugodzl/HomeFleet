/**
 * Integration test for the daemon's CONTROL API HTTP surface, end to end
 * (M9 final-review Finding 2).
 *
 * `daemon.integration.test.ts` already assembles two real `Daemon`s and
 * pairs them — but it drives pairing directly against the in-process
 * `hfpClient`/`trustStore` objects, never through the actual `/control/*`
 * HTTP routes the `homefleet` CLI uses (`control-server.ts`'s
 * `ControlSurface`, closing over the real `pairingManager`/`hfpClient`/
 * `trustStore`/`nodeDirectory`/`knownNodes`). That gap is exactly why
 * Finding 1 (CLI-driven pairing not seeding the known-nodes registry) went
 * unnoticed: nothing exercised `pairWithPeer` as wired into the real control
 * surface against a REAL running daemon.
 *
 * This test closes that gap: two real `Daemon`s on loopback, temp data
 * dirs, ephemeral ports, and LIVE DISCOVERY FULLY DISABLED (no mDNS, no UDP,
 * no `staticNodes` config entry either) — with discovery off, the ONLY way
 * the delegator's node directory can resolve the worker's endpoint after
 * pairing is the known-nodes seeding `pairWithPeer` performs on acceptance.
 * Pairing and the subsequent reads are driven entirely through the real
 * control-API HTTP ports via `ControlClient` (the same client the CLI uses),
 * not the daemon's in-process getters.
 */
import { expect, test } from "vitest";
import { ControlClient, ControlRequestError } from "./cli/control-client.js";
import { resolveDataDir } from "./config/paths.js";
import {
  CONTROL_TOKEN_HEADER,
  readControlTokenSync,
} from "./control/control-token.js";
import { Daemon } from "./daemon.js";
import { JobResultOutputSchema } from "./mcp/tools.js";
import {
  createDaemonHarness,
  delegatorOverrides,
  HOST,
} from "./test-fixtures.js";
import { writeRolloutStatus } from "./upgrade/files.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./upgrade/test-release.js";

const h = createDaemonHarness({ tempPrefix: "homefleet-daemon-control" });

/** A real control-API client pointed at `daemon`'s bound control port. */
function controlClientFor(daemon: Daemon, dataDir?: string): ControlClient {
  return new ControlClient({
    host: HOST,
    port: daemon.controlPort,
    ...(dataDir !== undefined ? { token: readControlTokenSync(dataDir) } : {}),
  });
}

test("pairing through the real control-API HTTP surface seeds known-nodes, so the peer is immediately reachable with live discovery fully disabled", async () => {
  // Worker: offers a command executor (so its NodeInfo carries the
  // execution role/capability the assertions below check propagated).
  const { daemon: worker } = await h.startDaemon("worker", {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
  });
  // Delegator: no executors, no discovery config of any kind (not even a
  // staticNodes entry) — its only path to the worker's endpoint is
  // whatever pairing itself seeds.
  const { daemon: delegator } = await h.startDaemon("delegator");

  const workerControl = controlClientFor(worker);
  const delegatorControl = controlClientFor(delegator);

  // Drive the FULL pairing handshake through the real HTTP control routes:
  // worker opens a pairing window, delegator dials it by host:port + code.
  const { code } = await workerControl.pairBegin();
  const summary = await delegatorControl.pairConnect({
    host: HOST,
    port: worker.hfpPort,
    code,
  });
  expect(summary.accepted).toBe(true);
  expect(summary.deviceId).toBe(worker.deviceId);
  expect(summary.name).toBe("worker");

  // The Finding-1 guard: list_nodes (via the real control API) must show
  // the worker as reachable. With mDNS/UDP/staticNodes all off, the ONLY
  // way this can be true is that `pairWithPeer` seeded the known-nodes
  // registry with the worker's HFP endpoint during the pair/connect above
  // — without that fix this assertion fails (`reachable: false`).
  const nodes = await delegatorControl.nodes();
  const peer = nodes.find((n) => n.deviceId === worker.deviceId);
  expect(peer).toBeDefined();
  expect(peer?.reachable).toBe(true);
  expect(peer?.name).toBe("worker");
  // Live capability info only appears once `reachable` is true (see
  // node-directory.ts) and reflects the worker's actual config.
  expect(peer?.nodeInfo?.roles).toEqual(["execution"]);
  expect(peer?.nodeInfo?.executors).toEqual(["command"]);

  // Sanity: the delegator's own status, also read through the real HTTP
  // control route.
  const status = await delegatorControl.status();
  expect(status.deviceId).toBe(delegator.deviceId);
  expect(status.name).toBe("delegator");
  expect(status.hfpPort).toBe(delegator.hfpPort);
  expect(status.mcpPort).toBe(delegator.mcpPort);
  expect(status.controlPort).toBe(delegator.controlPort);
  expect(status.roles).toEqual([]);
  expect(status.executors).toEqual([]);
  expect(status.activeJobs).toBe(0);
  expect(status.maxConcurrentJobs).toBeGreaterThanOrEqual(1);

  // Explicit ordered stop; the afterEach cleanups call stop() again on
  // each (idempotent no-op) — the test finishing without a hang IS part of
  // the teardown assertion: no leaked sockets, jobs, or git children.
  await delegator.stop();
  await worker.stop();
}, 30_000);

/** GET against a daemon's control port; `withHeader` adds the CSRF header. */
async function controlGet(
  daemon: Daemon,
  path: string,
  withHeader: boolean,
): Promise<Response> {
  return fetch(`http://${HOST}:${daemon.controlPort}${path}`, {
    headers: withHeader ? { "x-homefleet-control": "1" } : {},
  });
}

test("the assembled daemon serves the dashboard and lists jobs on both sides of a delegation", async () => {
  const src = await h.makeSrcRepo("dashboard integration");
  const { daemon: worker } = await h.startDaemon("worker", {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
    workspace: { allowedRepoIds: ["repo-x"] },
  });
  const { daemon: delegator } = await h.startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await h.pair(delegator, worker);

  // The page itself: no control header needed, strict CSP present.
  const page = await controlGet(delegator, "/", false);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(await page.text()).toContain("data-homefleet-dashboard");

  const mcp = await h.connectMcp(delegator);
  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "command",
        workspace: { repoId: "repo-x" },
        command: "node",
        args: ["-e", "process.stdout.write('ok')"],
      },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  await h.waitUntil(async () => {
    const r = await mcp.callTool({ name: "job_result", arguments: { jobId } });
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  });

  // Delegator side: the job is listed with the worker's paired name and the
  // terminal status job_result observed.
  const mine = (await (
    await controlGet(delegator, "/control/jobs", true)
  ).json()) as {
    worker: unknown[];
    delegated: Array<Record<string, unknown>>;
  };
  expect(mine.worker).toEqual([]);
  expect(mine.delegated).toHaveLength(1);
  expect(mine.delegated[0]).toMatchObject({
    jobId,
    type: "command",
    targetDeviceId: worker.deviceId,
    targetName: "worker",
    repoId: "repo-x",
    lastStatus: "succeeded",
  });

  // Worker side: the same job, owned by the delegator, metadata only.
  const theirs = (await (
    await controlGet(worker, "/control/jobs", true)
  ).json()) as {
    worker: Array<Record<string, unknown>>;
    delegated: unknown[];
  };
  expect(theirs.delegated).toEqual([]);
  expect(theirs.worker).toHaveLength(1);
  expect(theirs.worker[0]).toMatchObject({
    jobId,
    type: "command",
    ownerDeviceId: delegator.deviceId,
    ownerName: "delegator",
    status: "succeeded",
  });
  expect(theirs.worker[0]).not.toHaveProperty("params");
  expect(theirs.worker[0]).not.toHaveProperty("result");

  // The daemon-level rename (Task 7 review, Finding 2): the internal
  // `owner`/`deviceId` keys the JobManager/DelegationRegistry actually use
  // must not leak alongside their renamed `ownerDeviceId`/`targetDeviceId`
  // public forms.
  expect(theirs.worker[0]).not.toHaveProperty("owner");
  expect(mine.delegated[0]).not.toHaveProperty("deviceId");

  // Names are resolved live from the trust store on every call: once the
  // peer drops out of it, its name is omitted from the listing (the device
  // id and job data stay put) rather than going stale.
  await worker.trustStore.remove(delegator.deviceId);
  const theirsAfterUntrust = (await (
    await controlGet(worker, "/control/jobs", true)
  ).json()) as { worker: Array<Record<string, unknown>> };
  expect(theirsAfterUntrust.worker[0]).toMatchObject({
    jobId,
    ownerDeviceId: delegator.deviceId,
  });
  expect(theirsAfterUntrust.worker[0]).not.toHaveProperty("ownerName");

  // Same on the delegator side: once the worker drops out of ITS trust
  // store, the delegated entry keeps targetDeviceId but drops targetName.
  await delegator.trustStore.remove(worker.deviceId);
  const mineAfterUntrust = (await (
    await controlGet(delegator, "/control/jobs", true)
  ).json()) as { delegated: Array<Record<string, unknown>> };
  expect(mineAfterUntrust.delegated[0]).toMatchObject({
    jobId,
    targetDeviceId: worker.deviceId,
  });
  expect(mineAfterUntrust.delegated[0]).not.toHaveProperty("targetName");

  // The data route still refuses a header-less request.
  expect((await controlGet(worker, "/control/jobs", false)).status).toBe(403);
}, 90_000);

test("unpair through the real control route: trust revoked live, the peer's job canceled, persisted across restart, other side untouched", async () => {
  const src = await h.makeSrcRepo("unpair integration");
  const workerConfig = {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
    workspace: { allowedRepoIds: ["repo-x"] },
  };
  const { daemon: worker, dataDir: workerDataDir } = await h.startDaemon(
    "worker",
    workerConfig,
  );
  const { daemon: delegator } = await h.startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await h.pair(delegator, worker);

  // A long-running job the delegator owns on the worker.
  const mcp = await h.connectMcp(delegator);
  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "command",
        workspace: { repoId: "repo-x" },
        command: "node",
        args: ["-e", "setTimeout(()=>{},30000)"],
      },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  const workerJobStatus = () =>
    worker.jobManager.list().find((job) => job.jobId === jobId)?.status;
  await h.waitUntil(
    () => workerJobStatus() === "running",
    undefined,
    "job running",
  );

  // The worker unpairs the delegator through its real control API.
  const workerControl = controlClientFor(worker);
  expect(await workerControl.unpair(delegator.deviceId)).toEqual({
    deviceId: delegator.deviceId,
    name: "delegator",
    canceledJobs: 1,
  });
  await h.waitUntil(
    () => workerJobStatus() === "canceled",
    undefined,
    "job canceled",
  );

  // Gone from the worker's live directory (what nodes/list_nodes/dashboard read).
  expect(
    (await workerControl.nodes()).map((node) => node.deviceId),
  ).not.toContain(delegator.deviceId);

  // Revocation is live: the delegator's next HFP call to the worker is refused.
  const followUp = await mcp.callTool({
    name: "job_status",
    arguments: { jobId },
  });
  expect(followUp.isError).toBe(true);
  // The worker's 401 is surfaced as an UNAUTHORIZED HFP failure, not a
  // generic error (see describeHfpFailure in src/mcp/tools.ts).
  expect((followUp.content as Array<{ text: string }>)[0]?.text).toMatch(
    /UNAUTHORIZED/,
  );

  // One-sided: the delegator still lists the worker, now unreachable (its
  // hello gets 401).
  const theirView = await controlClientFor(delegator).nodes();
  expect(
    theirView.find((node) => node.deviceId === worker.deviceId)?.reachable,
  ).toBe(false);

  // A second unpair is a clean 404.
  const again = await workerControl.unpair(delegator.deviceId).catch((e) => e);
  expect(again).toBeInstanceOf(ControlRequestError);
  expect((again as ControlRequestError).status).toBe(404);

  // Persisted: a daemon restarted over the same data dir still does not trust it.
  await worker.stop();
  const { daemon: restarted } = await h.startDaemon(
    "worker",
    workerConfig,
    workerDataDir,
  );
  expect(restarted.trustStore.has(delegator.deviceId)).toBe(false);
}, 90_000);

test("a daemon without a shutdown hook refuses upgrades cleanly (409 unsupported) and reports no lastUpgrade", async () => {
  const { daemon, dataDir } = await h.startDaemon("solo");
  const control = controlClientFor(daemon, dataDir);

  const error = await control
    .upgrade({ targets: "self" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ControlRequestError);
  expect(error).toMatchObject({ status: 409, code: "unsupported" });

  const status = await control.status();
  expect(status.lastUpgrade).toBeUndefined();
});

test("a rollout saved before this node's own restart is served back by the restarted daemon", async () => {
  const { daemon, dataDir } = await h.startDaemon("requester");
  expect(await controlClientFor(daemon, dataDir).upgrades()).toBeNull();
  const version = daemon.nodeInfo().daemonVersion;
  await daemon.stop();

  // What the rollout saved as it handed off to this node's own upgrade.
  await writeRolloutStatus(dataDir, {
    id: "r1",
    target: version,
    startedAt: new Date().toISOString(),
    state: "running",
    peers: [
      {
        deviceId: "t",
        name: "tower",
        from: "0.0.1",
        state: "refused",
        reason: "remote upgrades are disabled on this node",
      },
    ],
    self: { state: "restarting" },
  });
  const { daemon: restarted } = await h.startDaemon(
    "requester",
    undefined,
    dataDir,
  );
  const rollout = await controlClientFor(restarted, dataDir).upgrades();
  expect(rollout).toMatchObject({
    id: "r1",
    state: "done",
    self: { state: "succeeded" },
    peers: [{ name: "tower", state: "refused" }],
  });
});

// ---------------------------------------------------------------------------
// Per-boot control token and the upgrade surface across an assembled daemon
// (fleet upgrade Phase 4, Task 8). Test keys and a fake release source only.
// ---------------------------------------------------------------------------

const upgradeKeys = makeTestKeys();
const RELEASE = "0.5.1";

/** Counts `latestVersion` lookups, so gating can be asserted at daemon level. */
class CountingSource extends FakeReleaseSource {
  lookups = 0;

  override async latestVersion(): Promise<string> {
    this.lookups++;
    return super.latestVersion();
  }
}

/** A daemon at 0.5.0 with a fake release source and the test public key. */
async function startUpgradeDaemon(
  name: string,
  source: FakeReleaseSource,
  dataDirOverride?: string,
) {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR:
      dataDirOverride ?? (await h.tempDir(`homefleet-daemon-control-${name}-`)),
  });
  const daemon = new Daemon({
    dataDir,
    config: h.testConfig(name),
    releaseSource: source,
    daemonVersion: "0.5.0",
    upgradeSeams: { publicKeys: [upgradeKeys.publicKey] },
  });
  await daemon.start();
  h.onCleanup(() => daemon.stop());
  return { daemon, dataDir };
}

async function releaseOrigin(): Promise<string> {
  const originDir = await h.tempDir("homefleet-daemon-control-origin-");
  await writeSignedRelease(originDir, RELEASE, upgradeKeys);
  return originDir;
}

const TOKEN_META = /<meta name="homefleet-control-token" content="([^"]*)">/;

async function pageToken(daemon: Daemon): Promise<string | undefined> {
  const html = await (await controlGet(daemon, "/", false)).text();
  return TOKEN_META.exec(html)?.[1];
}

function controlPost(
  daemon: Daemon,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return fetch(`http://${HOST}:${daemon.controlPort}${path}`, {
    method: "POST",
    headers: {
      "x-homefleet-control": "1",
      "content-type": "application/json",
      ...(token !== undefined ? { [CONTROL_TOKEN_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("the dashboard page carries the token written to <dataDir>/control-token", async () => {
  const source = new CountingSource(await releaseOrigin(), RELEASE);
  const { daemon, dataDir } = await startUpgradeDaemon("tok", source);
  const fileToken = readControlTokenSync(dataDir);
  expect(fileToken).toMatch(/^[0-9a-f]{64}$/);
  expect(await pageToken(daemon)).toBe(fileToken);
});

test("POST /control/upgrade/prepare needs the token, and with it reaches a verified prepare", async () => {
  const source = new CountingSource(await releaseOrigin(), RELEASE);
  const { daemon, dataDir } = await startUpgradeDaemon("prep", source);

  const refused = await controlPost(daemon, "/control/upgrade/prepare", {});
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "bad-token" });
  const wrong = await controlPost(
    daemon,
    "/control/upgrade/prepare",
    {},
    "0".repeat(64),
  );
  expect(wrong.status).toBe(403);
  expect(source.fetchCount).toBe(0);

  const ok = await controlPost(
    daemon,
    "/control/upgrade/prepare",
    {},
    readControlTokenSync(dataDir),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({
    current: "0.5.0",
    target: RELEASE,
    verified: true,
    size: expect.any(Number),
  });
});

test("POST /control/upgrade without the token is refused 403 bad-token", async () => {
  const source = new CountingSource(await releaseOrigin(), RELEASE);
  const { daemon } = await startUpgradeDaemon("up", source);
  const res = await controlPost(daemon, "/control/upgrade", {
    targets: "self",
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: "bad-token" });
});

test("a restarted daemon writes a new token and serves it in the page", async () => {
  const origin = await releaseOrigin();
  const first = await startUpgradeDaemon(
    "boot",
    new CountingSource(origin, RELEASE),
  );
  const oldToken = readControlTokenSync(first.dataDir);
  await first.daemon.stop();

  const second = await startUpgradeDaemon(
    "boot",
    new CountingSource(origin, RELEASE),
    first.dataDir,
  );
  const newToken = readControlTokenSync(second.dataDir);
  expect(newToken).toMatch(/^[0-9a-f]{64}$/);
  expect(newToken).not.toBe(oldToken);
  expect(await pageToken(second.daemon)).toBe(newToken);
  // The old token no longer opens the protected route.
  const stale = await controlPost(
    second.daemon,
    "/control/upgrade/prepare",
    {},
    oldToken,
  );
  expect(stale.status).toBe(403);
});

test("the token appears only in the page body, never in status or upgrades responses", async () => {
  const source = new CountingSource(await releaseOrigin(), RELEASE);
  const { daemon, dataDir } = await startUpgradeDaemon("leak", source);
  const token = readControlTokenSync(dataDir) as string;
  for (const path of ["/control/status?dashboard=1", "/control/upgrades"]) {
    const res = await controlGet(daemon, path, true);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(token);
    for (const [name, value] of res.headers) {
      expect(name).not.toContain(token);
      expect(value).not.toContain(token);
    }
  }
  // Sanity: the page itself does carry it (body only, not headers).
  const page = await controlGet(daemon, "/", false);
  for (const [, value] of page.headers) {
    expect(value).not.toContain(token);
  }
  expect(await page.text()).toContain(token);
});

test("availableUpgrade: a plain status never looks it up; dashboard=1 looks up once and reports it", async () => {
  const source = new CountingSource(await releaseOrigin(), RELEASE);
  const { daemon } = await startUpgradeDaemon("avail", source);
  const status = async (query: string) =>
    (await (
      await controlGet(daemon, `/control/status${query}`, true)
    ).json()) as { availableUpgrade?: string };

  expect(await status("")).not.toHaveProperty("availableUpgrade");
  expect(await status("")).not.toHaveProperty("availableUpgrade");
  expect(source.lookups).toBe(0);

  // First dashboard poll kicks the lookup (served from the cold cache).
  expect(await status("?dashboard=1")).not.toHaveProperty("availableUpgrade");
  await h.waitUntil(
    async () => (await status("?dashboard=1")).availableUpgrade === RELEASE,
    undefined,
    "availableUpgrade resolved",
  );
  // Further polls within the TTL do not look it up again.
  expect((await status("?dashboard=1")).availableUpgrade).toBe(RELEASE);
  expect(source.lookups).toBe(1);
  // And a plain status still omits it.
  expect(await status("")).not.toHaveProperty("availableUpgrade");
  expect(source.lookups).toBe(1);
});
