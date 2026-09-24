#!/usr/bin/env node
/**
 * Smoke-tests an INSTALLED HomeFleet (the bins on PATH from `npm i -g`), the
 * way an operator would use it: start `homefleetd` against a throwaway data
 * dir, talk to it with `homefleet`, drive `homefleet-mcp-stdio` through an MCP
 * handshake, then stop the daemon.
 *
 * Plain JS with no dependencies on purpose: the release workflow's smoke job
 * runs it with bare `node` on a runner that has no pnpm install — only the
 * global HomeFleet install under test.
 *
 * Usage: node scripts/smoke-installed.mjs <expected-version>
 * Optional env HOMEFLEET_BIN_DIR: directory holding the bins (for an
 * isolated `npm i -g --prefix` install); defaults to resolving from PATH.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const expectedVersion = process.argv[2];
if (expectedVersion === undefined) {
  console.error("usage: node scripts/smoke-installed.mjs <expected-version>");
  process.exit(2);
}

const windows = process.platform === "win32";
// Fixed high ports, loopback only, no LAN discovery: the smoke must not
// collide with — or announce itself to — a real daemon on the same machine.
const PORTS = { hfp: 47_801, mcp: 47_802, control: 47_803 };
const STARTUP_TIMEOUT_MS = 30_000;

/** The launcher npm installed for `name` (the `.cmd` shim on Windows). */
function bin(name) {
  const dir = process.env.HOMEFLEET_BIN_DIR;
  if (dir === undefined || dir === "") return name;
  return path.join(dir, windows ? `${name}.cmd` : name);
}

/**
 * WHY a shell on Windows: npm's `.cmd` shims can only be launched through
 * one (Node refuses to spawn `.cmd` directly). Paths are quoted for cmd.
 */
function spawnBin(name, args, options) {
  const command = bin(name);
  return windows
    ? spawn([`"${command}"`, ...args].join(" "), { ...options, shell: true })
    : spawn(command, args, options);
}

function runBin(name, args, env) {
  const command = bin(name);
  const result = windows
    ? spawnSync([`"${command}"`, ...args].join(" "), {
        env,
        shell: true,
        encoding: "utf8",
      })
    : spawnSync(command, args, { env, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function check(condition, message, detail = "") {
  if (!condition) {
    throw new Error(`${message}${detail === "" ? "" : `\n${detail}`}`);
  }
  console.log(`ok - ${message}`);
}

/** Kills the daemon and, on Windows, the cmd shim's whole process tree. */
function stop(child) {
  if (child.exitCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (windows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGTERM");
  }
  return Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
}

/** Sends JSON-RPC lines to the stdio MCP shim and collects replies by id. */
async function mcpHandshake(env) {
  const child = spawnBin("homefleet-mcp-stdio", [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const replies = new Map();
  const waiters = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          replies.set(message.id, message);
          waiters.get(message.id)?.();
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  const request = (id, method, params) => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no MCP reply to ${method}\n${stderr}`)),
        15_000,
      );
      waiters.set(id, () => {
        clearTimeout(timer);
        resolve(replies.get(id));
      });
    });
  };
  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "homefleet-smoke", version: "0" },
    });
    check(
      init.result?.serverInfo !== undefined,
      "homefleet-mcp-stdio answers initialize",
      JSON.stringify(init),
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const tools = await request(2, "tools/list", {});
    const names = (tools.result?.tools ?? []).map((tool) => tool.name);
    check(
      names.includes("list_nodes") && names.includes("delegate_task"),
      `homefleet-mcp-stdio lists its tools (${names.join(", ")})`,
      JSON.stringify(tools),
    );
  } finally {
    child.stdin.end();
    await stop(child);
  }
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "homefleet-smoke-"));
  const env = { ...process.env, HOMEFLEET_DATA_DIR: dataDir };
  await writeFile(
    path.join(dataDir, "config.json"),
    `${JSON.stringify(
      {
        discovery: { mdnsEnabled: false, udpEnabled: false },
        hfp: { host: "127.0.0.1", port: PORTS.hfp },
        mcp: { port: PORTS.mcp },
        control: { port: PORTS.control },
      },
      null,
      2,
    )}\n`,
  );

  let daemonLog = "";
  const daemon = spawnBin("homefleetd", [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (chunk) => {
    daemonLog += chunk;
  });
  daemon.stderr.on("data", (chunk) => {
    daemonLog += chunk;
  });

  try {
    // `homefleet status` fails (exit 1, "daemon unreachable") until the
    // daemon's control server is up; poll until it answers.
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let status = runBin("homefleet", ["status"], env);
    while (status.status !== 0 && Date.now() < deadline) {
      if (daemon.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = runBin("homefleet", ["status"], env);
    }
    check(
      status.status === 0,
      "homefleetd starts and `homefleet status` reaches it",
      `status: ${JSON.stringify(status)}\ndaemon log:\n${daemonLog}`,
    );
    check(
      status.stdout.includes(`daemonVersion: ${expectedVersion}`),
      `the running daemon reports version ${expectedVersion}`,
      status.stdout,
    );
    check(
      status.stdout.includes(`controlPort: ${PORTS.control}`),
      "the daemon loaded the smoke config",
      status.stdout,
    );

    const nodes = runBin("homefleet", ["nodes"], env);
    check(
      nodes.status === 0 && nodes.stdout.includes("No paired nodes yet."),
      "`homefleet nodes` works against the running daemon",
      JSON.stringify(nodes),
    );

    const setup = runBin("homefleet", ["setup"], env);
    check(
      setup.status === 0,
      "`homefleet setup` succeeds",
      JSON.stringify(setup),
    );
    if (windows) {
      // The autostart task must launch the INSTALLED daemon, resolved next to
      // the installed CLI — not a source checkout's dist/bin.
      const entry = /\\"[^"]*?\\" \\"([^"]*?homefleetd\.js)\\"/.exec(
        setup.stdout,
      );
      check(
        entry !== null && existsSync(entry[1]),
        `setup's autostart command points at an existing homefleetd.js (${entry?.[1]})`,
        setup.stdout,
      );
    }

    await mcpHandshake(env);
  } finally {
    await stop(daemon);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log("smoke passed");
}

main().catch((error) => {
  console.error(`not ok - ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
