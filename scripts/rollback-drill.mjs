#!/usr/bin/env node
/**
 * Rollback drill (fleet-upgrade plan, Task 17 step 4): proves on a REAL
 * installed node that the detached updater rolls back a release whose
 * daemon won't start.
 *
 * Why it drives the updater directly instead of `homefleet upgrade`: a
 * broken release would need a real-key signature to get past the daemon's
 * verification, and a deliberately broken build should never carry one. The
 * signature check and guards are proven by a real upgrade instead; this
 * drill covers what that run can't: install → failed health check →
 * reinstall of the cached signed tarball → relaunch.
 *
 * It needs a node that has completed at least one real `homefleet upgrade`.
 * That run leaves `upgrades/updater.mjs` (the real updater, written by the
 * daemon) and `upgrades/<current>/homefleet-<current>.tgz` (the verified
 * rollback copy). The drill then:
 *   1. builds a broken `homefleet-<current+1>.tgz` from that tarball (same
 *      package, bumped version, a homefleetd.js that exits at startup);
 *   2. writes upgrade-state.json + the lock and starts the updater detached.
 *      The updater hard-kills the running daemon after `exitTimeoutMs`,
 *      unlike a real upgrade, which stops it gracefully;
 *   3. waits for upgrade-result.json and checks that the daemon is back on
 *      <current>.
 *
 * Zero dependencies; Windows-first like the rig (finds the daemon via CIM).
 * Usage: node scripts/rollback-drill.mjs [--dry-run] [--port <controlPort>]
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const portArg = args.indexOf("--port");

class DrillFailure extends Error {}
function fail(message) {
  throw new DrillFailure(message);
}
function log(message) {
  process.stdout.write(`${message}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dataDir =
  process.env.HOMEFLEET_DATA_DIR ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "homefleet",
  );
const upgradesDir = path.join(dataDir, "upgrades");

function controlPort() {
  if (portArg !== -1) {
    return Number(args[portArg + 1]);
  }
  try {
    const config = JSON.parse(
      readFileSync(path.join(dataDir, "config.json"), "utf8"),
    );
    return config.control?.port ?? 56373;
  } catch {
    return 56373;
  }
}
const port = controlPort();

async function status() {
  const response = await fetch(`http://127.0.0.1:${port}/control/status`, {
    headers: { "x-homefleet-control": "1" },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  return response.json();
}

function daemonProcesses() {
  const json = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object CommandLine -like '*homefleetd*' | " +
        "Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  if (json === "") {
    return [];
  }
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  if (process.platform !== "win32") {
    fail("Windows only for now (it finds the daemon process via CIM)");
  }
  // --- 1. Preconditions -------------------------------------------------------

  let current;
  try {
    current = (await status()).daemonVersion;
  } catch (error) {
    fail(`no daemon answering on 127.0.0.1:${port} (${error.message})`);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (m === null) {
    fail(`unexpected daemon version "${current}"`);
  }
  const drill = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  const rollbackTarball = path.join(
    upgradesDir,
    current,
    `homefleet-${current}.tgz`,
  );
  const updaterPath = path.join(upgradesDir, "updater.mjs");
  const lockPath = path.join(upgradesDir, "upgrade.lock");
  const resultPath = path.join(dataDir, "upgrade-result.json");

  for (const [file, why] of [
    [rollbackTarball, `the verified ${current} tarball`],
    [updaterPath, "the updater a real upgrade copies there"],
  ]) {
    if (!existsSync(file)) {
      fail(
        `missing ${file} (${why}); run one real "homefleet upgrade" on this node first`,
      );
    }
  }
  if (existsSync(lockPath)) {
    fail(`${lockPath} exists: an upgrade may be in progress`);
  }
  const daemons = daemonProcesses();
  if (daemons.length !== 1) {
    fail(`expected exactly one homefleetd process, found ${daemons.length}`);
  }
  const daemonPid = daemons[0].ProcessId;
  const npmRoot = execSync("npm root -g", {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const entry = path.join(npmRoot, "homefleet", "dist", "bin", "homefleetd.js");
  if (
    !daemons[0].CommandLine.includes(
      path.join("homefleet", "dist", "bin", "homefleetd.js"),
    )
  ) {
    fail(
      `the running daemon is not the npm-installed one: ${daemons[0].CommandLine}`,
    );
  }
  log(`daemon ${current} (pid ${daemonPid}); drilling a broken ${drill}`);

  // --- 2. Build the broken tarball -------------------------------------------

  const work = mkdtempSync(path.join(os.tmpdir(), "hf-drill-"));
  const drillDir = path.join(upgradesDir, `drill-${drill}`);
  const brokenTarball = path.join(drillDir, `homefleet-${drill}.tgz`);
  try {
    execFileSync("tar", ["-xzf", rollbackTarball, "-C", work], {
      windowsHide: true,
    });
    const pkgPath = path.join(work, "package", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = drill;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(
      path.join(work, "package", "dist", "bin", "homefleetd.js"),
      `#!/usr/bin/env node\nprocess.stderr.write("homefleetd ${drill}: rollback drill build, exiting\\n");\nprocess.exit(1);\n`,
    );
    rmSync(drillDir, { recursive: true, force: true });
    mkdirSync(drillDir, { recursive: true });
    execFileSync("tar", ["-czf", brokenTarball, "-C", work, "package"], {
      windowsHide: true,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log(`built ${brokenTarball}`);

  // --- 3. Hand off to the real updater ---------------------------------------

  const state = {
    from: current,
    to: drill,
    tarballPath: brokenTarball,
    rollbackTarballPath: rollbackTarball,
    daemonPid,
    nodePath: process.execPath,
    argv: [entry],
    controlHost: "127.0.0.1",
    controlPort: port,
    installCommand: ["npm.cmd", "i", "-g"],
    dataDir,
    exitTimeoutMs: 5_000,
    healthTimeoutMs: 60_000,
  };
  if (dryRun) {
    log(JSON.stringify(state, null, 2));
    log("dry run: nothing started (the broken tarball is left in place)");
    return 0;
  }
  const statePath = path.join(upgradesDir, "upgrade-state.json");
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, at: Date.now() }),
    {
      flag: "wx",
    },
  );
  const startedAt = Date.now();
  spawn(process.execPath, [updaterPath, statePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  log(
    "updater started; it stops the daemon, installs the broken build, then rolls back (up to ~3 min)",
  );

  const deadline = startedAt + 4 * 60_000;
  let result;
  while (Date.now() < deadline) {
    await sleep(2_000);
    try {
      const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
      if (parsed.to === drill && parsed.at >= startedAt) {
        result = parsed;
        break;
      }
    } catch {
      // not written yet
    }
  }
  if (result === undefined) {
    fail(`no result after 4 min; see ${path.join(upgradesDir, "updater.log")}`);
  }
  log(`result: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);

  let back;
  for (let attempt = 0; attempt < 15 && back === undefined; attempt++) {
    try {
      back = (await status()).daemonVersion;
    } catch {
      await sleep(2_000);
    }
  }
  log(`daemon now reports: ${back ?? "nothing"}`);
  rmSync(drillDir, { recursive: true, force: true });
  if (result.outcome === "rolled-back" && back === current) {
    log(`PASS: the broken ${drill} was rolled back to ${current}`);
    return 0;
  }
  fail(
    `FAIL: expected rolled-back + ${current}, got ${result.outcome} + ${back ?? "no daemon"}`,
  );
}

// process.exit() right after fetch() trips a libuv assertion on Windows
// (UV_HANDLE_CLOSING) while undici sockets are closing, so set the exit code
// and let the event loop drain instead.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `rollback-drill: ${error instanceof DrillFailure ? error.message : (error?.stack ?? error)}
`,
    );
    process.exitCode = 1;
  },
);
