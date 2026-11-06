/**
 * The real, OS-touching pieces behind `homefleet daemon start|stop|restart|status`
 * (spec: docs/specs/2026-11-05-daemon-lifecycle-command-design.md).
 *
 * ./daemon-command.ts holds all the decisions and only ever sees the
 * {@link LifecycleDeps} interface, so cli tests drive every branch with
 * fakes. This module is the one implementation of that interface, wired in
 * by ../bin/homefleet.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Raw stderr of a detached daemon; the same file updater.mjs redirects to. */
export const DAEMON_ERR_LOG_FILE = "homefleetd.err.log";

/** A daemon process this CLI just started detached. */
export interface LaunchedDaemon {
  pid: number;
  /** The exit code (or signal name) once the child has exited; undefined while it runs. */
  exited(): number | string | undefined;
}

export interface TaskRunResult {
  ok: boolean;
  /** schtasks' combined output, for the error message when `ok` is false. */
  output: string;
}

export type ProcessIdentity = "homefleetd" | "other" | "gone" | "unknown";

export interface LifecycleDeps {
  platform: NodeJS.Platform;
  /** True when the data dir is the per-platform default (no `HOMEFLEET_DATA_DIR`). */
  defaultDataDir: boolean;
  /** Starts `node <entryPath>` detached, stderr appended to `<dataDir>/homefleetd.err.log`. */
  launchDetached(input: {
    nodePath: string;
    entryPath: string;
    dataDir: string;
  }): LaunchedDaemon;
  isPidAlive(pid: number): boolean;
  /**
   * What `pid` runs now, from its command line: `homefleetd`, some `other`
   * program, `gone`, or `unknown` when the process is alive but its command
   * line can't be read (lookup blocked or timed out, or an elevated process
   * seen from an unelevated shell). It gates a hard kill: only
   * `homefleetd` may be killed.
   */
  identifyProcess(pid: number): ProcessIdentity;
  /** Hard kill (TerminateProcess on Windows). Never throws. */
  killPid(pid: number): void;
  /** Windows: whether this process runs inside an MSIX package (virtualized AppData). */
  isPackagedApp(): boolean;
  /** Windows: whether a Task Scheduler task of this name is registered. */
  taskExists(name: string): boolean;
  /** Windows: `schtasks /Run` the task. */
  runTask(name: string): TaskRunResult;
  /** The last `count` lines of a text file; [] when it is missing or empty. */
  tailFile(filePath: string, count: number): string[];
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A process's command line: Win32_Process on Windows, /proc on Linux, `ps`
 * elsewhere. Undefined when the process is gone or the lookup fails.
 */
export function processCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    if (platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      );
      const line = result.status === 0 ? result.stdout.trim() : "";
      return line === "" ? undefined : line;
    }
    if (platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const line = raw.split("\0").join(" ").trim();
      return line === "" ? undefined : line;
    }
    const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const line = result.status === 0 ? result.stdout.trim() : "";
    return line === "" ? undefined : line;
  } catch {
    return undefined;
  }
}

export function identifyProcess(
  pid: number,
  readCommandLine: (pid: number) => string | undefined = processCommandLine,
  alive: (pid: number) => boolean = isPidAlive,
): ProcessIdentity {
  const line = readCommandLine(pid);
  if (line !== undefined) {
    return /homefleetd/i.test(line) ? "homefleetd" : "other";
  }
  // No command line: either the process is gone, or it can't be read.
  return alive(pid) ? "unknown" : "gone";
}

export function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

export function launchDetached(input: {
  nodePath: string;
  entryPath: string;
  dataDir: string;
}): LaunchedDaemon {
  const errFd = openSync(path.join(input.dataDir, DAEMON_ERR_LOG_FILE), "a");
  let exit: number | string | undefined;
  try {
    const child = spawn(input.nodePath, [input.entryPath], {
      detached: true,
      stdio: ["ignore", "ignore", errFd],
      windowsHide: true,
    });
    child.on("exit", (code, signal) => {
      exit = code ?? signal ?? "unknown";
    });
    // A spawn failure (bad node path) arrives as 'error', not 'exit'.
    child.on("error", (error) => {
      exit = error.message;
    });
    child.unref();
    return { pid: child.pid ?? -1, exited: () => exit };
  } finally {
    closeSync(errFd);
  }
}

/**
 * MSIX detection by observation: write a uniquely named probe to
 * `%LOCALAPPDATA%`, then look for it in every package's private
 * `LocalCache\Local`. Inside a package, Windows redirects the write there
 * (verified 2026-11-05 from a Claude desktop shell). Any error means "not
 * packaged": this is a warning device, not a security boundary.
 *
 * `writeProbe` is a test seam (tests simulate the redirect with it).
 */
export function isPackagedApp(
  localAppData: string | undefined,
  writeProbe: (probePath: string) => void = (probePath) =>
    writeFileSync(probePath, ""),
): boolean {
  if (localAppData === undefined || localAppData === "") {
    return false;
  }
  const name = `homefleet-msix-probe-${process.pid}-${Date.now()}`;
  const probe = path.join(localAppData, name);
  try {
    writeProbe(probe);
    const packages = path.join(localAppData, "Packages");
    for (const entry of readdirSync(packages)) {
      if (existsSync(path.join(packages, entry, "LocalCache", "Local", name))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

export function taskExists(name: string): boolean {
  const result = spawnSync("schtasks", ["/Query", "/TN", name], {
    windowsHide: true,
    encoding: "utf8",
  });
  return result.status === 0;
}

export function runTask(name: string): TaskRunResult {
  const result = spawnSync("schtasks", ["/Run", "/TN", name], {
    windowsHide: true,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    output: output || (result.error?.message ?? ""),
  };
}

export function tailFile(filePath: string, count: number): string[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-count);
}

/** The real {@link LifecycleDeps} for this process. */
export function realLifecycleDeps(
  env: NodeJS.ProcessEnv = process.env,
): LifecycleDeps {
  const override = env.HOMEFLEET_DATA_DIR;
  return {
    platform: process.platform,
    defaultDataDir: override === undefined || override === "",
    launchDetached,
    isPidAlive,
    identifyProcess: (pid) => identifyProcess(pid),
    killPid,
    isPackagedApp: () => isPackagedApp(env.LOCALAPPDATA),
    taskExists,
    runTask,
    tailFile,
  };
}
