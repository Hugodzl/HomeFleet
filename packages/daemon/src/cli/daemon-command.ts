/**
 * `homefleet daemon start|stop|restart|status`: run this data dir's daemon
 * from the installed bin (spec:
 * docs/specs/2026-11-05-daemon-lifecycle-command-design.md).
 *
 * The live daemon is the source of truth: it answers `GET /control/status`
 * with its own pid, and `POST /control/shutdown` stops it gracefully. No pid
 * file is read or written; one would go stale across reboots. Every OS
 * side effect goes through {@link LifecycleDeps}.
 */
import path from "node:path";
import { DAEMON_LOG_FILE } from "../bin/daemon-log.js";
import type { DaemonConfig } from "../config/config.js";
import type { ControlStatus } from "../control/control-server.js";
import type { CliDeps } from "./cli.js";
import {
  type ControlClientLike,
  ControlRequestError,
  DaemonUnreachableError,
} from "./control-client.js";
import { DAEMON_ERR_LOG_FILE, type LifecycleDeps } from "./daemon-lifecycle.js";
import {
  DEFAULT_AUTOSTART_TASK_NAME,
  generateAutostartCreateCommand,
} from "./setup-commands.js";

/** How long `start` waits for the daemon to answer. */
export const START_WAIT_MS = 30_000;
/** How long `stop` waits for a graceful exit before killing the pid. */
export const STOP_WAIT_MS = 30_000;
/** After a kill, how long to wait for the pid to disappear. */
const KILL_WAIT_MS = 5_000;
const POLL_MS = 250;
const LOG_TAIL_LINES = 10;
/** `status` exit code when no daemon answers (the LSB "not running" code). */
export const EXIT_NOT_RUNNING = 3;

const USAGE =
  "usage: homefleet daemon <start [--allow-packaged] | stop [--force] | " +
  "restart [--force] [--allow-packaged] | status>";

const ALLOWED_FLAGS: Record<string, readonly string[]> = {
  start: ["--allow-packaged"],
  stop: ["--force"],
  restart: ["--force", "--allow-packaged"],
  status: [],
};

export interface DaemonCommandContext {
  /** The daemon entry `start` launches (the built homefleetd.js). */
  daemonEntryPath: string;
  /** The message to print when the daemon refuses the control token. */
  badTokenMessage: string;
}

interface Session {
  deps: CliDeps;
  lifecycle: LifecycleDeps;
  config: DaemonConfig;
  client: ControlClientLike;
  context: DaemonCommandContext;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export async function runDaemon(
  args: string[],
  deps: CliDeps,
  context: DaemonCommandContext,
): Promise<number> {
  const [sub, ...flags] = args;
  const allowed = sub === undefined ? undefined : ALLOWED_FLAGS[sub];
  if (sub === undefined || allowed === undefined) {
    deps.stderr(USAGE);
    return 2;
  }
  const unknown = flags.filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0) {
    deps.stderr(`daemon ${sub}: unexpected argument(s): ${unknown.join(" ")}`);
    deps.stderr(USAGE);
    return 2;
  }
  const lifecycle = deps.lifecycle;
  if (lifecycle === undefined) {
    deps.stderr("homefleet daemon: not available in this build");
    return 1;
  }
  const config = await deps.loadConfig(deps.dataDir);
  const session: Session = {
    deps,
    lifecycle,
    config,
    client: deps.makeControlClient({
      host: config.control.host,
      port: config.control.port,
      token: () => deps.readControlToken?.(deps.dataDir),
    }),
    context,
    now: deps.now ?? Date.now,
    sleep:
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const force = flags.includes("--force");
  const allowPackaged = flags.includes("--allow-packaged");
  switch (sub) {
    case "status":
      return runDaemonStatus(session);
    case "start":
      return runDaemonStart(session, allowPackaged);
    case "stop":
      return runDaemonStop(session, force);
    default: {
      const stopped = await runDaemonStop(session, force);
      return stopped !== 0 ? stopped : runDaemonStart(session, allowPackaged);
    }
  }
}

/** The live daemon's status, or undefined when nothing answers. */
async function probe(session: Session): Promise<ControlStatus | undefined> {
  try {
    return await session.client.status();
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return undefined;
    }
    throw error;
  }
}

function controlUrl(config: DaemonConfig): string {
  const host = config.control.host.includes(":")
    ? `[${config.control.host}]`
    : config.control.host;
  return `http://${host}:${config.control.port}`;
}

function logPath(session: Session): string {
  return path.join(session.deps.dataDir, DAEMON_LOG_FILE);
}

function errLogPath(session: Session): string {
  return path.join(session.deps.dataDir, DAEMON_ERR_LOG_FILE);
}

