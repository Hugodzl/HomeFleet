/**
 * `homefleet daemon start|stop|restart|status` against a simulated node: a
 * fake control client and fake LifecycleDeps share one small "world" (which
 * daemon answers, which pids are alive, a fake clock), so every branch of
 * the spec runs without a real process.
 */
import { describe, expect, test } from "vitest";
import type { DaemonConfig } from "../config/config.js";
import type { ControlStatus } from "../control/control-server.js";
import { type CliDeps, runCli } from "./cli.js";
import {
  type ControlClientLike,
  ControlRequestError,
  DaemonUnreachableError,
} from "./control-client.js";
import { EXIT_NOT_RUNNING, START_WAIT_MS } from "./daemon-command.js";
import type { LifecycleDeps } from "./daemon-lifecycle.js";

const CONFIG = {
  control: { host: "127.0.0.1", port: 56373, dashboard: true },
} as DaemonConfig;

interface World {
  /** The daemon answering on the control port, if any. */
  daemon?: { pid?: number; version: string; activeJobs: number };
  alive: Set<number>;
  now: number;
  platform: NodeJS.Platform;
  defaultDataDir: boolean;
  packaged: boolean;
  task: boolean;
  taskRunOk: boolean;
  /** What a launch does: come up after `upAfterMs`, or exit with a code. */
  launch: { upAfterMs: number } | { exitCode: number } | "hang";
  /** shutdown(): exit gracefully, ignore it, or answer an error status. */
  shutdown: "graceful" | "ignore" | "upgrading" | 404 | 409 | "bad-token";
  /** Pids whose number now belongs to some other process (not homefleetd). */
  foreign: Set<number>;
  /** Pids whose command line can't be read (blocked lookup, elevation). */
  unreadable: Set<number>;
  logs: Record<string, string[]>;
  calls: string[];
}

function world(overrides: Partial<World> = {}): World {
  return {
    alive: new Set(),
    now: 0,
    platform: "linux",
    defaultDataDir: true,
    packaged: false,
    task: false,
    taskRunOk: true,
    launch: { upAfterMs: 1000 },
    shutdown: "graceful",
    foreign: new Set(),
    unreadable: new Set(),
    logs: {},
    calls: [],
    ...overrides,
  };
}

function status(w: World): ControlStatus {
  const d = w.daemon;
  if (d === undefined) {
    throw new DaemonUnreachableError("127.0.0.1", 56373, undefined);
  }
  return {
    deviceId: "a".repeat(64),
    name: "n",
    platform: "linux",
    daemonVersion: d.version,
    protocolVersion: "0.3.0",
    hfpPort: 1,
    mcpPort: 2,
    controlPort: 56373,
    roles: [],
    executors: [],
    models: [],
    activeJobs: d.activeJobs,
    maxConcurrentJobs: 4,
    ...(d.pid !== undefined ? { pid: d.pid } : {}),
  };
}

let nextPid = 5000;
/** Timed events: run when the fake clock passes `at`. */
type Pending = { at: number; run: () => void };

