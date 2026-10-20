import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  LOCK_FILE,
  RESULT_FILE,
  UPDATER_LOG,
  type UpgradeResult,
  type UpgradeState,
  upgradesDir,
  writeUpgradeState,
} from "./files.js";

const UPDATER = fileURLToPath(new URL("./updater.mjs", import.meta.url));

const FAKE_NPM = `import { writeFileSync } from "node:fs";
import path from "node:path";
const tgz = process.argv.at(-1);
const m = /homefleet-(\\d+\\.\\d+\\.\\d+)\\.tgz$/.exec(path.basename(tgz));
if (!m || process.env.FAKE_NPM_FAIL === m[1]) process.exit(1);
writeFileSync(process.env.FAKE_INSTALLED, m[1]);
`;

const FAKE_DAEMON = `import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
appendFileSync(process.env.FAKE_PIDS, process.pid + "\\n");
const version = readFileSync(process.env.FAKE_INSTALLED, "utf8");
if (process.env.FAKE_BROKEN === version) process.exit(1);
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ daemonVersion: version }));
}).listen(Number(process.argv[2]), "127.0.0.1");
setTimeout(() => process.exit(0), 20000);
`;

const roots: string[] = [];
const pidFiles: string[] = [];
afterEach(async () => {
  for (const file of pidFiles.splice(0)) {
    const pids = await readFile(file, "utf8").catch(() => "");
    for (const pid of pids.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid));
      } catch {}
    }
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

async function runUpdater(scenario: {
  rollback: boolean;
  env?: Record<string, string>;
}): Promise<{
  result: UpgradeResult;
  installed: string;
  log: string;
  lockGone: boolean;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "hf-updater-"));
  roots.push(root);
  const dir = upgradesDir(root);
  await mkdir(path.join(dir, "0.5.1"), { recursive: true });
  await mkdir(path.join(dir, "0.5.0"), { recursive: true });
  const tarball = path.join(dir, "0.5.1", "homefleet-0.5.1.tgz");
  const rollback = path.join(dir, "0.5.0", "homefleet-0.5.0.tgz");
  await writeFile(tarball, "new");
  await writeFile(rollback, "old");
  const fakeNpm = path.join(root, "fake-npm.mjs");
  const fakeDaemon = path.join(root, "fake-daemon.mjs");
  await writeFile(fakeNpm, FAKE_NPM);
  await writeFile(fakeDaemon, FAKE_DAEMON);
  const installed = path.join(root, "installed.txt");
  await writeFile(installed, "0.5.0");
  const pids = path.join(root, "pids.txt");
  pidFiles.push(pids);

  // The "old daemon": exits on its own shortly, like a graceful stop would.
  const oldDaemon = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 300)",
  ]);
  const port = await freePort();
  const state: UpgradeState = {
    from: "0.5.0",
    to: "0.5.1",
    tarballPath: tarball,
    ...(scenario.rollback ? { rollbackTarballPath: rollback } : {}),
    daemonPid: oldDaemon.pid ?? 0,
    nodePath: process.execPath,
    argv: [fakeDaemon, String(port)],
    controlHost: "127.0.0.1",
    controlPort: port,
    installCommand: [process.execPath, fakeNpm],
    dataDir: root,
    exitTimeoutMs: 5_000,
    healthTimeoutMs: 3_000,
  };
  const statePath = await writeUpgradeState(dir, state);
  await writeFile(
    path.join(dir, LOCK_FILE),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  );

  const child = spawn(process.execPath, [UPDATER, statePath], {
    env: {
      ...process.env,
      FAKE_INSTALLED: installed,
      FAKE_PIDS: pids,
      ...scenario.env,
    },
    stdio: "ignore",
  });
  await once(child, "exit");

  const lockGone = await readFile(path.join(dir, LOCK_FILE)).then(
    () => false,
    () => true,
  );
  return {
    result: JSON.parse(
      await readFile(path.join(root, RESULT_FILE), "utf8"),
    ) as UpgradeResult,
    installed: await readFile(installed, "utf8"),
    log: await readFile(path.join(dir, UPDATER_LOG), "utf8"),
    lockGone,
  };
}

test("success: installs, relaunches, sees the new version, releases the lock", async () => {
  const run = await runUpdater({ rollback: true });
  expect(run.result).toMatchObject({
    from: "0.5.0",
    to: "0.5.1",
    outcome: "succeeded",
  });
  expect(run.installed).toBe("0.5.1");
  expect(run.lockGone).toBe(true);
});

test("a new daemon that never answers is rolled back", async () => {
  const run = await runUpdater({
    rollback: true,
    env: { FAKE_BROKEN: "0.5.1" },
  });
  expect(run.result.outcome).toBe("rolled-back");
  expect(run.result.reason).toMatch(/did not report its version/);
  expect(run.installed).toBe("0.5.0");
});

test("a failed npm install is rolled back", async () => {
  const run = await runUpdater({
    rollback: true,
    env: { FAKE_NPM_FAIL: "0.5.1" },
  });
  expect(run.result.outcome).toBe("rolled-back");
  expect(run.result.reason).toMatch(/npm install of 0.5.1 failed/);
  expect(run.installed).toBe("0.5.0");
});

test("without a rollback tarball the outcome is failed", async () => {
  const run = await runUpdater({
    rollback: false,
    env: { FAKE_BROKEN: "0.5.1" },
  });
  expect(run.result.outcome).toBe("failed");
  expect(run.result.reason).toMatch(/rollback unavailable/);
  expect(run.lockGone).toBe(true);
});

test("logs what it did", async () => {
  const run = await runUpdater({ rollback: true });
  expect(run.log).toMatch(/installing .*homefleet-0\.5\.1\.tgz/);
  expect(run.log).toMatch(/result: succeeded/);
});
