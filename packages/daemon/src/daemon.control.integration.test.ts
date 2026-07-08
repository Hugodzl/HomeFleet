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
import { afterEach, expect, test } from "vitest";
import { ControlClient } from "./cli/control-client.js";
import { DaemonConfigSchema } from "./config/config.js";
import { resolveDataDir } from "./config/paths.js";
import { Daemon } from "./daemon.js";
import { makeTempDataDir, removeTempDataDir } from "./test-fixtures.js";

const HOST = "127.0.0.1";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDataDir(prefix);
  cleanups.push(() => removeTempDataDir(dir));
  return dir;
}

/**
 * Raw config input for a test daemon: loopback HFP + MCP + control on
 * ephemeral ports, and every live discovery channel OFF — no mDNS, no UDP,
 * and (unlike daemon.integration.test.ts) no `staticNodes` entry either, so
 * NOTHING besides the known-nodes seeding under test can make the peer
 * reachable.
 */
function testConfig(name: string, overrides: Record<string, unknown> = {}) {
  return DaemonConfigSchema.parse({
    node: { name },
    hfp: { host: HOST, port: 0 },
    mcp: { host: HOST, port: 0 },
    control: { host: HOST, port: 0 },
    discovery: { mdnsEnabled: false, udpEnabled: false },
    ...overrides,
  });
}

async function startDaemon(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<Daemon> {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await tempDir(`homefleet-daemon-control-${name}-`),
  });
  const daemon = new Daemon({ dataDir, config: testConfig(name, overrides) });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

/** A real control-API client pointed at `daemon`'s bound control port. */
function controlClientFor(daemon: Daemon): ControlClient {
  return new ControlClient({ host: HOST, port: daemon.controlPort });
}

test("pairing through the real control-API HTTP surface seeds known-nodes, so the peer is immediately reachable with live discovery fully disabled", async () => {
  // Worker: offers a command executor (so its NodeInfo carries the
  // execution role/capability the assertions below check propagated).
  const worker = await startDaemon("worker", {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
  });
  // Delegator: no executors, no discovery config of any kind (not even a
  // staticNodes entry) — its only path to the worker's endpoint is
  // whatever pairing itself seeds.
  const delegator = await startDaemon("delegator");

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