function harness(w: World) {
  const out: string[] = [];
  const err: string[] = [];
  const pending: Pending[] = [];
  const tick = () => {
    for (const p of pending.filter((e) => e.at <= w.now)) {
      pending.splice(pending.indexOf(p), 1);
      p.run();
    }
  };
  const client = {
    status: async () => {
      tick();
      return status(w);
    },
    shutdown: async (input?: { force?: boolean }) => {
      w.calls.push(input?.force === true ? "shutdown force" : "shutdown");
      const pid = w.daemon?.pid ?? -1;
      // The daemon, not the CLI, enforces the jobs rule.
      if ((w.daemon?.activeJobs ?? 0) > 0 && input?.force !== true)
        throw new ControlRequestError(409, "2 job(s) running", "busy");
      if (w.shutdown === "upgrading")
        throw new ControlRequestError(409, "upgrading", "upgrading");
      if (w.shutdown === 404) throw new ControlRequestError(404, "not found");
      if (w.shutdown === 409)
        throw new ControlRequestError(409, "cannot", "unsupported");
      if (w.shutdown === "bad-token")
        throw new ControlRequestError(403, "bad", "bad-token");
      if (w.shutdown === "graceful") {
        pending.push({
          at: w.now + 1000,
          run: () => {
            w.daemon = undefined;
            w.alive.delete(pid);
          },
        });
      } else {
        w.daemon = undefined; // stops answering, but the process lingers
      }
      return { pid, alreadyStopping: false };
    },
  } as unknown as ControlClientLike;

  const bringUp = (pid: number | undefined) => {
    w.daemon = {
      ...(pid !== undefined ? { pid } : {}),
      version: "0.7.0",
      activeJobs: 0,
    };
    if (pid !== undefined) w.alive.add(pid);
  };

  const lifecycle: LifecycleDeps = {
    platform: w.platform,
    defaultDataDir: w.defaultDataDir,
    launchDetached: (input) => {
      w.calls.push(
        `launch ${input.nodePath} ${input.entryPath} ${input.dataDir}`,
      );
      const pid = nextPid++;
      let exit: number | undefined;
      w.alive.add(pid);
      const launch = w.launch;
      if (launch === "hang") {
        // alive, never answers
      } else if ("exitCode" in launch) {
        pending.push({
          at: w.now + 500,
          run: () => {
            exit = launch.exitCode;
            w.alive.delete(pid);
          },
        });
      } else {
        pending.push({ at: w.now + launch.upAfterMs, run: () => bringUp(pid) });
      }
      return { pid, exited: () => exit };
    },
    isPidAlive: (pid) => {
      tick();
      return w.alive.has(pid);
    },
    identifyProcess: (pid) =>
      !w.alive.has(pid)
        ? "gone"
        : w.unreadable.has(pid)
          ? "unknown"
          : w.foreign.has(pid)
            ? "other"
            : "homefleetd",
    killPid: (pid) => {
      w.calls.push(`kill ${pid}`);
      w.alive.delete(pid);
    },
    isPackagedApp: () => w.packaged,
    taskExists: () => w.task,
    runTask: (name) => {
      w.calls.push(`runTask ${name}`);
      if (w.taskRunOk) {
        pending.push({ at: w.now + 1000, run: () => bringUp(nextPid++) });
      }
      return {
        ok: w.taskRunOk,
        output: w.taskRunOk ? "" : "ERROR: access denied",
      };
    },
    tailFile: (file, count) =>
      (w.logs[file.replaceAll("\\", "/")] ?? []).slice(-count),
  };

  const deps: CliDeps = {
    dataDir: "/data",
    loadConfig: async () => CONFIG,
    ensureIdentity: async () => ({ deviceId: "a".repeat(64) }),
    makeControlClient: () => client,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    nodeExecPath: "/bin/node",
    daemonEntryPath: "/app/homefleetd.js",
    now: () => w.now,
    sleep: async (ms) => {
      w.now += ms;
    },
    lifecycle,
  };
  return {
    run: (...argv: string[]) => runCli(["daemon", ...argv], deps),
    out,
    err,
    text: () => [...out, ...err].join("\n"),
  };
}

describe("daemon status", () => {
  test("running: pid, version, paths; exit 0", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 0 } });
    const h = harness(w);
    expect(await h.run("status")).toBe(0);
    expect(h.out[0]).toBe("homefleetd is running (pid 42, v0.7.0)");
    expect(h.text()).toContain("http://127.0.0.1:56373");
    expect(h.text()).toMatch(/log:\s+.*homefleetd\.log/);
    expect(h.text()).not.toContain("autostart"); // not Windows
  });

  test("an older daemon without a pid is still reported running", async () => {
    const h = harness(world({ daemon: { version: "0.6.4", activeJobs: 0 } }));
    expect(await h.run("status")).toBe(0);
    expect(h.out[0]).toContain("pid unknown");
  });

  test("not running: exit 3 and the last log line dates the stop", async () => {
    const w = world({
      logs: {
        "/data/homefleetd.log": [
          "a",
          "2026-11-05T01:00:00Z homefleetd: SIGINT received, shutting down",
        ],
      },
    });
    const h = harness(w);
    expect(await h.run("status")).toBe(EXIT_NOT_RUNNING);
    expect(h.out[0]).toContain("is not running");
    expect(h.text()).toContain("last log line: 2026-11-05T01:00:00Z");
  });

  test("Windows: reports the autostart task and the packaged-app note", async () => {
    const h = harness(world({ platform: "win32", task: true, packaged: true }));
    await h.run("status");
    expect(h.text()).toContain('task "HomeFleet Daemon" registered');
    expect(h.text()).toContain("packaged (MSIX) app");
  });

  test("rejects extra arguments", async () => {
    const h = harness(world());
    expect(await h.run("status", "--force")).toBe(2);
    expect(await harness(world()).run("bogus")).toBe(2);
    expect(await harness(world()).run()).toBe(2);
  });
});

