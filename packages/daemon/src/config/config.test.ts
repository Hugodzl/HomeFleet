import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MIN_AGENT_CONTEXT_WINDOW } from "@homefleet/executors";
import {
  DISCOVERY_MULTICAST_GROUP,
  DISCOVERY_UDP_PORT,
  HFP_DEFAULT_PORT,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_CACHED_CHECKOUTS,
  DEFAULT_MCP_PORT,
  DEFAULT_WORKSPACE_GC_AFTER_FETCHES,
  DEFAULT_WORKSPACE_GIT_TIMEOUT_MS,
  loadDaemonConfig,
} from "./config.js";

const tempDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-config-");
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

async function writeConfig(dir: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, "config.json"), contents, "utf8");
}

test("a missing config file yields all defaults", async () => {
  const config = await loadDaemonConfig(await newDataDir());
  expect(config).toEqual({
    discovery: {
      mdnsEnabled: true,
      udpEnabled: true,
      udpPort: DISCOVERY_UDP_PORT,
      multicastGroup: DISCOVERY_MULTICAST_GROUP,
      announceIntervalMs: 60_000,
      staticNodes: [],
    },
    workspace: {
      allowedRepoIds: [],
      maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
      maxCachedCheckouts: DEFAULT_MAX_CACHED_CHECKOUTS,
      gcAfterFetches: DEFAULT_WORKSPACE_GC_AFTER_FETCHES,
      gitTimeoutMs: DEFAULT_WORKSPACE_GIT_TIMEOUT_MS,
    },
    node: {},
    hfp: { host: "0.0.0.0", port: HFP_DEFAULT_PORT },
    mcp: { host: "127.0.0.1", port: DEFAULT_MCP_PORT },
    control: { host: "127.0.0.1", port: DEFAULT_CONTROL_PORT },
    executors: {},
    catalog: { models: [] },
    jobs: {},
    repos: [],
  });
  expect(config.discovery.bindAddress).toBeUndefined();
  // Empty allowlist by default => the worker accepts no repos (fail closed).
  expect(config.workspace.cacheDir).toBeUndefined();
  // No name by default: the assembly falls back to os.hostname() at startup.
  expect(config.node.name).toBeUndefined();
  // No executors by default: a fresh install offers nothing (fail closed).
  expect(config.executors.command).toBeUndefined();
  expect(config.executors.agent).toBeUndefined();
  expect(config.executors.write).toBeUndefined();
  // No job limits by default: the JobManager's own defaults apply.
  expect(config.jobs.maxConcurrentJobs).toBeUndefined();
  expect(config.jobs.maxQueuedJobs).toBeUndefined();
  expect(config.jobs.maxRetainedJobs).toBeUndefined();
});

test("workspace config: empty allowlist is the fail-closed default", async () => {
  const config = await loadDaemonConfig(await newDataDir());
  expect(config.workspace.allowedRepoIds).toEqual([]);
});

test("workspace config merges partial overrides with defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      workspace: {
        allowedRepoIds: ["homefleet", "my-repo"],
        maxCachedCheckouts: 4,
        cacheDir: "/srv/homefleet/ws",
      },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.workspace.allowedRepoIds).toEqual(["homefleet", "my-repo"]);
  expect(config.workspace.maxCachedCheckouts).toBe(4);
  expect(config.workspace.cacheDir).toBe("/srv/homefleet/ws");
  // Untouched fields keep their defaults.
  expect(config.workspace.maxBundleBytes).toBe(DEFAULT_MAX_BUNDLE_BYTES);
  expect(config.workspace.gitTimeoutMs).toBe(DEFAULT_WORKSPACE_GIT_TIMEOUT_MS);
});

test("a schema-invalid workspace config throws (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ workspace: { maxBundleBytes: "huge" } }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an empty JSON object yields all defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, "{}");
  const config = await loadDaemonConfig(dir);
  expect(config.discovery.mdnsEnabled).toBe(true);
  expect(config.discovery.udpPort).toBe(DISCOVERY_UDP_PORT);
});

