/**
 * `homefleet` — the operator's command-line tool (M9 Unit 9).
 *
 * `runCli` is the ENTIRE CLI, expressed as a pure-ish function of `(argv,
 * deps) -> exit code`: it never touches `process.exit`, `process.stdout`,
 * real `fs`, or the real network directly — every side effect it needs
 * (loading config, ensuring identity, talking to the daemon, writing output)
 * is injected via {@link CliDeps}. That's what lets cli.test.ts drive every
 * subcommand, including `setup`, without a real data directory or a running
 * daemon: the bin (../bin/homefleet.ts) is the only place real dependencies
 * get wired in.
 *
 * `setup` vs. `pair`/`nodes`/`status` split along one line: `setup` only
 * PRINTS commands for a human to run and reads local config/identity (no
 * network, no daemon needed); the other three all talk to the RUNNING
 * daemon's control API (see ../control/control-server.ts) because pairing
 * state and live status/node data only exist in that running process.
 */
import { fileURLToPath } from "node:url";
import type { DaemonConfig } from "../config/config.js";
import {
  type ControlClientLike,
  ControlRequestError,
  DaemonUnreachableError,
} from "./control-client.js";
import {
  generateAutostartCreateCommand,
  generateFirewallAllowCommands,
  PUBLIC_PROFILE_WARNING,
  publicProfileCheckCommand,
} from "./setup-commands.js";

/** The identity fields `setup` needs; `loadOrCreateIdentity`'s result satisfies this. */
export interface CliIdentity {
  deviceId: string;
}

export interface CliDeps {
  /** Resolved daemon data directory (see ../config/paths.ts's `resolveDataDir`). */
  dataDir: string;
  /** Loads the daemon config from `dataDir` (real: `loadDaemonConfig`). */
  loadConfig: (dataDir: string) => Promise<DaemonConfig>;
  /** Ensures the device identity exists, generating it on first run (real: `loadOrCreateIdentity`). */
  ensureIdentity: (dataDir: string) => Promise<CliIdentity>;
  /** Builds a control-API client for `host:port` (real: `new ControlClient(...)`). */
  makeControlClient: (options: {
    host: string;
    port: number;
  }) => ControlClientLike;
  /** Writes one line (no trailing newline management needed by callers) to stdout. */
  stdout: (line: string) => void;
  /** Writes one line to stderr. */
  stderr: (line: string) => void;
  /**
   * Absolute path to the `node` executable `setup`'s autostart command should
   * invoke. Defaults to `process.execPath`; overridable so tests don't depend
   * on the host's actual Node install path.
   */
  nodeExecPath?: string;
  /**
   * Absolute path to the daemon entry point `setup`'s autostart command
   * should launch. Defaults to the built `homefleetd.js` sibling (see
   * `defaultDaemonEntryPath`); overridable for tests or a non-standard layout.
   */
  daemonEntryPath?: string;
}

const USAGE = `homefleet - HomeFleet operator CLI

Usage:
  homefleet setup
      Scaffold this machine: print this node's identity, the firewall/
      autostart commands to run (in an elevated PowerShell), and a
      network-profile check. Does not require the daemon to be running.

  homefleet pair begin
      Open a pairing window on THIS node's running daemon and print the code.

  homefleet pair connect <host> <port> <code> [--expect <deviceId>]
      Pair THIS node's running daemon with a peer at <host>:<port> using the
      code shown by that peer's "pair begin". --expect pins the expected
      peer device ID.

  homefleet nodes
      List this node's paired peers (from the running daemon).

  homefleet status
      Show this node's live status (from the running daemon).

  homefleet --help
      Show this usage text.
`;

/**
 * Default daemon entry path for the generated autostart command: the BUILT
 * `homefleetd.js`, resolved as a sibling of the running module rather than
 * hardcoded. In the packaged CLI (dist/bin/homefleet.js) this resolves to
 * dist/bin/homefleetd.js — the bare-node-runnable entry a Task Scheduler task
 * must launch (the daemon no longer runs from .ts under tsx; see Unit 10's
 * build step). Overridable via CliDeps.daemonEntryPath — for tests, or when
 * invoking the CLI from source, where a sibling `homefleetd.js` does not exist.
 */
function defaultDaemonEntryPath(): string {
  return fileURLToPath(new URL("./homefleetd.js", import.meta.url));
}

/**
 * Loads config and builds a control client, runs `action` against it, and
 * maps a {@link DaemonUnreachableError} to a friendly stderr message + exit
 * code 1 — the one place every daemon-talking subcommand shares that
 * behavior, so none of them can forget it (see the Unit brief: "never leak a
 * stack").
 */
async function withControlClient(
  deps: CliDeps,
  action: (client: ControlClientLike, config: DaemonConfig) => Promise<number>,
): Promise<number> {
  const config = await deps.loadConfig(deps.dataDir);
  const client = deps.makeControlClient({
    host: config.control.host,
    port: config.control.port,
  });
  try {
    return await action(client, config);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      deps.stderr(
        `Could not reach the homefleet daemon on ${error.host}:${error.port}. ` +
          "Is homefleetd running?",
      );
      return 1;
    }
    throw error;
  }
}