describe("daemon start", () => {
  test("already running: no launch, exit 0", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 0 } });
    const h = harness(w);
    expect(await h.run("start")).toBe(0);
    expect(h.out[0]).toContain("already running (pid 42)");
    expect(w.calls).toEqual([]);
  });

  test("direct launch: node + entry detached, waits for the child's pid to answer", async () => {
    const w = world();
    const h = harness(w);
    expect(await h.run("start")).toBe(0);
    expect(w.calls).toEqual(["launch /bin/node /app/homefleetd.js /data"]);
    expect(h.out.at(-1)).toMatch(/^homefleetd started \(pid \d+, v0\.7\.0\)/);
  });

  test("a child that exits during startup fails with the log tails", async () => {
    const w = world({
      launch: { exitCode: 1 },
      logs: {
        "/data/homefleetd.log": ["homefleetd failed to start: EADDRINUSE"],
        "/data/homefleetd.err.log": ["Error: Cannot find module"],
      },
    });
    const h = harness(w);
    expect(await h.run("start")).toBe(1);
    expect(h.err[0]).toBe("homefleetd exited during startup (1).");
    expect(h.text()).toContain("EADDRINUSE");
    expect(h.text()).toContain("Cannot find module");
  });

  test("a child that never answers times out but is left running", async () => {
    const w = world({ launch: "hang" });
    const h = harness(w);
    expect(await h.run("start")).toBe(1);
    expect(w.now).toBeGreaterThanOrEqual(START_WAIT_MS);
    expect(h.text()).toContain("still running as pid");
  });

  test("Windows with the task and the default data dir: runs the task", async () => {
    const w = world({ platform: "win32", task: true });
    const h = harness(w);
    expect(await h.run("start")).toBe(0);
    expect(w.calls).toEqual(["runTask HomeFleet Daemon"]);
  });

  test("the task path wins even inside a packaged app (the task runs outside it)", async () => {
    const w = world({ platform: "win32", task: true, packaged: true });
    expect(await harness(w).run("start")).toBe(0);
    expect(w.calls).toEqual(["runTask HomeFleet Daemon"]);
  });

  test("a custom data dir never uses the task (it passes no environment)", async () => {
    const w = world({ platform: "win32", task: true, defaultDataDir: false });
    expect(await harness(w).run("start")).toBe(0);
    expect(w.calls[0]).toMatch(/^launch /);
  });

  test("a failing schtasks /Run reports its output", async () => {
    const w = world({ platform: "win32", task: true, taskRunOk: false });
    const h = harness(w);
    expect(await h.run("start")).toBe(1);
    expect(h.text()).toContain("access denied");
  });

  test("packaged app without a usable task: refuses and prints the schtasks line", async () => {
    const w = world({ platform: "win32", packaged: true });
    const h = harness(w);
    expect(await h.run("start")).toBe(1);
    expect(w.calls).toEqual([]);
    expect(h.text()).toContain("schtasks /Create");
    expect(h.text()).toContain("--allow-packaged");
  });

  test("--allow-packaged launches directly anyway", async () => {
    const w = world({ platform: "win32", packaged: true });
    expect(await harness(w).run("start", "--allow-packaged")).toBe(0);
    expect(w.calls[0]).toMatch(/^launch /);
  });

  test("the packaged check is Windows-only", async () => {
    const w = world({ platform: "linux", packaged: true });
    expect(await harness(w).run("start")).toBe(0);
  });
});

