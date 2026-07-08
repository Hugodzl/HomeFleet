/**
 * Drives `runCli` end to end against FAKE deps for every subcommand — no
 * real fs, no real network, no real daemon. `setup` in particular is proof
 * that it needs neither (per the Unit brief): its fake `loadConfig` /
 * `ensureIdentity` never touch disk, and no `makeControlClient` call is even
 * exercised in the setup tests.
 */
import { describe, expect, test } from "vitest";
import type { DaemonConfig } from "../config/config.js";
import { type CliDeps, type CliIdentity, runCli } from "./cli.js";
import type {
  ControlClientLike,
  PairBeginResult,
  PairConnectInput,
} from "./control-client.js";
import {
  ControlRequestError,
  DaemonUnreachableError,
} from "./control-client.js";

const FAKE_DEVICE_ID = "a".repeat(64);
const FAKE_PEER_DEVICE_ID = "b".repeat(64);

function fakeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    discovery: {
      mdnsEnabled: true,
      udpEnabled: true,
      udpPort: 56371,
      multicastGroup: "239.1.2.3",
      announceIntervalMs: 60_000,
      staticNodes: [],
    },
    workspace: {
      allowedRepoIds: [],
      maxBundleBytes: 1,
      maxCachedCheckouts: 1,
      gcAfterFetches: 1,
      gitTimeoutMs: 1000,
    },
    node: {},
    hfp: { host: "0.0.0.0", port: 56370 },
    mcp: { host: "127.0.0.1", port: 56372 },
    control: { host: "127.0.0.1", port: 56373 },
    executors: {},
    models: [],
    jobs: {},
    repos: [],
    ...overrides,
  } as DaemonConfig;
}

/** A fully-functional fake control client; individual methods overridden per test. */
function fakeControlClient(
  overrides: Partial<ControlClientLike> = {},
): ControlClientLike {
  return {
    pairBegin: async (): Promise<PairBeginResult> => ({
      code: "ABCDEFGH",
      expiresAt: Date.now() + 600_000,
    }),
    pairConnect: async (_input: PairConnectInput) => ({
      accepted: true,
      deviceId: FAKE_PEER_DEVICE_ID,
      name: "peer-node",
    }),
    status: async () => ({
      deviceId: FAKE_DEVICE_ID,
      name: "test-node",
      platform: "linux",
      daemonVersion: "0.1.0",
      protocolVersion: "0.1.0",
      hfpPort: 56370,
      mcpPort: 56372,
      controlPort: 56373,
      roles: ["execution"],
      executors: ["command"],
      models: [{ id: "test-model" }],
      activeJobs: 1,
      maxConcurrentJobs: 4,
    }),
    nodes: async () => [],
    ...overrides,
  };
}

interface Harness {
  deps: CliDeps;
  stdoutLines: string[];
  stderrLines: string[];
  controlClient: ControlClientLike;
  makeControlClientCalls: Array<{ host: string; port: number }>;
}

function makeHarness(
  options: {
    config?: DaemonConfig;
    identity?: CliIdentity;
    controlClient?: ControlClientLike;
  } = {},
): Harness {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const config = options.config ?? fakeConfig();
  const identity = options.identity ?? { deviceId: FAKE_DEVICE_ID };
  const controlClient = options.controlClient ?? fakeControlClient();
  const makeControlClientCalls: Array<{ host: string; port: number }> = [];
  const deps: CliDeps = {
    dataDir: "/fake/data-dir",
    loadConfig: async (dataDir: string) => {
      expect(dataDir).toBe("/fake/data-dir");
      return config;
    },
    ensureIdentity: async (dataDir: string) => {
      expect(dataDir).toBe("/fake/data-dir");
      return identity;
    },
    makeControlClient: (opts) => {
      makeControlClientCalls.push(opts);
      return controlClient;
    },
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    nodeExecPath: "C:\\fake\\node.exe",
    daemonEntryPath: "C:\\fake\\homefleetd.ts",
  };
  return {
    deps,
    stdoutLines,
    stderrLines,
    controlClient,
    makeControlClientCalls,
  };
}