function shortId(deviceId: string): string {
  return `${deviceId.slice(0, 12)}…`;
}

async function runSetup(deps: CliDeps): Promise<number> {
  const config = await deps.loadConfig(deps.dataDir);
  const identity = await deps.ensureIdentity(deps.dataDir);
  const nodeExecPath = deps.nodeExecPath ?? process.execPath;
  const daemonEntryPath = deps.daemonEntryPath ?? defaultDaemonEntryPath();

  deps.stdout("HomeFleet node setup");
  deps.stdout("====================");
  deps.stdout(`deviceId: ${identity.deviceId}`);
  deps.stdout(
    `name: ${config.node.name ?? "(unset — falls back to this machine's hostname at daemon startup)"}`,
  );
  deps.stdout(
    `ports: hfp=${config.hfp.port} discovery-udp=${config.discovery.udpPort} ` +
      `mcp=${config.mcp.port} control=${config.control.port}`,
  );
  deps.stdout("");
  deps.stdout("Run these in an ELEVATED PowerShell:");
  for (const command of generateFirewallAllowCommands({
    hfpPort: config.hfp.port,
    udpPort: config.discovery.udpPort,
  })) {
    deps.stdout(`  ${command}`);
  }
  deps.stdout("");
  deps.stdout(
    "Then check the network profile (the rules above only apply on 'Private'):",
  );
  deps.stdout(`  ${publicProfileCheckCommand()}`);
  deps.stdout(PUBLIC_PROFILE_WARNING);
  deps.stdout("");
  deps.stdout("To start homefleetd automatically at logon, run:");
  deps.stdout(
    `  ${generateAutostartCreateCommand({ nodeExecPath, daemonEntryPath })}`,
  );
  deps.stdout(
    "(The path above is the built daemon entry — run `pnpm build` first so it " +
      "exists. If you invoke the CLI from source rather than the packaged bin, " +
      "pass the real homefleetd.js path.)",
  );
  return 0;
}

async function runPairBegin(deps: CliDeps): Promise<number> {
  return withControlClient(deps, async (client, config) => {
    const result = await client.pairBegin();
    deps.stdout(`Pairing code: ${result.code}`);
    if (result.expiresAt !== undefined) {
      deps.stdout(`Expires: ${new Date(result.expiresAt).toISOString()}`);
    }
    deps.stdout("");
    deps.stdout("On the OTHER machine run:");
    // This node's LAN-reachable address is not reliably known from config
    // (hfp.host defaults to 0.0.0.0, a bind address, not a routable one) —
    // print a placeholder for Hugo to fill in rather than guess wrong.
    deps.stdout(
      `  homefleet pair connect <this-host> ${config.hfp.port} ${result.code}`,
    );
    return 0;
  });
}

interface ParsedPairConnectArgs {
  host: string;
  port: number;
  code: string;
  expectedDeviceId?: string;
}

/** Returns `undefined` (after writing a usage error to stderr) on any parse failure. */
function parsePairConnectArgs(
  args: string[],
  deps: CliDeps,
): ParsedPairConnectArgs | undefined {
  const positional: string[] = [];
  let expectedDeviceId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--expect") {
      i += 1;
      const value = args[i];
      if (value === undefined) {
        deps.stderr("pair connect: --expect requires a deviceId argument");
        return undefined;
      }
      expectedDeviceId = value;
    } else {
      positional.push(arg as string);
    }
  }
  const [host, portText, code] = positional;
  if (host === undefined || portText === undefined || code === undefined) {
    deps.stderr(
      "usage: homefleet pair connect <host> <port> <code> [--expect <deviceId>]",
    );
    return undefined;
  }
  if (positional.length > 3) {
    deps.stderr(
      `pair connect: unexpected extra argument(s): ${positional.slice(3).join(" ")}`,
    );
    return undefined;
  }
  if (host.trim().length === 0) {
    deps.stderr("pair connect: host must not be empty");
    return undefined;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    deps.stderr(`pair connect: invalid port "${portText}"`);
    return undefined;
  }
  return expectedDeviceId === undefined
    ? { host, port, code }
    : { host, port, code, expectedDeviceId };
}

