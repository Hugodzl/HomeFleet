/**
 * End-to-end workspace-sync integration (M7): N paired daemon stacks on
 * 127.0.0.1 over real mTLS, each with a JobManager wired to a real
 * CommandExecutor and a real WorkspaceStore as its WorkspaceResolver. The
 * delegator drives HfpClient.syncWorkspace (real git bundles), then delegates a
 * `command` job that runs IN the materialized workspace and reads the synced
 * file. Real git, real repos, real bundles, real sockets — no fakes.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CommandExecutor } from "@homefleet/executors";
import {
  type JobEvent,
  type JobParams,
  JobResultSchema,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { resolveDataDir } from "../config/paths.js";
import { type Identity, loadOrCreateIdentity } from "../identity/identity.js";
import { JobManager } from "../jobs/job-manager.js";
import { registerJobRoutes } from "../jobs/routes.js";
import { PairingManager } from "../pairing/pairing.js";
import {
  makeNodeInfo,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import {
  HfpClient,
  type HfpRequestError,
  type HfpTarget,
} from "../transport/client.js";
import { NodeServer } from "../transport/server.js";
import { TrustStore } from "../trust/trust-store.js";
import { ok, resolveHeadCommit, runGit } from "./git.js";
import { registerWorkspaceRoutes } from "./routes.js";
import { WorkspaceStore } from "./workspace-store.js";

const HOST = "127.0.0.1";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDataDir(prefix);
  cleanups.push(() => removeTempDataDir(dir));
  return dir;
}

interface Daemon {
  identity: Identity;
  trustStore: TrustStore;
  pairing: PairingManager;
  client: HfpClient;
  jobManager: JobManager;
  store: WorkspaceStore;
  port: number;
  nodeInfo: () => ReturnType<typeof makeNodeInfo>;
}

async function createDaemon(
  name: string,
  options: { allowedRepoIds?: string[] } = {},
): Promise<Daemon> {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await tempDir(`homefleet-sync-${name}-`),
  });
  const identity = await loadOrCreateIdentity(dataDir);
  const trustStore = await TrustStore.load(dataDir);
  const nodeInfo = (): ReturnType<typeof makeNodeInfo> =>
    makeNodeInfo(identity.deviceId, name);
  const pairing = new PairingManager({
    trustStore,
    nodeInfoProvider: nodeInfo,
  });

  const cacheDir = path.join(await tempDir(`homefleet-cache-${name}-`), "ws");
  const store = new WorkspaceStore({
    cacheDir,
    allowedRepoIds: options.allowedRepoIds ?? [],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 8,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  });
  await store.init();

  const jobManager = new JobManager({
    executors: [
      new CommandExecutor({
        allowlist: { node: { executable: process.execPath } },
      }),
    ],
    resolveWorkspace: store.createResolver(),
  });

  const server = new NodeServer({
    identity,
    trustStore,
    nodeInfoProvider: nodeInfo,
    pairingManager: pairing,
    host: HOST,
    port: 0,
  });
  registerJobRoutes(server, jobManager);
  registerWorkspaceRoutes(server, store);
  const { port } = await server.start();
  cleanups.push(async () => {
    await jobManager.stop();
    await server.stop();
  });

  return {
    identity,
    trustStore,
    pairing,
    client: new HfpClient(identity),
    jobManager,
    store,
    port,
    nodeInfo,
  };
}

async function pair(a: Daemon, b: Daemon): Promise<void> {
  const { code } = b.pairing.beginPairing();
  const { response, serverDeviceId } = await a.client.pair(
    { host: HOST, port: b.port },
    code,
    a.nodeInfo(),
  );
  expect(response.accepted).toBe(true);
  await a.trustStore.add({
    deviceId: serverDeviceId,
    name: "b",
    addedAt: new Date().toISOString(),
  });
}

function target(b: Daemon): HfpTarget {
  return { host: HOST, port: b.port, expectedDeviceId: b.identity.deviceId };
}

interface Src {
  repoPath: string;
  commit(message: string, contents: string): Promise<string>;
}

async function makeSrc(): Promise<Src> {
  const repoPath = await tempDir("homefleet-src-");
  const run = async (args: string[]): Promise<void> => {
    const r = await runGit(args, { cwd: repoPath, timeoutMs: 30_000 });
    if (!ok(r)) {
      throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }
  };
  await run(["init", "--quiet"]);
  await run(["config", "user.email", "t@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  return {
    repoPath,
    async commit(message: string, contents: string): Promise<string> {
      await writeFile(path.join(repoPath, "data.txt"), contents);
      await run(["add", "-A"]);
      await run(["commit", "--quiet", "-m", message]);
      return resolveHeadCommit(repoPath, 30_000);
    },
  };
}

/** A command job that prints the synced file's contents from the workspace. */
function readFileJob(repoId: string, headCommit: string): JobParams {
  return {
    type: "command",
    workspace: { repoId, headCommit },
    command: "node",
    args: [
      "-e",
      "process.stdout.write(require('fs').readFileSync('data.txt','utf8'))",
    ],
    timeoutMs: 30_000,
  };
}

