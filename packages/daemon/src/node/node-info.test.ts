/**
 * Tests for the M9 NodeInfo builder: the name resolution chain, role/executor
 * derivation from config, live job-load reflection, delegating-front
 * defaults, and fail-closed schema validation of every emitted profile.
 */
import { MIN_AGENT_CONTEXT_WINDOW } from "@homefleet/executors";
import {
  HFP_PROTOCOL_VERSION,
  type ModelInfo,
  NodeInfoSchema,
} from "@homefleet/protocol";
import { expect, test } from "vitest";
import { DaemonConfigSchema } from "../config/config.js";
import { JobManager } from "../jobs/job-manager.js";
import {
  createNodeInfoProvider,
  currentPlatform,
  type JobLoadSource,
  type NodeInfoConfig,
} from "./node-info.js";

/** 64 lowercase hex chars — a valid DeviceIdSchema value. */
const DEVICE_ID = "ab".repeat(32);

/**
 * A one-model catalog: agent/write executors are cross-validated against
 * `catalog.models` (an executor configured with an empty catalog is a config
 * error), so any test that configures one must supply this alongside.
 */
const CATALOG = {
  models: [{ id: "test-model", contextWindow: MIN_AGENT_CONTEXT_WINDOW }],
};

/** Minimal valid agent-executor config (defaultModel names a catalog id). */
const AGENT_EXECUTOR = { defaultModel: "test-model" };

/** Minimal valid write-executor config (same shape as agent today). */
const WRITE_EXECUTOR = { defaultModel: "test-model" };

/**
 * Builds a provider from a RAW config object (run through the real
 * DaemonConfigSchema, so tests exercise the exact shapes the daemon loads).
 */
function makeProvider(options: {
  config?: unknown;
  jobs?: JobLoadSource;
  hostname?: string;
  daemonVersion?: string;
  models?: ModelInfo[];
}) {
  return createNodeInfoProvider({
    deviceId: DEVICE_ID,
    config: DaemonConfigSchema.parse(options.config ?? {}),
    daemonVersion: options.daemonVersion ?? "0.1.0",
    jobs: options.jobs,
    hostname: options.hostname,
    models: options.models ?? [],
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

test("without a configured name, the hostname gets a deviceId suffix", () => {
  // The suffix disambiguates two machines that share a hostname — it prevents
  // an mDNS same-service-name collision (see resolveNodeName).
  const info = makeProvider({ hostname: "my-host" })();
  expect(info.name).toBe(`my-host-${DEVICE_ID.slice(0, 8)}`);
});

test("an empty hostname falls back to 'homefleet' plus the deviceId suffix", () => {
  const info = makeProvider({ hostname: "" })();
  expect(info.name).toBe(`homefleet-${DEVICE_ID.slice(0, 8)}`);
});

test("an over-long hostname is truncated so base+suffix fits the 64-char cap", () => {
  const info = makeProvider({ hostname: "h".repeat(80) })();
  const suffix = DEVICE_ID.slice(0, 8);
  // 55 h's + "-" + 8 hex = 64 chars exactly.
  expect(info.name).toBe(`${"h".repeat(64 - suffix.length - 1)}-${suffix}`);
  expect(info.name.length).toBe(64);
});

test("same hostname + different deviceIds yield distinct names (mDNS de-collision)", () => {
  const config = DaemonConfigSchema.parse({});
  const a = createNodeInfoProvider({
    deviceId: "aa".repeat(32),
    config,
    daemonVersion: "0.1.0",
    hostname: "sharedhost",
    models: [],
  })();
  const b = createNodeInfoProvider({
    deviceId: "bb".repeat(32),
    config,
    daemonVersion: "0.1.0",
    hostname: "sharedhost",
    models: [],
  })();
  expect(a.name).toBe("sharedhost-aaaaaaaa");
  expect(b.name).toBe("sharedhost-bbbbbbbb");
  expect(a.name).not.toBe(b.name);
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
    config: { executors: { agent: AGENT_EXECUTOR }, catalog: CATALOG },
  })();
  expect(info.executors).toEqual(["agent"]);
  expect(info.roles).toEqual(["inference"]);
});

test("both executors -> both roles", () => {
  const info = makeProvider({
    config: {
      executors: { command: {}, agent: AGENT_EXECUTOR },
      catalog: CATALOG,
    },
  })();
  expect(info.executors).toEqual(["command", "agent"]);
  expect(info.roles).toEqual(["execution", "inference"]);
});

test("write executor only -> inference role only", () => {
  const info = makeProvider({
    config: { executors: { write: WRITE_EXECUTOR }, catalog: CATALOG },
  })();
  expect(info.executors).toEqual(["write"]);
  expect(info.roles).toEqual(["inference"]);
});

test("all three executors -> all kinds advertised, roles deduplicated", () => {
  const info = makeProvider({
    config: {
      executors: { command: {}, agent: AGENT_EXECUTOR, write: WRITE_EXECUTOR },
      catalog: CATALOG,
    },
  })();
  expect(info.executors).toEqual(["command", "agent", "write"]);
  // agent and write BOTH map to "inference"; the role is advertised once.
  expect(info.roles).toEqual(["execution", "inference"]);
});

// --- job load ---------------------------------------------------------------

test("a live jobs source is re-read on every call (activeJobs changes)", () => {
  let active = 0;
  const build = makeProvider({
    jobs: {
      get activeJobs() {
        return active;
      },
      maxConcurrent: 4,
    },
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
    resolveWorkspace: async () => ({ dir: ".", release: async () => {} }),
    resolveModel: () => ({ ok: true }),
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
  const info = makeProvider({ models })();
  expect(info.models).toEqual(models);
});

test("the provider advertises the models it is given, verbatim", () => {
  const provider = createNodeInfoProvider({
    deviceId: "a".repeat(64),
    config: {
      node: {},
      executors: { agent: { defaultModel: "qwen" } },
    } as NodeInfoConfig,
    daemonVersion: "0.2.0",
    hostname: "tower",
    models: [{ id: "qwen", label: "Qwen", contextWindow: 32768, status: "ok" }],
  });
  expect(provider().models).toEqual([
    { id: "qwen", label: "Qwen", contextWindow: 32768, status: "ok" },
  ]);
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
      catalog: CATALOG,
    },
    models: [{ id: "m" }],
  })();
  expect(() => NodeInfoSchema.parse(info)).not.toThrow();
});

test("a schema-violating profile fails closed at FACTORY time", () => {
  // A hostname with a control character survives truncation but violates
  // NodeNameSchema. All failable fields are static, so the profile would be
  // invalid forever — the FACTORY itself must throw (eager validation), so
  // daemon assembly fails at startup instead of every later `hello`.
  expect(() =>
    makeProvider({ hostname: `bad${String.fromCharCode(0x07)}name` }),
  ).toThrow();
});