async function runPairConnect(args: string[], deps: CliDeps): Promise<number> {
  const parsed = parsePairConnectArgs(args, deps);
  if (parsed === undefined) {
    return 2;
  }
  return withControlClient(deps, async (client) => {
    let summary: Awaited<ReturnType<ControlClientLike["pairConnect"]>>;
    try {
      summary = await client.pairConnect(parsed);
    } catch (error) {
      // A 502 from the daemon means the ATTEMPT against the peer couldn't
      // complete (unreachable, timeout, TLS/fingerprint failure — see
      // control-server.ts's pairingErrorStatus) — distinct from THIS node's
      // own daemon being unreachable (DaemonUnreachableError, handled by
      // withControlClient) and worth the same "who's actually down" framing.
      if (error instanceof ControlRequestError && error.status === 502) {
        deps.stderr(
          `Could not reach the peer at ${parsed.host}:${parsed.port}: ${error.message}`,
        );
        return 1;
      }
      throw error;
    }
    if (summary.accepted) {
      const idText =
        summary.deviceId !== undefined ? shortId(summary.deviceId) : "unknown";
      deps.stdout(`Paired with "${summary.name ?? "unknown"}" (${idText}).`);
      return 0;
    }
    deps.stderr(
      "Pairing rejected: the code is wrong, expired, or already used.",
    );
    return 1;
  });
}

async function runPair(args: string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "begin") {
    if (rest.length > 0) {
      deps.stderr(
        `pair begin: unexpected extra argument(s): ${rest.join(" ")}`,
      );
      return 2;
    }
    return runPairBegin(deps);
  }
  if (sub === "connect") {
    return runPairConnect(rest, deps);
  }
  deps.stderr("usage: homefleet pair <begin|connect> ...");
  return 2;
}

async function runNodes(deps: CliDeps): Promise<number> {
  return withControlClient(deps, async (client) => {
    const nodes = await client.nodes();
    if (nodes.length === 0) {
      deps.stdout("No paired nodes yet.");
      return 0;
    }
    const headers = [
      "NAME",
      "DEVICE ID",
      "REACHABLE",
      "ROLES",
      "EXECUTORS",
      "MODELS",
    ];
    const rows = nodes.map((node) => [
      node.name,
      shortId(node.deviceId),
      node.reachable ? "yes" : "no",
      node.nodeInfo !== undefined ? node.nodeInfo.roles.join(",") || "-" : "-",
      node.nodeInfo !== undefined
        ? node.nodeInfo.executors.join(",") || "-"
        : "-",
      node.nodeInfo !== undefined && node.nodeInfo.models.length > 0
        ? node.nodeInfo.models.map((model) => model.id).join(",")
        : "-",
    ]);
    const widths = headers.map((header, columnIndex) =>
      Math.max(
        header.length,
        ...rows.map((row) => (row[columnIndex] as string).length),
      ),
    );
    const formatRow = (cells: string[]): string =>
      cells
        .map((cell, columnIndex) => cell.padEnd(widths[columnIndex] as number))
        .join("  ")
        .trimEnd();
    deps.stdout(formatRow(headers));
    for (const row of rows) {
      deps.stdout(formatRow(row));
    }
    return 0;
  });
}

async function runStatus(deps: CliDeps): Promise<number> {
  return withControlClient(deps, async (client) => {
    const status = await client.status();
    deps.stdout(`deviceId: ${status.deviceId}`);
    deps.stdout(`name: ${status.name}`);
    deps.stdout(`platform: ${status.platform}`);
    deps.stdout(`daemonVersion: ${status.daemonVersion}`);
    deps.stdout(`protocolVersion: ${status.protocolVersion}`);
    deps.stdout(`hfpPort: ${status.hfpPort}`);
    deps.stdout(`mcpPort: ${status.mcpPort}`);
    deps.stdout(`controlPort: ${status.controlPort}`);
    deps.stdout(`roles: ${status.roles.join(", ") || "(none)"}`);
    deps.stdout(`executors: ${status.executors.join(", ") || "(none)"}`);
    deps.stdout(
      `models: ${status.models.map((model) => model.id).join(", ") || "(none)"}`,
    );
    deps.stdout(`activeJobs: ${status.activeJobs}`);
    deps.stdout(`maxConcurrentJobs: ${status.maxConcurrentJobs}`);
    return 0;
  });
}

async function dispatch(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }
  switch (command) {
    case "setup":
      return runSetup(deps);
    case "pair":
      return runPair(rest, deps);
    case "nodes":
      if (rest.length > 0) {
        deps.stderr(`nodes: unexpected extra argument(s): ${rest.join(" ")}`);
        return 2;
      }
      return runNodes(deps);
    case "status":
      if (rest.length > 0) {
        deps.stderr(`status: unexpected extra argument(s): ${rest.join(" ")}`);
        return 2;
      }
      return runStatus(deps);
    default:
      deps.stderr(USAGE);
      return 2;
  }
}

/**
 * Runs the CLI end to end and returns an exit code. NEVER calls
 * `process.exit` — the bin (../bin/homefleet.ts) owns that, which is what
 * lets this function be driven directly and synchronously-awaited in tests.
 *
 * The outer try/catch is the last line of defense for the "never leak a
 * stack" rule: `withControlClient` already handles the specific, expected
 * `DaemonUnreachableError` case per-subcommand, but anything else unexpected
 * (a corrupt config file, a corrupt identity, a daemon bug surfaced as a
 * `ControlRequestError`) still becomes a clean one-line message here instead
 * of an uncaught rejection reaching the bin.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    deps.stderr(
      `homefleet: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
