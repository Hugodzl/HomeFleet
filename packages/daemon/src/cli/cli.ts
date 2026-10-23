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
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInfo } from "@homefleet/protocol";
import type { DaemonConfig } from "../config/config.js";
import type { UpgradeStarted } from "../upgrade/coordinator.js";
import {
  UPDATER_LOG,
  type UpgradeResult,
  upgradesDir,
} from "../upgrade/files.js";
import {
  type PeerRolloutStatus,
  type RolloutStatus,
  UPGRADE_WAIT_MS,
} from "../upgrade/rollout.js";
import { isSemver } from "../upgrade/semver.js";
import { DAEMON_VERSION } from "../version.js";
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
import { resolveUnpairTarget } from "./unpair-target.js";

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
  /**
   * Checks whether a path exists on disk (real: `fs.existsSync`). Used by
   * `setup` to decide whether to print a "you need to build first" hint next
   * to the autostart command: with a packaged `npm i -g` install the resolved
   * `homefleetd.js` always exists, so the hint would be actively wrong there.
   * Defaults to `true` (assume it exists, i.e. no hint) when not supplied.
   */
  fileExists?: (path: string) => boolean;
  /**
   * Opens a URL in the default browser (real: ./open-url.js `openUrl`).
   * Optional so tests never launch a browser; absent means print-only.
   */
  openUrl?: (url: string) => Promise<void>;
  /** Clock for `upgrade`'s wait loop; defaults to `Date.now`. */
  now?: () => number;
  /** Sleep for `upgrade`'s wait loop; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Reads `<dataDir>/upgrade-result.json` (real: `readUpgradeResultSync`) —
   * `upgrade`'s last resort when the daemon never came back to report it.
   */
  readUpgradeResult?: (dataDir: string) => UpgradeResult | undefined;
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

  homefleet unpair <name|deviceId> [--yes]
      Revoke THIS node's trust in a paired peer, on the running daemon: the
      peer's requests are refused from now on and its jobs here are
      canceled. <deviceId> may be a unique prefix (8+ hex chars). Without
      --yes, prints what it would unpair and changes nothing. One-sided:
      run it on the peer too to end trust both ways.

  homefleet status
      Show this node's live status (from the running daemon).

  homefleet dashboard [--no-open]
      Print the running daemon's read-only dashboard URL and open it in
      the default browser (--no-open: print only).

  homefleet upgrade [--to <version>] [--check] [--force]
      Upgrade THIS node's running daemon to the latest signed release (or
      --to <version>), restart it in the background, and wait until it is
      back. Rolls back automatically if the new version fails to start.
      --check only reports whether an upgrade is available; --force
      upgrades even while jobs are running.

  homefleet fleet upgrade [--to <version>] [--nodes <name|id>...] [--force-local]
      Roll the latest signed release (or --to <version>) out across the
      fleet: paired peers one at a time, THIS node last, stopping at the
      first failure. --nodes limits it to the named peers (names or id
      prefixes); --force-local upgrades this node even while jobs run.
      Peers must have "upgrade.allowRemote" enabled.

  homefleet --help
      Show this usage text.

  homefleet --version
      Print the CLI version and exit.
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
  const daemonEntryExists = deps.fileExists?.(daemonEntryPath) ?? true;
  if (!daemonEntryExists) {
    deps.stdout(
      "(homefleetd.js was not found at the path above. Running from source? " +
        "Run `pnpm build` first so it exists.)",
    );
  }
  if (!config.upgrade.allowRemote) {
    deps.stdout("");
    deps.stdout(
      'Remote upgrades are off. To let a paired node upgrade this one, add "upgrade": { "allowRemote": true } to config.json.',
    );
  }
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

/**
 * `id (status)` per model — the startup probe's verdict is what tells an
 * operator WHY a node refuses model jobs (e.g. `not_served`: the model
 * server is up but serves a different id), without a control-API curl.
 */
