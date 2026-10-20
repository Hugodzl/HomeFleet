#!/usr/bin/env node
/**
 * HomeFleet's detached upgrade helper (fleet-upgrade spec, Phase 2).
 *
 * The daemon writes upgrades/upgrade-state.json, COPIES this file into
 * <dataDir>/upgrades/ (so `npm i -g` never replaces the script that is
 * running), starts it detached and shuts itself down. This script then:
 * waits for the old daemon to exit → installs the new tarball → relaunches
 * the daemon → waits for /control/status to report the new version → on any
 * failure reinstalls the cached previous tarball and relaunches that →
 * writes <dataDir>/upgrade-result.json and removes the lock.
 *
 * Zero dependencies, plain JS: it runs from the data dir, outside any
 * node_modules. File names mirror ./files.ts (updater.test.ts drives this
 * script through those constants, so they cannot drift silently).
 *
 * Usage: node updater.mjs <path to upgrade-state.json>
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const statePath = process.argv[2];
const state = JSON.parse(readFileSync(statePath, "utf8"));
const upgradesDir = path.dirname(statePath);

function log(line) {
  appendFileSync(
    path.join(upgradesDir, "updater.log"),
    `${new Date().toISOString()} ${line}\n`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function kill(pid) {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      log(`pid ${pid} still running after ${timeoutMs} ms; killing it`);
      kill(pid);
      await sleep(1000);
      return;
    }
    await sleep(200);
  }
}

function install(tarballPath) {
  const [command, ...args] = state.installCommand;
  const all = [...args, tarballPath];
  log(`installing ${tarballPath}`);
  // npm's Windows launcher is a .cmd shim, which Node only spawns via a shell.
  const result = command.endsWith(".cmd")
    ? spawnSync([command, ...all.map((arg) => `"${arg}"`)].join(" "), {
        shell: true,
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync(command, all, { encoding: "utf8", windowsHide: true });
  if (result.stdout) log(result.stdout.trimEnd());
  if (result.stderr) log(result.stderr.trimEnd());
  if (result.status !== 0) {
    log(`install exited with ${result.status ?? result.error?.message}`);
    return false;
  }
  return true;
}

function launch() {
  const errFd = openSync(path.join(state.dataDir, "homefleetd.err.log"), "a");
  try {
    const child = spawn(state.nodePath, state.argv, {
      detached: true,
      stdio: ["ignore", "ignore", errFd],
      windowsHide: true,
    });
    child.unref();
    log(`launched daemon pid ${child.pid}`);
    return child.pid;
  } finally {
    closeSync(errFd);
  }
}

async function reportsVersion(version, timeoutMs) {
  const host = state.controlHost.includes(":")
    ? `[${state.controlHost}]`
    : state.controlHost;
  const url = `http://${host}:${state.controlPort}/control/status`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { "x-homefleet-control": "1" },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.daemonVersion === version) return true;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

async function recover(reason) {
  if (state.rollbackTarballPath && install(state.rollbackTarballPath)) {
    const pid = launch();
    if (await reportsVersion(state.from, state.healthTimeoutMs)) {
      return { outcome: "rolled-back", reason };
    }
    kill(pid);
    return {
      outcome: "failed",
      reason: `${reason}; the rolled-back ${state.from} daemon did not come up either`,
    };
  }
  // No rollback copy: start whatever is installed rather than leave the
  // node with no daemon at all.
  launch();
  return { outcome: "failed", reason: `${reason}; rollback unavailable` };
}

async function run() {
  await waitForExit(state.daemonPid, state.exitTimeoutMs);
  if (!install(state.tarballPath)) {
    return recover(`npm install of ${state.to} failed (see updater.log)`);
  }
  const pid = launch();
  if (await reportsVersion(state.to, state.healthTimeoutMs)) {
    return { outcome: "succeeded" };
  }
  kill(pid);
  await waitForExit(pid, state.exitTimeoutMs);
  return recover(
    `the ${state.to} daemon did not report its version within ${state.healthTimeoutMs} ms`,
  );
}

let result;
try {
  result = await run();
} catch (error) {
  result = {
    outcome: "failed",
    reason: `updater crashed: ${error instanceof Error ? error.message : String(error)}`,
  };
}
writeFileSync(
  path.join(state.dataDir, "upgrade-result.json"),
  `${JSON.stringify({ from: state.from, to: state.to, ...result, at: Date.now() })}\n`,
);
log(`result: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
rmSync(path.join(upgradesDir, "upgrade.lock"), { force: true });