test("partial discovery config merges with defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      discovery: { udpEnabled: false, bindAddress: "192.168.1.10" },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.discovery.udpEnabled).toBe(false);
  expect(config.discovery.bindAddress).toBe("192.168.1.10");
  // Untouched fields keep their defaults.
  expect(config.discovery.mdnsEnabled).toBe(true);
  expect(config.discovery.multicastGroup).toBe(DISCOVERY_MULTICAST_GROUP);
  expect(config.discovery.announceIntervalMs).toBe(60_000);
});

test("static nodes round-trip, with and without expectedDeviceId", async () => {
  const dir = await newDataDir();
  const deviceId = "ab".repeat(32);
  await writeConfig(
    dir,
    JSON.stringify({
      discovery: {
        staticNodes: [
          { host: "192.168.1.20", port: 47113, expectedDeviceId: deviceId },
          { host: "nas.local", port: 47113 },
        ],
      },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.discovery.staticNodes).toEqual([
    { host: "192.168.1.20", port: 47113, expectedDeviceId: deviceId },
    { host: "nas.local", port: 47113 },
  ]);
});

test("a corrupt config file throws instead of falling back to defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, "{oops");
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a schema-invalid config file throws (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ discovery: { udpPort: "not-a-port" } }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an invalid static node deviceId throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      discovery: {
        staticNodes: [{ host: "h", port: 1, expectedDeviceId: "nope" }],
      },
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a full valid config round-trips every M9 section", async () => {
  const dir = await newDataDir();
  const full = {
    node: { name: "office-tower" },
    hfp: { host: "192.168.1.5", port: 47000 },
    mcp: { host: "localhost", port: 47001 },
    control: { host: "127.0.0.1", port: 47002 },
    executors: {
      command: {
        allowlist: {
          pnpm: { executable: "pnpm.cmd" },
          git: {},
        },
      },
      agent: {
        defaultModel: "qwen3-coder",
        commandAllowlist: { pnpm: { executable: "pnpm.cmd" } },
      },
    },
    catalog: {
      defaultEndpoint: {
        baseUrl: "http://192.168.1.9:1234/v1",
        apiKey: "sk-local",
      },
      models: [{ id: "qwen3-coder", contextWindow: 65536 }, { id: "llama3" }],
    },
    jobs: { maxConcurrentJobs: 2, maxQueuedJobs: 8, maxRetainedJobs: 100 },
    repos: [{ repoId: "homefleet", path: "D:/Git/HomeFleet" }],
  };
  await writeConfig(dir, JSON.stringify(full));
  const config = await loadDaemonConfig(dir);
  expect(config).toMatchObject(full);
  // The full config above deliberately omits `executors.write`: a fully
  // configured node still runs NO write executor until one is explicitly
  // added (fail closed, same posture as the other executors).
  expect(config.executors.write).toBeUndefined();
});

test("partial hfp/mcp/control configs merge with defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      hfp: { port: 0 },
      mcp: { port: 47010 },
      control: {},
    }),
  );
  const config = await loadDaemonConfig(dir);
  // Port 0 = ephemeral (tests / multiple daemons on one machine).
  expect(config.hfp).toEqual({ host: "0.0.0.0", port: 0 });
  expect(config.mcp).toEqual({ host: "127.0.0.1", port: 47010 });
  expect(config.control).toEqual({
    host: "127.0.0.1",
    port: DEFAULT_CONTROL_PORT,
  });
});

test("an out-of-range hfp port throws (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ hfp: { port: 65536 } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a node name with control characters throws", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ node: { name: "evil\u001bname" } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a command executor with only an empty allowlist parses (allows nothing)", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ executors: { command: {} } }));
  const config = await loadDaemonConfig(dir);
  expect(config.executors.command).toEqual({ allowlist: {} });
  expect(config.executors.agent).toBeUndefined();
});

test("an agent executor without a defaultModel parses", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      executors: { agent: {} },
      catalog: { models: [{ id: "m", contextWindow: 32768 }] },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.executors.agent).toEqual({});
});