function formatModels(models: ModelInfo[], separator: string): string {
  return models
    .map((model) =>
      model.status !== undefined ? `${model.id} (${model.status})` : model.id,
    )
    .join(separator);
}

function formatLastUpgrade(last: UpgradeResult | undefined): string {
  if (last === undefined) {
    return "(none)";
  }
  const line = `${last.from} → ${last.to} ${last.outcome} at ${new Date(last.at).toISOString()}`;
  return last.reason !== undefined ? `${line} (${last.reason})` : line;
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
      "VERSION",
      "ROLES",
      "EXECUTORS",
      "MODELS",
    ];
    const rows = nodes.map((node) => [
      node.name,
      shortId(node.deviceId),
      node.reachable ? "yes" : "no",
      node.nodeInfo?.daemonVersion ?? "-",
      node.nodeInfo !== undefined ? node.nodeInfo.roles.join(",") || "-" : "-",
      node.nodeInfo !== undefined
        ? node.nodeInfo.executors.join(",") || "-"
        : "-",
      node.nodeInfo !== undefined && node.nodeInfo.models.length > 0
        ? formatModels(node.nodeInfo.models, ",")
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

/**
 * `homefleet unpair <name|deviceId> [--yes]` (spec 2026-09-25). Resolves the
 * argument against the LIVE paired list (`/control/nodes`) with
 * {@link resolveUnpairTarget}, then — only with `--yes` — revokes the FULL
 * device ID through `/control/unpair`. Without `--yes` it is a preview that
 * exits 1 having changed nothing: the CLI never prompts (no stdin
 * dependency; agents drive it as often as people). Full ids are printed, not
 * short ones, so they can be pinned later with `pair connect --expect`.
 */
async function runUnpair(args: string[], deps: CliDeps): Promise<number> {
  const confirmed = args.includes("--yes");
  const rest = args.filter((arg) => arg !== "--yes");
  const unknownOptions = rest.filter((arg) => arg.startsWith("--"));
  if (unknownOptions.length > 0) {
    deps.stderr(`unpair: unknown option(s): ${unknownOptions.join(" ")}`);
    return 2;
  }
  if (rest.length !== 1) {
    deps.stderr("usage: homefleet unpair <name|deviceId> [--yes]");
    return 2;
  }
  const query = rest[0] as string;
  return withControlClient(deps, async (client) => {
    const resolution = resolveUnpairTarget(query, await client.nodes());
    if (resolution.kind === "none") {
      deps.stderr(
        `No paired node matches "${query}". Run "homefleet nodes" to list them.`,
      );
      return 1;
    }
    if (resolution.kind === "ambiguous") {
      deps.stderr(
        `"${query}" matches ${resolution.candidates.length} paired nodes:`,
      );
      for (const candidate of resolution.candidates) {
        deps.stderr(`  ${candidate.name}  ${candidate.deviceId}`);
      }
      deps.stderr("Re-run with the full device ID.");
      return 1;
    }
    const { node } = resolution;
    if (!confirmed) {
      deps.stdout(`Would unpair ${node.name} (${node.deviceId}).`);
      deps.stderr("Nothing changed. Re-run with --yes to confirm.");
      return 1;
    }
    let summary: Awaited<ReturnType<ControlClientLike["unpair"]>>;
    try {
      summary = await client.unpair(node.deviceId);
    } catch (error) {
      // 404: someone else unpaired it between our listing and this call.
      if (error instanceof ControlRequestError && error.status === 404) {
        deps.stderr(`${node.name} is no longer paired.`);
        return 1;
      }
      throw error;
    }
    deps.stdout(`Unpaired ${summary.name} (${summary.deviceId}).`);
    if (summary.canceledJobs > 0) {
      deps.stdout(
        `Canceled ${summary.canceledJobs} job(s) it had queued or running here.`,
      );
    }
    deps.stdout(
      `${summary.name} may still list this node as paired; run ` +
        '"homefleet unpair" there too to end trust both ways.',
    );
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
    deps.stdout(`models: ${formatModels(status.models, ", ") || "(none)"}`);
    deps.stdout(`activeJobs: ${status.activeJobs}`);
    deps.stdout(`maxConcurrentJobs: ${status.maxConcurrentJobs}`);
    deps.stdout(`lastUpgrade: ${formatLastUpgrade(status.lastUpgrade)}`);
    return 0;
  });
}

/**
 * `homefleet dashboard`: prints the read-only dashboard URL (using the
 * control port `status()` reports the daemon actually bound to, not just the
 * configured one) and opens it in the default browser. Gated on
 * `config.control.dashboard` so an operator who disabled the dashboard gets
 * a clear reason instead of a browser tab that 404s.
 */
async function runDashboard(args: string[], deps: CliDeps): Promise<number> {
  const noOpen = args.includes("--no-open");
  const extra = args.filter((arg) => arg !== "--no-open");
  if (extra.length > 0) {
    deps.stderr(`dashboard: unexpected argument(s): ${extra.join(" ")}`);
    return 2;
  }
  return withControlClient(deps, async (client, config) => {
    if (!config.control.dashboard) {
      deps.stderr(
        "The dashboard is disabled (control.dashboard is false in config.json).",
      );
      return 1;
    }
    // status() proves the daemon is up AND gives the port it actually bound.
    const status = await client.status();
    const host = config.control.host.includes(":")
      ? `[${config.control.host}]`
      : config.control.host;
    const url = `http://${host}:${status.controlPort}/`;
    deps.stdout(`HomeFleet dashboard: ${url}`);
    if (!noOpen && deps.openUrl !== undefined) {
      try {
        await deps.openUrl(url);
      } catch (error) {
        deps.stderr(
          `Could not open a browser (${
            error instanceof Error ? error.message : String(error)
          }); open the URL above by hand.`,
        );
      }
    }
    return 0;
  });
}

/** `upgrade` waits UPGRADE_WAIT_MS (spec: 3 minutes) for the restarted daemon; defined in upgrade/rollout.ts. */
export { UPGRADE_WAIT_MS } from "../upgrade/rollout.js";

const UPGRADE_POLL_MS = 2_000;

interface UpgradeArgs {
  check: boolean;
  force: boolean;
  version?: string;
}

function parseUpgradeArgs(
  args: string[],
  deps: CliDeps,
): UpgradeArgs | undefined {
  const parsed: UpgradeArgs = { check: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") {
      parsed.check = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--to") {
      const version = args[++i];
      if (version === undefined || !isSemver(version)) {
        deps.stderr("upgrade: --to requires a version like 0.5.1");
        return undefined;
      }
      parsed.version = version;
    } else {
      deps.stderr(`upgrade: unexpected argument "${arg}"`);
      return undefined;
    }
  }
  return parsed;
}

function reportUpgradeFailure(last: UpgradeResult, deps: CliDeps): number {
  const reason = last.reason ?? "no reason recorded";
  deps.stderr(
    last.outcome === "rolled-back"
      ? `Upgrade to ${last.to} failed and was rolled back to ${last.from}: ${reason}`
      : `Upgrade to ${last.to} failed: ${reason}`,
  );
  return 1;
}

/**
 * Polls status until the daemon answers on the new version (success), or
 * reports a fresh failed/rolled-back result for this target. Unreachable
 * while restarting is expected and simply retried.
 */
async function waitForUpgrade(
  client: ControlClientLike,
  started: UpgradeStarted,
  deps: CliDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const isFresh = (last: UpgradeResult | undefined): last is UpgradeResult =>
    last !== undefined && last.to === started.to && last.at >= startedAt;

  while (now() - startedAt < UPGRADE_WAIT_MS) {
    await sleep(UPGRADE_POLL_MS);
    let status: Awaited<ReturnType<ControlClientLike["status"]>>;
    try {
      status = await client.status();
    } catch (error) {
      if (error instanceof DaemonUnreachableError) {
        continue;
      }
      throw error;
    }
    if (
      isFresh(status.lastUpgrade) &&
      status.lastUpgrade.outcome !== "succeeded"
    ) {
      return reportUpgradeFailure(status.lastUpgrade, deps);
    }
    if (status.daemonVersion === started.to) {
      deps.stdout(`Upgraded to ${started.to}.`);
      return 0;
    }
  }
  const last = deps.readUpgradeResult?.(deps.dataDir);
  if (isFresh(last)) {
    if (last.outcome === "succeeded") {
      deps.stdout(`Upgraded to ${started.to}.`);
      return 0;
    }
    return reportUpgradeFailure(last, deps);
  }
  deps.stderr(
    `Timed out waiting for homefleetd to come back on ${started.to}. ` +
      `See ${path.join(upgradesDir(deps.dataDir), UPDATER_LOG)}.`,
  );
  return 1;
}

/**
 * `homefleet upgrade`: asks the running daemon to upgrade itself (see
 * ../upgrade/coordinator.ts), then waits for it to come back on the new
 * version. The daemon refuses BEFORE stopping anything, so a refusal here
 * means the node is untouched.
 */
async function runUpgrade(args: string[], deps: CliDeps): Promise<number> {
  const parsed = parseUpgradeArgs(args, deps);
  if (parsed === undefined) {
    return 2;
  }
  return withControlClient(deps, async (client) => {
    if (parsed.check) {
      const check = await client.checkUpgrade();
      deps.stdout(
        check.available
          ? `Upgrade available: ${check.current} → ${check.latest}`
          : `Up to date (${check.current}; latest release ${check.latest}).`,
      );
      return 0;
    }
    let started: UpgradeStarted;
    try {
      const response = await client.upgrade({
        targets: "self",
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        ...(parsed.force ? { force: true } : {}),
      });
      // A "self" request never yields a rollout status; narrow for the types.
      if ("peers" in response) {
        throw new ControlRequestError(
          502,
          "daemon answered a self upgrade with a fleet rollout",
        );
      }
      started = response;
    } catch (error) {
      if (error instanceof ControlRequestError) {
        deps.stderr(`Upgrade refused: ${error.message}`);
        return 1;
      }
      throw error;
    }
    deps.stdout(
      `Upgrading ${started.from} → ${started.to}. homefleetd is restarting ` +
        "and will come back in the background (not in this terminal).",
    );
    return waitForUpgrade(client, started, deps);
  });
}

interface FleetUpgradeArgs {
  version?: string;
  nodes?: string[];
  forceLocal: boolean;
}

/** Returns `undefined` (after writing a usage error to stderr) on any parse failure. */
function parseFleetUpgradeArgs(
  args: string[],
  deps: CliDeps,
): FleetUpgradeArgs | undefined {
  const parsed: FleetUpgradeArgs = { forceLocal: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--force-local") {
      parsed.forceLocal = true;
    } else if (arg === "--to") {
      const version = args[++i];
      if (version === undefined || !isSemver(version)) {
        deps.stderr("fleet upgrade: --to requires a version like 0.5.2");
        return undefined;
      }
      parsed.version = version;
    } else if (arg === "--nodes") {
      // Takes every following non-flag argument.
      const queries: string[] = [];
      while (i + 1 < args.length && !(args[i + 1] as string).startsWith("--")) {
        queries.push(args[++i] as string);
      }
      if (queries.length === 0) {
        deps.stderr("fleet upgrade: --nodes requires at least one name or id");
        return undefined;
      }
      parsed.nodes = queries;
    } else {
      deps.stderr(`fleet upgrade: unexpected argument "${arg}"`);
      return undefined;
    }
  }
  return parsed;
}

