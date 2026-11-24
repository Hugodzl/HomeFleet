import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  INSTALLED_FILE,
  LOCK_FILE,
  RESULT_FILE,
  UPDATER_LOG,
  type UpgradeResult,
  type UpgradeState,
  upgradesDir,
  writeInstalledRelease,
  writeUpgradeState,
} from "./files.js";

const UPDATER = fileURLToPath(new URL("./updater.mjs", import.meta.url));

// The fake npm "installs" a tarball by recording its version (from the file
// name) and its content, which stands for its bytes: two builds of one
// version differ only there. FAKE_NPM_FAIL lists versions or contents whose
// install fails.
const FAKE_NPM = `import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const tgz = process.argv.at(-1);
const m = /homefleet-(\\d+\\.\\d+\\.\\d+)\\.tgz$/.exec(path.basename(tgz));
const content = readFileSync(tgz, "utf8");
const fail = (process.env.FAKE_NPM_FAIL ?? "").split(",");
if (!m || fail.includes(m[1]) || fail.includes(content)) process.exit(1);
writeFileSync(process.env.FAKE_INSTALLED, JSON.stringify({ version: m[1], content }));
`;

// Like the real daemon, the fake reads installed-release.json once at boot
// (trusting it only for its own version) and reports its hash. FAKE_BROKEN
// (a version or a content) makes it crash. FAKE_STALE_SHA stands for the old
// process still answering on the port: it reports that hash whatever the
// record says.
const FAKE_DAEMON = `import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
appendFileSync(process.env.FAKE_PIDS, process.pid + "\\n");
const { version, content } = JSON.parse(readFileSync(process.env.FAKE_INSTALLED, "utf8"));
if (process.env.FAKE_BROKEN === version || process.env.FAKE_BROKEN === content) process.exit(1);
let releaseSha256;
try {
  const record = JSON.parse(readFileSync(path.join(process.argv[3], "installed-release.json"), "utf8"));
  if (record.version === version) releaseSha256 = record.sha256;
} catch {}
if (process.env.FAKE_STALE_SHA) releaseSha256 = process.env.FAKE_STALE_SHA;
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ daemonVersion: version, ...(releaseSha256 ? { releaseSha256 } : {}) }));
}).listen(Number(process.argv[2]), "127.0.0.1");
setTimeout(() => process.exit(0), 20000);
`;

const SHA_NEW = "a".repeat(64);
const SHA_OLD = "b".repeat(64);

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

interface Scenario {
  rollback: boolean;
  env?: Record<string, string>;
  /** Defaults: 0.5.0 → 0.5.1, contents "old" → "new". */
  from?: string;
  to?: string;
  oldContent?: string;
  newContent?: string;
  state?: Partial<UpgradeState>;
  /** An installed-release.json already on disk before the run. */
  record?: { version: string; sha256: string };
}

