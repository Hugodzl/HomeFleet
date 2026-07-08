/**
 * Tests for the M9 NodeInfo builder: the name resolution chain, role/executor
 * derivation from config, live job-load reflection, delegating-front
 * defaults, and fail-closed schema validation of every emitted profile.
 */
import { MIN_AGENT_CONTEXT_WINDOW } from "@homefleet/executors";
import { HFP_PROTOCOL_VERSION, NodeInfoSchema } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { DaemonConfigSchema } from "../config/config.js";
import { JobManager } from "../jobs/job-manager.js";
import {
  createNodeInfoProvider,
  currentPlatform,
  type JobLoadSource,
} from "./node-info.js";

/** 64 lowercase hex chars — a valid DeviceIdSchema value. */
const DEVICE_ID = "ab".repeat(32);

/** Minimal valid agent-executor config (endpoint is required). */
const AGENT_EXECUTOR = {
  endpoint: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "test-model",
    contextWindow: MIN_AGENT_CONTEXT_WINDOW,
  },
};

/**
 * Builds a provider from a RAW config object (run through the real
 * DaemonConfigSchema, so tests exercise the exact shapes the daemon loads).
 */
function makeProvider(options: {
  config?: unknown;
  jobs?: JobLoadSource;
  hostname?: string;
  daemonVersion?: string;
}) {
  return createNodeInfoProvider({
    deviceId: DEVICE_ID,
    config: DaemonConfigSchema.parse(options.config ?? {}),
    daemonVersion: options.daemonVersion ?? "0.1.0",
    jobs: options.jobs,
    hostname: options.hostname,
  });
}

// --- name resolution chain -------------------------------------------------

test("config node.name wins over the hostname", () => {
  const info = makeProvider({
    config: { node: { name: "study-pc" } },
    hostname: "some-real-host",
  })();
  expect(info.name).toBe("study-pc");
});

test("without a configured name, the hostname is used", () => {
  const info = makeProvider({ hostname: "my-host" })();
  expect(info.name).toBe("my-host");
});

test("an empty hostname falls back to the fixed name 'homefleet'", () => {
  const info = makeProvider({ hostname: "" })();
  expect(info.name).toBe("homefleet");
});

test("an over-long hostname is truncated to the 64-char name limit", () => {
  const info = makeProvider({ hostname: "h".repeat(80) })();
  expect(info.name).toBe("h".repeat(64));
});

test("with no hostname override the real os.hostname() yields a valid name", () => {
  const info = makeProvider({})();
  expect(info.name.length).toBeGreaterThanOrEqual(1);
  expect(info.name.length).toBeLessThanOrEqual(64);
});

// --- role/executor derivation ----------------------------------------------

test("no configured executors -> no executors, no roles", () => {
  const info = makeProvider({})();
  expect(info.executors).toEqual([]);
  expect(info.roles).toEqual([]);
});

test("command executor only -> execution role only", () => {
  const info = makeProvider({
    config: { executors: { command: {} } },
  })();
  expect(info.executors).toEqual(["command"]);
  expect(info.roles).toEqual(["execution"]);
});

test("agent executor only -> inference role only (agent does not imply execution)", () => {
  const info = makeProvider({
    config: { executors: { agent: AGENT_EXECUTOR } },
  })();
  expect(info.executors).toEqual(["agent"]);
  expect(info.roles).toEqual(["inference"]);
});

test("both executors -> both roles", () => {
  const info = makeProvider({
    config: { executors: { command: {}, agent: AGENT_EXECUTOR } },
  })();
  expect(info.executors).toEqual(["command", "agent"]);
  expect(info.roles).toEqual(["execution", "inference"]);
});

// --- job load ---------------------------------------------------------------

test("a live jobs source is re-read on every call (activeJobs changes)", () => {
  let active = 0;
  const build = makeProvider({
    jobs: { activeJobCount: () => active, maxConcurrent: 4 },
  });
  expect(build().activeJobs).toBe(0);
  expect(build().maxConcurrentJobs).toBe(4);
  active = 3;
  expect(build().activeJobs).toBe(3);
});

test("a real JobManager satisfies the jobs source shape", () => {
  // Compile-time: JobManager must be assignable to JobLoadSource.
  const manager: JobLoadSource = new JobManager({
    executors: [],
    resolveWorkspace: async () => ({ dir: ".", release: () => {} }),
    maxConcurrentJobs: 3,
  });
  const info = makeProvider({ jobs: manager })();
  expect(info.maxConcurrentJobs).toBe(3);
  expect(info.activeJobs).toBe(0);
});

test("without a jobs source, delegating-front defaults apply (1 slot, 0 active)", () => {
  const info = makeProvider({})();
  expect(info.maxConcurrentJobs).toBe(1);
  expect(info.activeJobs).toBe(0);
});

// --- pass-through + static facts ---------------------------------------------

test("configured models are advertised as-is", () => {
  const models = [{ id: "llama-3.1-8b", contextWindow: 131_072 }];
  const info = makeProvider({ config: { models } })();
  expect(info.models).toEqual(models);
});

test("versions, platform, and hardware facts are populated", () => {
  const info = makeProvider({ daemonVersion: "9.9.9" })();
  expect(info.deviceId).toBe(DEVICE_ID);
  expect(info.daemonVersion).toBe("9.9.9");
  expect(info.protocolVersion).toBe(HFP_PROTOCOL_VERSION);
  expect(info.platform).toBe(currentPlatform());
  expect(["win32", "linux", "darwin"]).toContain(info.platform);
  expect(info.hardware.cpu.length).toBeGreaterThan(0);
  expect(info.hardware.ramBytes).toBeGreaterThan(0);
  // GPU detection is deliberately out of scope for v0.
  expect(info.hardware.gpus).toEqual([]);
});

test("every emitted profile parses NodeInfoSchema", () => {
  const info = makeProvider({
    config: {
      node: { name: "n" },
      executors: { command: {}, agent: AGENT_EXECUTOR },
      models: [{ id: "m" }],
    },
  })();
  expect(() => NodeInfoSchema.parse(info)).not.toThrow();
});

test("a schema-violating profile fails closed at build time", () => {
  // A hostname with a control character survives truncation but violates
  // NodeNameSchema — the provider must throw rather than emit it.
  const build = makeProvider({
    hostname: `bad${String.fromCharCode(0x07)}name`,
  });
  expect(() => build()).toThrow();
});