describe("usage / unknown", () => {
  test("--help prints usage and returns 0", async () => {
    const { deps, stdoutLines } = makeHarness();
    const code = await runCli(["--help"], deps);
    expect(code).toBe(0);
    expect(stdoutLines.join("\n")).toContain("Usage:");
  });

  test("no subcommand prints usage to STDERR and returns 2", async () => {
    const { deps, stdoutLines, stderrLines } = makeHarness();
    const code = await runCli([], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("Usage:");
    // Only the successful --help path writes to stdout.
    expect(stdoutLines).toEqual([]);
  });

  test("unknown subcommand prints usage to STDERR and returns 2", async () => {
    const { deps, stdoutLines, stderrLines } = makeHarness();
    const code = await runCli(["bogus"], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("Usage:");
    expect(stdoutLines).toEqual([]);
  });
});

describe("setup", () => {
  test("prints identity, ports, firewall/profile/autostart commands, without a control client", async () => {
    const { deps, stdoutLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["setup"], deps);
    expect(code).toBe(0);
    // setup must never talk to the daemon.
    expect(makeControlClientCalls).toEqual([]);

    const output = stdoutLines.join("\n");
    expect(output).toContain(FAKE_DEVICE_ID);
    // Firewall ALLOW commands (Unit 8), using this config's ports.
    expect(output).toContain("New-NetFirewallRule");
    expect(output).toContain("-LocalPort 56370");
    expect(output).toContain("-LocalPort 56371");
    expect(output).toContain("ELEVATED PowerShell");
    // Public-profile check + warning.
    expect(output).toContain("Get-NetConnectionProfile");
    expect(output).toContain("WARNING");
    // Autostart create command, using the injected node/daemon paths.
    expect(output).toContain("schtasks /Create");
    expect(output).toContain("node.exe");
    expect(output).toContain("homefleetd.ts");
  });

  test("works with no dataDir/network side effects even without a configured node name", async () => {
    const { deps, stdoutLines } = makeHarness({
      config: fakeConfig({ node: {} }),
    });
    const code = await runCli(["setup"], deps);
    expect(code).toBe(0);
    expect(stdoutLines.join("\n")).toContain(
      "(unset — falls back to this machine's hostname",
    );
  });
});

describe("pair begin", () => {
  test("prints the code and connect instructions, using config.control for the client", async () => {
    const { deps, stdoutLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["pair", "begin"], deps);
    expect(code).toBe(0);
    const output = stdoutLines.join("\n");
    expect(output).toContain("ABCDEFGH");
    expect(output).toContain("homefleet pair connect");
    expect(output).toContain("56370"); // this node's hfp port from config
    expect(makeControlClientCalls).toEqual([
      { host: "127.0.0.1", port: 56373 },
    ]);
  });

  test("omits the Expires line when the daemon doesn't report expiresAt", async () => {
    const controlClient = fakeControlClient({
      pairBegin: async () => ({ code: "ABCDEFGH" }),
    });
    const { deps, stdoutLines } = makeHarness({ controlClient });
    const code = await runCli(["pair", "begin"], deps);
    expect(code).toBe(0);
    const output = stdoutLines.join("\n");
    expect(output).toContain("ABCDEFGH");
    expect(output).not.toContain("Expires:");
  });

  test("extra positional argument is a usage error (exit 2)", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["pair", "begin", "bogus-arg"], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("unexpected extra argument");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("DaemonUnreachableError yields a friendly stderr message and exit 1", async () => {
    const controlClient = fakeControlClient({
      pairBegin: async () => {
        throw new DaemonUnreachableError(
          "127.0.0.1",
          56373,
          new Error("ECONNREFUSED"),
        );
      },
    });
    const { deps, stderrLines } = makeHarness({ controlClient });
    const code = await runCli(["pair", "begin"], deps);
    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain("Is homefleetd running?");
    expect(stderrLines.join("\n")).not.toContain("ECONNREFUSED");
    expect(stderrLines.join("\n")).not.toMatch(/at .*control-client/); // no stack
  });
});

describe("pair connect", () => {
  test("accepted pairing prints peer name and short id, using config.control for the client", async () => {
    const { deps, stdoutLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(
      ["pair", "connect", "192.168.1.50", "56370", "ABCDEFGH"],
      deps,
    );
    expect(code).toBe(0);
    expect(stdoutLines.join("\n")).toContain("peer-node");
    expect(makeControlClientCalls).toEqual([
      { host: "127.0.0.1", port: 56373 },
    ]);
  });

  test("accepted pairing without a deviceId falls back to 'unknown'", async () => {
    const controlClient = fakeControlClient({
      pairConnect: async () => ({ accepted: true, name: "peer-node" }),
    });
    const { deps, stdoutLines } = makeHarness({ controlClient });
    const code = await runCli(
      ["pair", "connect", "192.168.1.50", "56370", "ABCDEFGH"],
      deps,
    );
    expect(code).toBe(0);
    expect(stdoutLines.join("\n")).toContain(
      'Paired with "peer-node" (unknown).',
    );
  });

  test("passes --expect through as expectedDeviceId", async () => {
    let received: PairConnectInput | undefined;
    const controlClient = fakeControlClient({
      pairConnect: async (input) => {
        received = input;
        return { accepted: true, deviceId: FAKE_PEER_DEVICE_ID, name: "peer" };
      },
    });
    const { deps } = makeHarness({ controlClient });
    const code = await runCli(
      [
        "pair",
        "connect",
        "192.168.1.50",
        "56370",
        "ABCDEFGH",
        "--expect",
        FAKE_PEER_DEVICE_ID,
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(received).toEqual({
      host: "192.168.1.50",
      port: 56370,
      code: "ABCDEFGH",
      expectedDeviceId: FAKE_PEER_DEVICE_ID,
    });
  });

  test("rejected pairing (wrong/expired code) prints a clear message and returns nonzero", async () => {
    const controlClient = fakeControlClient({
      pairConnect: async () => ({ accepted: false }),
    });
    const { deps, stderrLines } = makeHarness({ controlClient });
    const code = await runCli(
      ["pair", "connect", "192.168.1.50", "56370", "WRONGCOD"],
      deps,
    );
    expect(code).not.toBe(0);
    expect(stderrLines.join("\n")).toMatch(/wrong|expired/i);
  });

  test("missing positional args is a usage error (exit 2), no control client built", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["pair", "connect", "192.168.1.50"], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("usage");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("empty host is a usage error (exit 2), no control client built", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(
      ["pair", "connect", "", "56370", "ABCDEFGH"],
      deps,
    );
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("host must not be empty");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("extra positional argument (e.g. a forgotten --expect) is a usage error, not silently dropped", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(
      [
        "pair",
        "connect",
        "192.168.1.50",
        "56370",
        "ABCDEFGH",
        FAKE_PEER_DEVICE_ID,
      ],
      deps,
    );
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("unexpected extra argument");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("--expect with no following value is a usage error (exit 2)", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(
      ["pair", "connect", "192.168.1.50", "56370", "ABCDEFGH", "--expect"],
      deps,
    );
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("requires a deviceId argument");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("invalid port is a usage error (exit 2) with a specific message", async () => {
    const { deps, stderrLines } = makeHarness();
    const code = await runCli(
      ["pair", "connect", "host", "not-a-port", "ABCDEFGH"],
      deps,
    );
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain('invalid port "not-a-port"');
  });

  test("DaemonUnreachableError yields friendly stderr and exit 1", async () => {
    const controlClient = fakeControlClient({
      pairConnect: async () => {
        throw new DaemonUnreachableError("127.0.0.1", 56373, new Error("boom"));
      },
    });
    const { deps, stderrLines } = makeHarness({ controlClient });
    const code = await runCli(
      ["pair", "connect", "192.168.1.50", "56370", "ABCDEFGH"],
      deps,
    );
    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain("Is homefleetd running?");
  });

  test("a peer-unreachable ControlRequestError (502) prints a labeled message, not a raw errno string", async () => {
    const controlClient = fakeControlClient({
      pairConnect: async () => {
        throw new ControlRequestError(
          502,
          "connect ECONNREFUSED 192.168.1.50:56370",
        );
      },
    });
    const { deps, stderrLines } = makeHarness({ controlClient });
    const code = await runCli(
      ["pair", "connect", "192.168.1.50", "56370", "ABCDEFGH"],
      deps,
    );
    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain(
      "Could not reach the peer at 192.168.1.50:56370",
    );
    expect(stderrLines.join("\n")).toContain(
      "connect ECONNREFUSED 192.168.1.50:56370",
    );
  });
});

describe("pair (unknown subcommand)", () => {
  test("unknown pair subcommand is a usage error", async () => {
    const { deps, stderrLines } = makeHarness();
    const code = await runCli(["pair", "bogus"], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain(
      "usage: homefleet pair <begin|connect>",
    );
  });
});

describe("nodes", () => {
  test("empty directory prints a clear message, using config.control for the client", async () => {
    const { deps, stdoutLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["nodes"], deps);
    expect(code).toBe(0);
    expect(stdoutLines.join("\n")).toMatch(/no paired nodes/i);
    expect(makeControlClientCalls).toEqual([
      { host: "127.0.0.1", port: 56373 },
    ]);
  });

  test("extra positional argument is a usage error (exit 2), no control client built", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["nodes", "bogus"], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("unexpected extra argument");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("prints an aligned table with one row per node", async () => {
    const controlClient = fakeControlClient({
      nodes: async () => [
        {
          deviceId: FAKE_PEER_DEVICE_ID,
          name: "workstation",
          host: "192.168.1.51",
          port: 56370,
          reachable: true,
          nodeInfo: {
            deviceId: FAKE_PEER_DEVICE_ID,
            name: "workstation",
            daemonVersion: "0.1.0",
            protocolVersion: "0.1.0",
            platform: "win32",
            roles: ["execution"],
            executors: ["command"],
            models: [{ id: "gpt-oss" }],
            hardware: { cpu: "x", ramBytes: 1, gpus: [] },
            maxConcurrentJobs: 2,
            activeJobs: 0,
          },
        },
        {
          deviceId: "c".repeat(64),
          name: "sleepy-laptop",
          reachable: false,
        },
      ],
    });
    const { deps, stdoutLines } = makeHarness({ controlClient });
    const code = await runCli(["nodes"], deps);
    expect(code).toBe(0);
    const output = stdoutLines.join("\n");
    expect(output).toContain("workstation");
    expect(output).toContain("sleepy-laptop");
    expect(output).toContain("yes");
    expect(output).toContain("no");
    expect(output).toContain("command");
    expect(output).toContain("gpt-oss");
  });

  test("DaemonUnreachableError yields friendly stderr and exit 1", async () => {
    const controlClient = fakeControlClient({
      nodes: async () => {
        throw new DaemonUnreachableError("127.0.0.1", 56373, new Error("boom"));
      },
    });
    const { deps, stderrLines } = makeHarness({ controlClient });
    const code = await runCli(["nodes"], deps);
    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain("Is homefleetd running?");
  });
});

describe("status", () => {
  test("prints key: value lines for every field, using config.control for the client", async () => {
    const { deps, stdoutLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["status"], deps);
    expect(code).toBe(0);
    const output = stdoutLines.join("\n");
    expect(output).toContain(`deviceId: ${FAKE_DEVICE_ID}`);
    expect(output).toContain("name: test-node");
    expect(output).toContain("platform: linux");
    expect(output).toContain("hfpPort: 56370");
    expect(output).toContain("mcpPort: 56372");
    expect(output).toContain("controlPort: 56373");
    expect(output).toContain("roles: execution");
    expect(output).toContain("executors: command");
    expect(output).toContain("models: test-model");
    expect(output).toContain("activeJobs: 1");
    expect(output).toContain("maxConcurrentJobs: 4");
    expect(makeControlClientCalls).toEqual([
      { host: "127.0.0.1", port: 56373 },
    ]);
  });

  test("extra positional argument is a usage error (exit 2), no control client built", async () => {
    const { deps, stderrLines, makeControlClientCalls } = makeHarness();
    const code = await runCli(["status", "bogus"], deps);
    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain("unexpected extra argument");
    expect(makeControlClientCalls).toEqual([]);
  });

  test("empty roles/executors/models fall back to '(none)'", async () => {
    const controlClient = fakeControlClient({
      status: async () => ({
        deviceId: FAKE_DEVICE_ID,
        name: "test-node",
        platform: "linux",
        daemonVersion: "0.1.0",
        protocolVersion: "0.1.0",
        hfpPort: 56370,
        mcpPort: 56372,
        controlPort: 56373,
        roles: [],
        executors: [],
        models: [],
        activeJobs: 0,
        maxConcurrentJobs: 4,
      }),
    });
    const { deps, stdoutLines } = makeHarness({ controlClient });
    const code = await runCli(["status"], deps);
    expect(code).toBe(0);
    const output = stdoutLines.join("\n");
    expect(output).toContain("roles: (none)");
    expect(output).toContain("executors: (none)");
    expect(output).toContain("models: (none)");
  });

  test("DaemonUnreachableError yields a friendly stderr message and exit 1, no stack", async () => {
    const controlClient = fakeControlClient({
      status: async () => {
        throw new DaemonUnreachableError(
          "127.0.0.1",
          56373,
          new Error("ECONNREFUSED"),
        );
      },
    });
    const { deps, stderrLines } = makeHarness({ controlClient });
    const code = await runCli(["status"], deps);
    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain(
      "Could not reach the homefleet daemon on 127.0.0.1:56373",
    );
    expect(stderrLines.join("\n")).toContain("Is homefleetd running?");
  });
});

describe("unexpected errors", () => {
  test("a non-DaemonUnreachableError from loadConfig is reported cleanly (no stack) and returns 1", async () => {
    const { deps, stderrLines } = makeHarness();
    deps.loadConfig = async () => {
      throw new Error("config.json is not valid JSON");
    };
    const code = await runCli(["status"], deps);
    expect(code).toBe(1);
    expect(stderrLines.join("\n")).toContain("config.json is not valid JSON");
    expect(stderrLines.join("\n")).not.toMatch(/at .*\.ts:\d+/);
  });
});