/**
 * Resolves each `--nodes` query to exactly one paired node's FULL device id
 * (the control API wants full ids). Returns `undefined` after writing why to
 * stderr when any query is unknown or ambiguous.
 */
async function resolveFleetNodes(
  queries: string[],
  client: ControlClientLike,
  deps: CliDeps,
): Promise<string[] | undefined> {
  const nodes = await client.nodes();
  const ids: string[] = [];
  for (const query of queries) {
    const resolution = resolveUnpairTarget(query, nodes);
    if (resolution.kind === "none") {
      deps.stderr(
        `No paired node matches "${query}". Run "homefleet nodes" to list them.`,
      );
      return undefined;
    }
    if (resolution.kind === "ambiguous") {
      deps.stderr(
        `"${query}" matches ${resolution.candidates.length} paired nodes:`,
      );
      for (const candidate of resolution.candidates) {
        deps.stderr(`  ${candidate.name}  ${candidate.deviceId}`);
      }
      deps.stderr("Re-run with the full device ID.");
      return undefined;
    }
    if (!ids.includes(resolution.node.deviceId)) {
      ids.push(resolution.node.deviceId);
    }
  }
  return ids;
}

function peerLine(peer: PeerRolloutStatus): string {
  return `  ${peer.name}: ${peer.state}${peer.reason !== undefined ? ` (${peer.reason})` : ""}`;
}

