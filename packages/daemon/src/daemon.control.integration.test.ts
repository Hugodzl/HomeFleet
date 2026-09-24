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
import { ControlClient } from "./cli/control-client.js";
import type { Daemon } from "./daemon.js";
import { JobResultOutputSchema } from "./mcp/tools.js";
import {
  createDaemonHarness,
  delegatorOverrides,
  HOST,
} from "./test-fixtures.js";

const h = createDaemonHarness({ tempPrefix: "homefleet-daemon-control" });

/** A real control-API client pointed at `daemon`'s bound control port. */
function controlClientFor(daemon: Daemon): ControlClient {
  return new ControlClient({ host: HOST, port: daemon.controlPort });
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

  // The data route still refuses a header-less request.
  expect((await controlGet(worker, "/control/jobs", false)).status).toBe(403);
}, 90_000);