async function runUpdater(scenario: Scenario): Promise<{
  result: UpgradeResult;
  installed: string;
  installedContent: string;
  record: { version: string; sha256: string } | undefined;
  log: string;
  lockGone: boolean;
}> {
  const from = scenario.from ?? "0.5.0";
  const to = scenario.to ?? "0.5.1";
  const oldContent = scenario.oldContent ?? "old";
  const root = await mkdtemp(path.join(tmpdir(), "hf-updater-"));
  roots.push(root);
  const dir = upgradesDir(root);
  await mkdir(path.join(dir, "new"), { recursive: true });
  await mkdir(path.join(dir, "old"), { recursive: true });
  const tarball = path.join(dir, "new", `homefleet-${to}.tgz`);
  const rollback = path.join(dir, "old", `homefleet-${from}.tgz`);
  await writeFile(tarball, scenario.newContent ?? "new");
  await writeFile(rollback, oldContent);
  const fakeNpm = path.join(root, "fake-npm.mjs");
  const fakeDaemon = path.join(root, "fake-daemon.mjs");
  await writeFile(fakeNpm, FAKE_NPM);
  await writeFile(fakeDaemon, FAKE_DAEMON);
  const installed = path.join(root, "installed.json");
  await writeFile(
    installed,
    JSON.stringify({ version: from, content: oldContent }),
  );
  if (scenario.record !== undefined) {
    await writeInstalledRelease(root, scenario.record);
  }
  const pids = path.join(root, "pids.txt");
  pidFiles.push(pids);

  // The "old daemon": exits on its own shortly, like a graceful stop would.
  const oldDaemon = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 300)",
  ]);
  const port = await freePort();
  const state: UpgradeState = {
    from,
    to,
    tarballPath: tarball,
    toSha256: SHA_NEW,
    ...(scenario.rollback ? { rollbackTarballPath: rollback } : {}),
    daemonPid: oldDaemon.pid ?? 0,
    nodePath: process.execPath,
    argv: [fakeDaemon, String(port), root],
    controlHost: "127.0.0.1",
    controlPort: port,
    installCommand: [process.execPath, fakeNpm],
    dataDir: root,
    exitTimeoutMs: 5_000,
    healthTimeoutMs: 3_000,
    ...scenario.state,
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
  const now = JSON.parse(await readFile(installed, "utf8")) as {
    version: string;
    content: string;
  };
  const record = await readFile(path.join(root, INSTALLED_FILE), "utf8").then(
    (text) => JSON.parse(text) as { version: string; sha256: string },
    () => undefined,
  );
  return {
    result: JSON.parse(
      await readFile(path.join(root, RESULT_FILE), "utf8"),
    ) as UpgradeResult,
    installed: now.version,
    installedContent: now.content,
    record,
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

describe("installed-release.json", () => {
  test("success writes installed-release.json with the target hash before launch", async () => {
    const run = await runUpdater({
      rollback: true,
      record: { version: "0.5.0", sha256: SHA_OLD },
      // A candidate install succeeds only if the relaunched daemon read the
      // new record at boot, so this proves the write came before launch.
      state: { candidate: true },
    });
    expect(run.result.outcome).toBe("succeeded");
    expect(run.record).toEqual({ version: "0.5.1", sha256: SHA_NEW });
  });

  test("a rollback writes the from hash", async () => {
    const run = await runUpdater({
      rollback: true,
      env: { FAKE_BROKEN: "0.5.1" },
      state: { fromSha256: SHA_OLD },
    });
    expect(run.result.outcome).toBe("rolled-back");
    expect(run.record).toEqual({ version: "0.5.0", sha256: SHA_OLD });
  });

  test("a rollback removes the record when fromSha256 is unknown", async () => {
    const run = await runUpdater({
      rollback: true,
      env: { FAKE_BROKEN: "0.5.1" },
      record: { version: "0.5.0", sha256: SHA_OLD },
    });
    expect(run.result.outcome).toBe("rolled-back");
    expect(run.record).toBeUndefined();
  });

  test("a failed install with no rollback removes the record", async () => {
    const run = await runUpdater({
      rollback: false,
      env: { FAKE_NPM_FAIL: "0.5.1" },
      record: { version: "0.5.0", sha256: SHA_OLD },
    });
    expect(run.result.outcome).toBe("failed");
    expect(run.record).toBeUndefined();
  });

  test("a failed rollback install removes the record", async () => {
    const run = await runUpdater({
      rollback: true,
      env: { FAKE_NPM_FAIL: "0.5.1,0.5.0" },
      state: { fromSha256: SHA_OLD },
      record: { version: "0.5.0", sha256: SHA_OLD },
    });
    expect(run.result.outcome).toBe("failed");
    expect(run.record).toBeUndefined();
  });
});

describe("candidate installs check the hash", () => {
  test("candidate: success needs the target hash, not just the version", async () => {
    // The old process still answering on the port: right version, old hash.
    const run = await runUpdater({
      rollback: true,
      env: { FAKE_STALE_SHA: SHA_OLD },
      state: { candidate: true },
    });
    expect(run.result.outcome).toBe("rolled-back");
    expect(run.result.reason).toMatch(/did not report/);
  });

  test("a plain install ignores the hash", async () => {
    const run = await runUpdater({
      rollback: true,
      env: { FAKE_STALE_SHA: SHA_OLD },
    });
    expect(run.result.outcome).toBe("succeeded");
  });

  test("a same-version candidate rolls back to the previous bytes, checked by hash", async () => {
    const run = await runUpdater({
      rollback: true,
      from: "0.8.0",
      to: "0.8.0",
      oldContent: "rc1",
      newContent: "rc2",
      env: { FAKE_BROKEN: "rc2" },
      state: { candidate: true, fromSha256: SHA_OLD },
    });
    expect(run.result.outcome).toBe("rolled-back");
    expect(run.installedContent).toBe("rc1");
    expect(run.record).toEqual({ version: "0.8.0", sha256: SHA_OLD });
  });

  test("a same-version candidate rollback that comes back on the wrong bytes fails", async () => {
    const run = await runUpdater({
      rollback: true,
      from: "0.8.0",
      to: "0.8.0",
      oldContent: "rc1",
      newContent: "rc2",
      env: { FAKE_BROKEN: "rc2", FAKE_STALE_SHA: SHA_NEW },
      state: { candidate: true, fromSha256: SHA_OLD },
    });
    expect(run.result.outcome).toBe("failed");
  });
});