/** Peer states that mean the rollout STOPPED there (vs. a refusal it continued past). */
const STOPPING_PEER_STATES: ReadonlySet<PeerRolloutStatus["state"]> = new Set([
  "rolled-back",
  "failed",
  "timeout",
]);

/**
 * Prints the closing summary and returns the exit code: 0 only when every
 * selected peer succeeded and this node succeeded or was skipped.
 */
function summarizeRollout(
  rollout: RolloutStatus,
  selfUpgraded: boolean,
  deps: CliDeps,
): number {
  const upgraded =
    rollout.peers.filter((p) => p.state === "succeeded").length +
    (selfUpgraded ? 1 : 0);
  const stopped = rollout.peers.find((p) => STOPPING_PEER_STATES.has(p.state));
  const problems = rollout.peers.filter((p) => p.state !== "succeeded");
  const selfRefused = rollout.self.state === "refused";
  if (problems.length === 0 && !selfRefused && rollout.state !== "stopped") {
    deps.stdout(`Rollout complete: ${upgraded} upgraded.`);
    return 0;
  }
  if (stopped !== undefined) {
    deps.stderr(`Rollout stopped at ${stopped.name}: ${stopped.state}.`);
  } else if (
    rollout.state === "stopped" &&
    !selfRefused &&
    rollout.self.reason !== undefined
  ) {
    // The background run failed with no peer in flight.
    deps.stderr(`Rollout stopped: ${rollout.self.reason}`);
  } else {
    deps.stderr(`Rollout finished with problems: ${upgraded} upgraded.`);
  }
  for (const peer of problems) {
    if (peer !== stopped) {
      deps.stderr(peerLine(peer).trimStart());
    }
  }
  if (selfRefused) {
    deps.stderr(
      `This node: refused${rollout.self.reason !== undefined ? ` (${rollout.self.reason})` : ""}`,
    );
  }
  return 1;
}