describe("daemon stop", () => {
  test("not running is a no-op success", async () => {
    const w = world();
    const h = harness(w);
    expect(await h.run("stop")).toBe(0);
    expect(h.out).toEqual(["homefleetd is not running."]);
    expect(w.calls).toEqual([]);
  });

  test("graceful: shutdown route, then waits for the pid to exit", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 0 } });
    w.alive.add(42);
    const h = harness(w);
    expect(await h.run("stop")).toBe(0);
    expect(w.calls).toEqual(["shutdown"]);
    expect(h.out.at(-1)).toBe("homefleetd stopped.");
  });

  test("the daemon's busy refusal is explained; --force is passed through", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 2 } });
    w.alive.add(42);
    const h = harness(w);
    expect(await h.run("stop")).toBe(1);
    expect(h.err[0]).toBe(
      "Refused: homefleetd has 2 job(s) running. Wait for them to finish, or pass --force to stop anyway.",
    );
    expect(await harness(w).run("stop", "--force")).toBe(0);
    expect(w.calls).toEqual(["shutdown", "shutdown force"]);
  });

  test("an upgrade in progress is refused with a clear message", async () => {
    const w = world({
      daemon: { pid: 42, version: "0.7.0", activeJobs: 0 },
      shutdown: "upgrading",
    });
    w.alive.add(42);
    const h = harness(w);
    expect(await h.run("stop")).toBe(1);
    expect(h.err[0]).toContain("an upgrade is in progress");
    expect(w.calls).toEqual(["shutdown"]);
  });

  test("the kill fallback skips a pid that no longer runs homefleetd", async () => {
    const w = world({
      daemon: { pid: 42, version: "0.7.0", activeJobs: 0 },
      shutdown: "ignore",
    });
    w.alive.add(42);
    w.foreign.add(42); // the daemon exited and the number was reused
    const h = harness(w);
    expect(await h.run("stop")).toBe(0);
    expect(w.calls).toEqual(["shutdown"]); // no kill
    expect(h.out.at(-1)).toContain("now belongs to another process");
  });

  test("a daemon that ignores the shutdown is killed after the wait", async () => {
    const w = world({
      daemon: { pid: 42, version: "0.7.0", activeJobs: 0 },
      shutdown: "ignore",
    });
    w.alive.add(42);
    const h = harness(w);
    expect(await h.run("stop")).toBe(0);
    expect(w.calls).toEqual(["shutdown", "kill 42"]);
    expect(h.out.at(-1)).toContain("killed pid 42");
  });

  test.each([
    [404, "predates `homefleet daemon stop`"],
    ["bad-token", "control token didn't match"],
    [409, "Could not stop homefleetd: cannot"],
  ] as const)("shutdown answering %s explains and exits 1", async (answer, message) => {
    const w = world({
      daemon: { pid: 42, version: "0.6.4", activeJobs: 0 },
      shutdown: answer,
    });
    const h = harness(w);
    expect(await h.run("stop")).toBe(1);
    expect(h.text()).toContain(message);
  });
});

describe("daemon stop: unreadable pid", () => {
  test("a live pid that can't be identified is not killed; stop exits 1", async () => {
    const w = world({
      daemon: { pid: 42, version: "0.7.0", activeJobs: 0 },
      shutdown: "ignore",
    });
    w.alive.add(42);
    w.unreadable.add(42);
    const h = harness(w);
    expect(await h.run("stop")).toBe(1);
    expect(w.calls).toEqual(["shutdown"]); // no kill
    expect(h.err.at(-1)).toContain("pid 42 is still alive");
    expect(h.err.at(-1)).toContain("End it yourself");
  });

  test("restart does not start a second daemon after that", async () => {
    const w = world({
      daemon: { pid: 42, version: "0.7.0", activeJobs: 0 },
      shutdown: "ignore",
    });
    w.alive.add(42);
    w.unreadable.add(42);
    expect(await harness(w).run("restart")).toBe(1);
    expect(w.calls).toEqual(["shutdown"]); // no kill, no launch
  });
});

describe("daemon restart", () => {
  test("stops the running daemon, then starts a new one", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 0 } });
    w.alive.add(42);
    const h = harness(w);
    expect(await h.run("restart")).toBe(0);
    expect(w.calls[0]).toBe("shutdown");
    expect(w.calls[1]).toMatch(/^launch /);
    expect(h.out.at(-1)).toMatch(/^homefleetd started/);
  });

  test("a failed stop never starts", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 1 } });
    w.alive.add(42);
    expect(await harness(w).run("restart")).toBe(1);
    expect(w.calls).toEqual(["shutdown"]); // refused busy; no launch
  });

  test("restart --force passes force to the stop", async () => {
    const w = world({ daemon: { pid: 42, version: "0.7.0", activeJobs: 1 } });
    w.alive.add(42);
    expect(await harness(w).run("restart", "--force")).toBe(0);
    expect(w.calls[0]).toBe("shutdown force");
  });
});
