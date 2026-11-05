/**
 * Real-I/O tier for `homefleet daemon`: builds the bins, then drives the
 * BUILT `homefleet.js daemon status|start|stop` against a real homefleetd in
 * a temp data dir (loopback only, discovery off, its own control port).
 *
 * WHY the build goes to a private directory under
 * packages/daemon/node_modules/.cache: third-party deps stay external in the
 * bins (see tsup.config.ts), so the built files must sit where Node's
 * resolver finds packages/daemon/node_modules. Never the real dist/bin: that
 * is what an autostart task may run (see scripts/lib/pack.integration.test.ts).
 *
 * `--allow-packaged` is passed because this suite may itself run inside a
 * packaged app (a Claude desktop shell); the test daemon lives in a temp dir
 * and is stopped by the suite, so that is fine here.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isPidAlive, killPid } from "./daemon-lifecycle.js";

const daemonDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

let buildDir: string;
let dataDir: string;
let startedPid: number | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function cli(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(buildDir, "homefleet.js"), "daemon", ...args],
    {
      env: { ...process.env, HOMEFLEET_DATA_DIR: dataDir },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    },
  );
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
  };
}

beforeAll(async () => {
  const cache = path.join(daemonDir, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  buildDir = mkdtempSync(path.join(cache, "hf-lifecycle-"));
  // One command string: pnpm is a .cmd shim on Windows, so it needs a shell,
  // and passing args alongside `shell: true` is deprecated (DEP0190).
  const build = spawnSync(`pnpm exec tsup --out-dir "${buildDir}"`, {
    cwd: daemonDir,
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  if (build.status !== 0) {
    throw new Error(`tsup build failed:\n${build.stdout}\n${build.stderr}`);
  }
  dataDir = mkdtempSync(path.join(tmpdir(), "hf-lifecycle-data-"));
  writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      discovery: { mdnsEnabled: false, udpEnabled: false },
      hfp: { host: "127.0.0.1", port: 0 },
      mcp: { port: await freePort() },
      control: { port: await freePort() },
    }),
  );
}, 180_000); // a tsup build; slow on Windows

afterAll(() => {
  if (startedPid !== undefined && isPidAlive(startedPid)) {
    killPid(startedPid);
  }
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("status, start, status, start again, stop, status against a real daemon", () => {
  const before = cli("status");
  expect(before.code, before.out).toBe(3);
  expect(before.out).toContain("is not running");

  const start = cli("start", "--allow-packaged");
  expect(start.code, start.out).toBe(0);
  const pid = Number(/started \(pid (\d+)/.exec(start.out)?.[1]);
  expect(pid).toBeGreaterThan(0);
  startedPid = pid;
  expect(isPidAlive(pid)).toBe(true);

  const running = cli("status");
  expect(running.code, running.out).toBe(0);
  expect(running.out).toContain(`is running (pid ${pid},`);

  const again = cli("start", "--allow-packaged");
  expect(again.code, again.out).toBe(0);
  expect(again.out).toContain(`already running (pid ${pid})`);

  const stop = cli("stop");
  expect(stop.code, stop.out).toBe(0);
  expect(stop.out).toContain("homefleetd stopped.");
  expect(isPidAlive(pid)).toBe(false);

  const after = cli("status");
  expect(after.code, after.out).toBe(3);
  expect(after.out).toContain("last log line:");
  // A graceful stop, not a kill: the daemon logged why it shut down.
  expect(readFileSync(path.join(dataDir, "homefleetd.log"), "utf8")).toContain(
    "homefleetd: stop requested, shutting down",
  );
}, 120_000);