/**
 * `homefleet fleet upgrade`: starts a rollout on the local daemon (peers
 * first, this node last — see ../upgrade/rollout.ts) and renders its progress
 * until every node is on the target. This node's own restart ends the
 * daemon's rollout bookkeeping, so once it is `restarting` — or the daemon
 * vanishes while it was still due — we hand off to {@link waitForUpgrade},
 * which already knows how to ride out a restart (and detect a rollback).
 */
async function runFleetUpgrade(args: string[], deps: CliDeps): Promise<number> {
  const parsed = parseFleetUpgradeArgs(args, deps);
  if (parsed === undefined) {
    return 2;
  }
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return withControlClient(deps, async (client) => {
    let targets: "fleet" | string[] = "fleet";
    if (parsed.nodes !== undefined) {
      const ids = await resolveFleetNodes(parsed.nodes, client, deps);
      if (ids === undefined) {
        return 2;
      }
      targets = ids;
    }
    // The version this node runs BEFORE the rollout: waitForUpgrade needs it.
    const current = (await client.status()).daemonVersion;

    let rollout: RolloutStatus;
    try {
      const response = await client.upgrade({
        targets,
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        ...(parsed.forceLocal ? { forceLocal: true } : {}),
      });
      if (!("peers" in response)) {
        throw new ControlRequestError(
          502,
          "daemon answered a fleet upgrade with a single-node upgrade",
        );
      }
      rollout = response;
    } catch (error) {
      if (error instanceof ControlRequestError) {
        deps.stderr(`Fleet upgrade refused: ${error.message}`);
        return 1;
      }
      throw error;
    }

    const target = rollout.target;
    if (rollout.peers.length === 0 && rollout.self.state === "skipped") {
      deps.stdout(`Everything is already on ${target}.`);
      return 0;
    }
    const selfDue = rollout.self.state !== "skipped";
    deps.stdout(
      rollout.peers.length === 0
        ? `Rolling out ${target} to this node only.`
        : `Rolling out ${target} to: ${rollout.peers
            .map(
              (p) => `${p.name}${p.from !== undefined ? ` (${p.from})` : ""}`,
            )
            .join(", ")}; ${
            selfDue ? "this node last." : `this node is already on ${target}.`
          }`,
    );

    // One line per CHANGE; peers start out "pending" (the plan lists them).
    const printed = new Map<string, string>(
      rollout.peers.map((p) => [p.deviceId, "pending|"]),
    );
    const render = (status: RolloutStatus): void => {
      for (const peer of status.peers) {
        const key = `${peer.state}|${peer.reason ?? ""}`;
        if (printed.get(peer.deviceId) !== key) {
          deps.stdout(peerLine(peer));
          printed.set(peer.deviceId, key);
        }
      }
    };
    render(rollout);

    // Waits out this node's own restart, then summarizes with the last status
    // we saw (the restarted daemon no longer remembers the rollout).
    const finishWithSelf = async (last: RolloutStatus): Promise<number> => {
      const waited = await waitForUpgrade(
        client,
        { from: current, to: target },
        deps,
      );
      return waited !== 0 ? waited : summarizeRollout(last, true, deps);
    };

    let last = rollout;
    for (;;) {
      if (last.self.state === "restarting") {
        return finishWithSelf(last);
      }
      if (last.state !== "running") {
        return summarizeRollout(last, false, deps);
      }
      await sleep(UPGRADE_POLL_MS);
      let next: RolloutStatus | null;
      try {
        next = await client.upgrades();
      } catch (error) {
        // The daemon stopped answering. If this node was still due to
        // restart, that restart is what we are seeing.
        if (
          error instanceof DaemonUnreachableError &&
          last.self.state === "pending"
        ) {
          return finishWithSelf(last);
        }
        throw error;
      }
      if (next === null) {
        if (last.self.state === "pending") {
          return finishWithSelf(last);
        }
        deps.stderr(
          "The daemon no longer reports a rollout; its state is lost.",
        );
        return 1;
      }
      render(next);
      last = next;
    }
  });
}

async function runFleet(args: string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "upgrade") {
    return runFleetUpgrade(rest, deps);
  }
  deps.stderr(
    "usage: homefleet fleet upgrade [--to <version>] [--nodes <name|id>...] [--force-local]",
  );
  return 2;
}

async function dispatch(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === "--version") {
    deps.stdout(`homefleet ${DAEMON_VERSION}`);
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
    case "unpair":
      return runUnpair(rest, deps);
    case "status":
      if (rest.length > 0) {
        deps.stderr(`status: unexpected extra argument(s): ${rest.join(" ")}`);
        return 2;
      }
      return runStatus(deps);
    case "dashboard":
      return runDashboard(rest, deps);
    case "upgrade":
      return runUpgrade(rest, deps);
    case "fleet":
      return runFleet(rest, deps);
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