async function collect(
  client: HfpClient,
  t: HfpTarget,
  jobId: string,
): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for await (const event of client.streamJobEvents(t, jobId)) {
    events.push(event);
  }
  return events;
}

async function runJobAndGetResult(
  a: Daemon,
  t: HfpTarget,
  params: JobParams,
): Promise<ReturnType<typeof JobResultSchema.parse>> {
  const { jobId } = await a.client.delegate(t, params);
  const events = await collect(a.client, t, jobId);
  const last = events.at(-1);
  if (last?.type !== "result") {
    throw new Error("expected a terminal result event");
  }
  return JobResultSchema.parse(last.result);
}

test("full then incremental sync; a delegated command job reads the materialized file", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1", "hello from c1");
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { allowedRepoIds: ["repo-x"] });
  await pair(a, b);
  const t = target(b);

  // have-tip is null before the first sync.
  expect(await a.client.haveTip(t, "repo-x")).toBeNull();

  // Full sync, then a job that runs IN the workspace sees c1's content.
  const sync1 = await a.client.syncWorkspace(t, {
    repoPath: src.repoPath,
    repoId: "repo-x",
  });
  expect(sync1.headCommit).toBe(c1);
  expect(await a.client.haveTip(t, "repo-x")).toBe(c1);

  const r1 = await runJobAndGetResult(a, t, readFileJob("repo-x", c1));
  expect(r1.status).toBe("succeeded");
  expect(r1.output?.stdout).toBe("hello from c1");

  // Add a commit; incremental sync; a new job sees the new content.
  const c2 = await src.commit("c2", "updated in c2");
  const sync2 = await a.client.syncWorkspace(t, {
    repoPath: src.repoPath,
    repoId: "repo-x",
  });
  expect(sync2.headCommit).toBe(c2);
  expect(await a.client.haveTip(t, "repo-x")).toBe(c2);

  const r2 = await runJobAndGetResult(a, t, readFileJob("repo-x", c2));
  expect(r2.status).toBe("succeeded");
  expect(r2.output?.stdout).toBe("updated in c2");
}, 60_000);

test("a job for a commit never synced fails WORKSPACE_UNAVAILABLE", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { allowedRepoIds: ["repo-x"] });
  await pair(a, b);
  const t = target(b);

  const result = await runJobAndGetResult(
    a,
    t,
    readFileJob("repo-x", "a".repeat(40)),
  );
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("WORKSPACE_UNAVAILABLE");
}, 30_000);

test("syncing a non-allowlisted repo is rejected (allowlist enforced at the worker)", async () => {
  const src = await makeSrc();
  await src.commit("c1", "x");
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { allowedRepoIds: ["repo-x"] });
  await pair(a, b);
  const t = target(b);

  const error = await a.client
    .syncWorkspace(t, { repoPath: src.repoPath, repoId: "not-allowed" })
    .then(
      () => null,
      (e: unknown) => e as HfpRequestError,
    );
  expect(error?.status).toBe(403);
  expect(error?.hfpError?.code).toBe("WORKSPACE_UNAVAILABLE");
}, 30_000);

test("concurrent syncs of the same repo serialize on the worker without corruption", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1", "concurrent content");
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { allowedRepoIds: ["repo-x"] });
  await pair(a, b);
  const t = target(b);

  const [s1, s2] = await Promise.all([
    a.client.syncWorkspace(t, { repoPath: src.repoPath, repoId: "repo-x" }),
    a.client.syncWorkspace(t, { repoPath: src.repoPath, repoId: "repo-x" }),
  ]);
  expect(s1.headCommit).toBe(c1);
  expect(s2.headCommit).toBe(c1);

  // The repo is intact and a job reads the right content.
  const result = await runJobAndGetResult(a, t, readFileJob("repo-x", c1));
  expect(result.status).toBe("succeeded");
  expect(result.output?.stdout).toBe("concurrent content");
}, 45_000);