function pidText(status: ControlStatus): string {
  return status.pid !== undefined
    ? `pid ${status.pid}`
    : "pid unknown: this daemon predates `homefleet daemon`";
}

function isPackaged(session: Session): boolean {
  return (
    session.lifecycle.platform === "win32" && session.lifecycle.isPackagedApp()
  );
}

const PACKAGED_NOTE =
  "Note: this shell runs inside a packaged (MSIX) app, such as the Claude " +
  "desktop app. It sees a private copy of %LOCALAPPDATA%, so the data dir " +
  "above may not be the real one, and a daemon started from here dies with " +
  "the app.";

async function runDaemonStatus(session: Session): Promise<number> {
  const { deps, lifecycle, config } = session;
  const status = await probe(session);
  if (status !== undefined) {
    deps.stdout(
      `homefleetd is running (${pidText(status)}, v${status.daemonVersion})`,
    );
  } else {
    deps.stdout(
      `homefleetd is not running (nothing answers on ${controlUrl(config)})`,
    );
  }
  deps.stdout(`  control:    ${controlUrl(config)}`);
  deps.stdout(`  data dir:   ${deps.dataDir}`);
  deps.stdout(`  log:        ${logPath(session)}`);
  deps.stdout(`  stderr log: ${errLogPath(session)}`);
  if (status === undefined) {
    const last = lifecycle.tailFile(logPath(session), 1)[0];
    if (last !== undefined) {
      deps.stdout(`  last log line: ${last}`);
    }
  }
  if (lifecycle.platform === "win32") {
    const registered = lifecycle.taskExists(DEFAULT_AUTOSTART_TASK_NAME);
    deps.stdout(
      `  autostart:  task "${DEFAULT_AUTOSTART_TASK_NAME}" ${
        registered ? "registered" : "not registered (see `homefleet setup`)"
      }`,
    );
    if (isPackaged(session)) {
      deps.stdout(PACKAGED_NOTE);
    }
  }
  return status !== undefined ? 0 : EXIT_NOT_RUNNING;
}

async function waitForExit(
  session: Session,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = session.now() + timeoutMs;
  while (session.lifecycle.isPidAlive(pid)) {
    if (session.now() >= deadline) {
      return false;
    }
    await session.sleep(POLL_MS);
  }
  return true;
}

async function runDaemonStop(
  session: Session,
  force: boolean,
): Promise<number> {
  const { deps, client } = session;
  const status = await probe(session);
  if (status === undefined) {
    deps.stdout("homefleetd is not running.");
    return 0;
  }
  // The daemon enforces the jobs rule itself (409 busy), so there is no
  // window between a status read here and the stop.
  let pid: number;
  try {
    ({ pid } = await client.shutdown({ force }));
  } catch (error) {
    if (error instanceof ControlRequestError) {
      if (error.code === "busy") {
        deps.stderr(
          `Refused: homefleetd has ${error.message}. ` +
            "Wait for them to finish, or pass --force to stop anyway.",
        );
        return 1;
      }
      if (error.code === "upgrading") {
        deps.stderr(
          "Refused: an upgrade is in progress, and it restarts homefleetd " +
            "itself. Wait for it to finish (`homefleet daemon status`), then " +
            "stop it.",
        );
        return 1;
      }
      if (error.status === 404) {
        deps.stderr(
          `This daemon (v${status.daemonVersion}) predates \`homefleet daemon stop\`. ` +
            "Stop it by hand once, or run `homefleet upgrade`, which restarts " +
            "it into a version that has it.",
        );
        return 1;
      }
      if (error.code === "bad-token") {
        deps.stderr(session.context.badTokenMessage);
        return 1;
      }
      deps.stderr(`Could not stop homefleetd: ${error.message}`);
      return 1;
    }
    if (error instanceof DaemonUnreachableError) {
      deps.stdout("homefleetd is not running.");
      return 0;
    }
    throw error;
  }
  deps.stdout(`Stopping homefleetd (pid ${pid})...`);
  if (await waitForExit(session, pid, STOP_WAIT_MS)) {
    deps.stdout("homefleetd stopped.");
    return 0;
  }
  // The pid was the daemon's 30 s ago, but if it exited near the deadline
  // the OS may have handed the number to another process. Kill only a pid
  // that still runs homefleetd.
  const identity = session.lifecycle.isPidAlive(pid)
    ? session.lifecycle.identifyProcess(pid)
    : "gone";
  if (identity === "gone") {
    deps.stdout("homefleetd stopped.");
    return 0;
  }
  if (identity === "other") {
    deps.stdout(
      `homefleetd stopped (pid ${pid} now belongs to another process; not killing it).`,
    );
    return 0;
  }
  if (identity === "unknown") {
    deps.stderr(
      `Could not stop homefleetd: pid ${pid} is still alive after ` +
        `${STOP_WAIT_MS / 1000} s, but its command line can't be read to ` +
        "confirm it is homefleetd, so it was not killed. End it yourself " +
        "(Task Manager, `Stop-Process -Id` or `kill`), from an elevated " +
        "shell if the daemon runs elevated.",
    );
    return 1;
  }
  session.lifecycle.killPid(pid);
  if (await waitForExit(session, pid, KILL_WAIT_MS)) {
    deps.stdout(
      `homefleetd did not exit within ${STOP_WAIT_MS / 1000} s; killed pid ${pid}.`,
    );
    return 0;
  }
  deps.stderr(`Could not stop homefleetd: pid ${pid} is still running.`);
  return 1;
}

