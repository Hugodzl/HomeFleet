/**
 * `POST /control/shutdown` across an assembled daemon: the real control
 * surface, the real per-boot token, and a recording `requestShutdown` in
 * place of homefleetd's (which force-exits on a SECOND request, the bug a
 * repeated stop used to hit). The decision branches are unit-tested in
 * ./control/shutdown.test.ts.
 */
import { expect, test } from "vitest";
import { ControlClient } from "./cli/control-client.js";
import { resolveDataDir } from "./config/paths.js";
import { readControlTokenSync } from "./control/control-token.js";
import { Daemon } from "./daemon.js";
import { createDaemonHarness, HOST } from "./test-fixtures.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./upgrade/test-release.js";

const h = createDaemonHarness({ tempPrefix: "homefleet-daemon-shutdown" });

async function startWithHook(requests: string[]) {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await h.tempDir("homefleet-daemon-shutdown-"),
  });
  const daemon = new Daemon({
    dataDir,
    config: h.testConfig("stopper"),
    requestShutdown: (reason) => requests.push(reason),
  });
  await daemon.start();
  h.onCleanup(() => daemon.stop());
  const client = new ControlClient({
    host: HOST,
    port: daemon.controlPort,
    token: readControlTokenSync(dataDir),
  });
  return { daemon, client };
}

test("two stops request the shutdown exactly once; the second answers alreadyStopping", async () => {
  const requests: string[] = [];
  const { client } = await startWithHook(requests);

  const first = await client.shutdown();
  const second = await client.shutdown({ force: true });
  expect(first).toEqual({ pid: process.pid, alreadyStopping: false });
  expect(second).toEqual({ pid: process.pid, alreadyStopping: true });

  await h.waitUntil(() => requests.length > 0, 5_000, "shutdown requested");
  // Past the 250 ms delay of BOTH calls: still exactly one request.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(requests).toEqual(["stop requested"]);
  // And a third, after the request went out, still doesn't re-trigger.
  await expect(client.shutdown()).resolves.toMatchObject({
    alreadyStopping: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(requests).toEqual(["stop requested"]);
});

test("status reports the daemon's own pid", async () => {
  const { client } = await startWithHook([]);
  await expect(client.status()).resolves.toMatchObject({ pid: process.pid });
});

test("a signal right after a stop: the stop's delayed request never fires (no forced exit)", async () => {
  const requests: string[] = [];
  const { daemon, client } = await startWithHook(requests);
  await client.shutdown();
  // What homefleetd's SIGINT/SIGTERM handler does: stop the daemon directly,
  // inside the stop's 250 ms delay.
  await daemon.stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(requests).toEqual([]);
});

const upgradeKeys = makeTestKeys();
const INSTALLED_ENTRY =
  "/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js";

test("during an upgrade: the upgrade's own shutdown goes out once, a stop is 409 upgrading, and nothing re-requests", async () => {
  const origin = await h.tempDir("homefleet-daemon-shutdown-origin-");
  await writeSignedRelease(origin, "0.5.1", upgradeKeys);
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await h.tempDir("homefleet-daemon-shutdown-up-"),
  });
  const requests: string[] = [];
  const spawned: string[] = [];
  const daemon = new Daemon({
    dataDir,
    config: h.testConfig("upgrader"),
    releaseSource: new FakeReleaseSource(origin, "0.5.1"),
    daemonVersion: "0.5.0",
    requestShutdown: (reason) => requests.push(reason),
    upgradeSeams: {
      publicKeys: [upgradeKeys.publicKey],
      spawnUpdater: (updaterPath) => spawned.push(updaterPath),
      runtime: {
        pid: 4242,
        execPath: "/usr/bin/node",
        argv: ["/usr/bin/node", INSTALLED_ENTRY],
        platform: "linux",
      },
      shutdownDelayMs: 0,
    },
  });
  await daemon.start();
  h.onCleanup(() => daemon.stop());
  const client = new ControlClient({
    host: HOST,
    port: daemon.controlPort,
    token: readControlTokenSync(dataDir),
  });

  await expect(client.upgrade({ targets: "self" })).resolves.toEqual({
    from: "0.5.0",
    to: "0.5.1",
  });
  expect(spawned).toHaveLength(1);
  await h.waitUntil(() => requests.length > 0, 5_000, "upgrade shutdown");
  expect(requests).toEqual(["upgrading to 0.5.1"]);

  await expect(client.shutdown({ force: true })).rejects.toMatchObject({
    status: 409,
    code: "upgrading",
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(requests).toEqual(["upgrading to 0.5.1"]);
});