test("a write executor parses defaultModel + commandAllowlist (same shape as agent)", async () => {
  const dir = await newDataDir();
  const write = {
    defaultModel: "qwen3-coder",
    commandAllowlist: { pnpm: { executable: "pnpm.cmd" } },
  };
  await writeConfig(
    dir,
    JSON.stringify({
      executors: { write },
      catalog: {
        defaultEndpoint: {
          baseUrl: "http://192.168.1.9:1234/v1",
          apiKey: "sk-local",
        },
        models: [{ id: "qwen3-coder", contextWindow: 65536 }],
      },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.executors.write).toEqual(write);
  // Configuring write does not implicitly enable the other executors.
  expect(config.executors.command).toBeUndefined();
  expect(config.executors.agent).toBeUndefined();
});

test("a write executor without an endpoint throws", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ executors: { write: {} } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a write endpoint contextWindow below the floor throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      executors: {
        write: {
          endpoint: {
            baseUrl: "http://localhost:1234/v1",
            model: "m",
            contextWindow: MIN_AGENT_CONTEXT_WINDOW - 1,
          },
        },
      },
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a model entry with a non-positive contextWindow throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ models: [{ id: "m", contextWindow: 0 }] }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a catalog with a shared default endpoint and per-entry override parses", async () => {
  const dir = await newDataDir();
  const cfg = {
    catalog: {
      defaultEndpoint: { baseUrl: "http://127.0.0.1:8080/v1" },
      models: [
        { id: "qwen3.5-9b", label: "Qwen 3.5 9B", contextWindow: 32768 },
        {
          id: "sdxl",
          contextWindow: 4096,
          endpoint: { baseUrl: "http://127.0.0.1:7860/v1" },
        },
      ],
    },
    executors: { agent: { defaultModel: "qwen3.5-9b" } },
    repos: [],
  };
  await writeConfig(dir, JSON.stringify(cfg));
  const config = await loadDaemonConfig(dir);
  expect(config.catalog.models).toHaveLength(2);
  expect(config.executors.agent?.defaultModel).toBe("qwen3.5-9b");
});

test("a duplicate catalog model id throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      catalog: { models: [{ id: "m" }, { id: "m" }] },
      repos: [],
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a defaultModel that is not a catalog id throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      catalog: { models: [{ id: "a", contextWindow: 32768 }] },
      executors: { agent: { defaultModel: "b" } },
      repos: [],
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an agent executor with an empty catalog throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      executors: { agent: { defaultModel: "a" } },
      catalog: { models: [] },
      repos: [],
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an unknown key inside a catalog entry throws (strict)", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      catalog: {
        models: [{ id: "a", contextWindow: 32768, provider: "ollama" }],
      },
      repos: [],
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a repo mapping with an empty path throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ repos: [{ repoId: "homefleet", path: "" }] }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("duplicate repoIds in repos are rejected at load time (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      repos: [
        { repoId: "homefleet", path: "/a" },
        { repoId: "homefleet", path: "/b" },
      ],
    }),
  );
  // A repoId maps to exactly one path; a second entry is ambiguous, not
  // silently last-wins.
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an unknown (typo'd) key throws instead of silently applying defaults", async () => {
  // Strip mode would drop "maxConcurrentJob" and run on the default limit
  // while the file LOOKS configured; strict parsing surfaces the typo.
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ jobs: { maxConcurrentJob: 2 } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an unknown top-level key throws", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ discoverey: {} }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a non-loopback mcp or control host throws at parse time", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ mcp: { host: "0.0.0.0" } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
  await writeConfig(dir, JSON.stringify({ control: { host: "192.168.1.5" } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("loopback aliases are accepted for mcp and control hosts", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ mcp: { host: "localhost" }, control: { host: "::1" } }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.mcp.host).toBe("localhost");
  expect(config.control.host).toBe("::1");
});

test("job limits below 1 throw", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ jobs: { maxConcurrentJobs: 0 } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("partial jobs config leaves the other limits to the JobManager", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ jobs: { maxConcurrentJobs: 2 } }));
  const config = await loadDaemonConfig(dir);
  expect(config.jobs.maxConcurrentJobs).toBe(2);
  expect(config.jobs.maxQueuedJobs).toBeUndefined();
  expect(config.jobs.maxRetainedJobs).toBeUndefined();
});

test("a non-ENOENT read failure throws instead of yielding defaults", async () => {
  const dir = await newDataDir();
  // A directory where the file should be makes readFile fail with a
  // non-ENOENT error (EISDIR/EPERM depending on platform). Falling back to
  // defaults here would silently re-enable channels the user disabled.
  await mkdir(path.join(dir, "config.json"));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(
    /Failed to read daemon config/,
  );
});