function printLogTails(session: Session): void {
  const { deps, lifecycle } = session;
  const log = lifecycle.tailFile(logPath(session), LOG_TAIL_LINES);
  if (log.length > 0) {
    deps.stderr(`Last lines of ${logPath(session)}:`);
    for (const line of log) deps.stderr(`  ${line}`);
  }
  const err = lifecycle.tailFile(errLogPath(session), LOG_TAIL_LINES);
  if (err.length > 0) {
    deps.stderr(`Last lines of ${errLogPath(session)}:`);
    for (const line of err) deps.stderr(`  ${line}`);
  }
}

async function runDaemonStart(
  session: Session,
  allowPackaged: boolean,
): Promise<number> {
  const { deps, lifecycle, context } = session;
  const running = await probe(session);
  if (running !== undefined) {
    deps.stdout(`homefleetd is already running (${pidText(running)}).`);
    return 0;
  }
  const windows = lifecycle.platform === "win32";
  const useTask =
    windows &&
    lifecycle.defaultDataDir &&
    lifecycle.taskExists(DEFAULT_AUTOSTART_TASK_NAME);
  if (!useTask && isPackaged(session) && !allowPackaged) {
    const nodeExecPath = deps.nodeExecPath ?? process.execPath;
    deps.stderr(
      "Refused: this shell runs inside a packaged (MSIX) app, such as the " +
        "Claude desktop app. A daemon started from here would keep its state " +
        "in the app's private copy of %LOCALAPPDATA% and die when the app " +
        "closes or updates.",
    );
    deps.stderr(
      "Register the autostart task (then `homefleet daemon start` runs it), " +
        "in an elevated PowerShell:",
    );
    deps.stderr(
      `  ${generateAutostartCreateCommand({
        nodeExecPath,
        daemonEntryPath: context.daemonEntryPath,
      })}`,
    );
    deps.stderr(
      "or run `homefleet daemon start` from your own terminal. " +
        "--allow-packaged starts it here anyway.",
    );
    return 1;
  }

  let launched: ReturnType<LifecycleDeps["launchDetached"]> | undefined;
  if (useTask) {
    const result = lifecycle.runTask(DEFAULT_AUTOSTART_TASK_NAME);
    if (!result.ok) {
      deps.stderr(
        `Could not run the "${DEFAULT_AUTOSTART_TASK_NAME}" task: ${result.output}`,
      );
      return 1;
    }
    deps.stdout(
      `Starting homefleetd through the "${DEFAULT_AUTOSTART_TASK_NAME}" task...`,
    );
  } else {
    launched = lifecycle.launchDetached({
      nodePath: deps.nodeExecPath ?? process.execPath,
      entryPath: context.daemonEntryPath,
      dataDir: deps.dataDir,
    });
    deps.stdout(`Starting homefleetd (pid ${launched.pid})...`);
  }

  const deadline = session.now() + START_WAIT_MS;
  while (session.now() < deadline) {
    const status = await probe(session);
    if (
      status !== undefined &&
      (launched === undefined ||
        status.pid === undefined ||
        status.pid === launched.pid)
    ) {
      deps.stdout(
        `homefleetd started (${pidText(status)}, v${status.daemonVersion}). ` +
          `Log: ${logPath(session)}`,
      );
      return 0;
    }
    const exit = launched?.exited();
    if (exit !== undefined) {
      deps.stderr(`homefleetd exited during startup (${exit}).`);
      printLogTails(session);
      return 1;
    }
    await session.sleep(POLL_MS * 2);
  }
  deps.stderr(
    `homefleetd did not answer on ${controlUrl(session.config)} within ` +
      `${START_WAIT_MS / 1000} s.` +
      (launched !== undefined && launched.exited() === undefined
        ? ` It is still running as pid ${launched.pid}; check \`homefleet daemon status\`.`
        : ""),
  );
  printLogTails(session);
  return 1;
}
