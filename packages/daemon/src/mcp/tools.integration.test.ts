/**
 * MCP tool tests: the tools are driven through a real MCP `Client` over an
 * in-memory linked transport, against REAL worker daemons on 127.0.0.1 (the M5
 * loopback harness). The only fake is the node directory's endpoint source (we
 * inject deviceId -> host/port instead of running discovery) and, for recon,
 * MockOpenAiEndpoint. Everything else — mTLS, HFP, JobManager, executors — is
 * real.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentExecutor,
  CommandExecutor,
  type Executor,
  type FinalizeWriteFn,
  MockOpenAiEndpoint,
  type MockScriptEntry,
  WriteExecutor,
} from "@homefleet/executors";
import {
  type JobParams,
  JobResultSchema,
  JobStatusSchema,
  type NodeInfo,
  type WriteArtifact,
  writeBranchName,
} from "@homefleet/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { resolveDataDir } from "../config/paths.js";
import { type Identity, loadOrCreateIdentity } from "../identity/identity.js";
import { JobManager, type WorkspaceResolver } from "../jobs/job-manager.js";
import { registerJobRoutes } from "../jobs/routes.js";
import type { ModelResolver } from "../node/catalog.js";
import { PairingManager } from "../pairing/pairing.js";
import {
  makeNodeInfo,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import {
  HfpClient,
  HfpRequestError,
  type HfpTarget,
} from "../transport/client.js";
import { NodeServer } from "../transport/server.js";
import { TrustStore } from "../trust/trust-store.js";
import { GitError } from "../workspace/git.js";
import type { ApplyDelegatedArtifactFn } from "./artifact-applier.js";
import { DelegationRegistry } from "./delegation-registry.js";
import { NodeDirectory, type NodeEndpoint } from "./node-directory.js";
import { createMcpServer } from "./server.js";
import {
  DelegateTaskOutputSchema,
  type DelegationClient,
  JobResultOutputSchema,
  JobStatusOutputSchema,
  ListNodesOutputSchema,
  type RepoResolver,
  type WorkspaceSyncClient,
} from "./tools.js";

const HOST = "127.0.0.1";
/** repoId-only: the daemon derives headCommit by syncing (never the agent). */
const WORKSPACE = { repoId: "test-repo" };
/** The default fake sync client's headCommit, for tests that don't care. */
const FAKE_SYNCED_HEAD_COMMIT = "a".repeat(40);
/** The default fake repo resolver's mapping, for tests that don't care. */
const FAKE_REPO_PATH = "/fake/repos/test-repo";

/** A workspaceSync fake that never touches git or the network. */
function fakeWorkspaceSync(
  headCommit: string = FAKE_SYNCED_HEAD_COMMIT,
): WorkspaceSyncClient {
  return {
    syncWorkspace: async () => ({ headCommit }),
  };
}

/** A repoResolver fake mapping `WORKSPACE.repoId` to a fixed local path. */
function fakeRepoResolver(
  mapping: Record<string, string> = { "test-repo": FAKE_REPO_PATH },
): RepoResolver {
  return {
    resolveRepoPath: (repoId) => mapping[repoId],
  };
}

interface Daemon {
  name: string;
  identity: Identity;
  trustStore: TrustStore;
  pairing: PairingManager;
  server: NodeServer;
  client: HfpClient;
  jobManager: JobManager;
  workspaceDir: string;
  port: number;
  nodeInfo: () => NodeInfo;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface DaemonOptions {
  executors?: Executor[];
  resolveWorkspace?: WorkspaceResolver;
  /** Defaults to a permissive resolver (`{ ok: true }`, no endpoint). */
  resolveModel?: ModelResolver;
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
}

async function createDaemon(
  name: string,
  options: DaemonOptions = {},
): Promise<Daemon> {
  const tempDir = await makeTempDataDir(`homefleet-mcp-${name}-`);
  const dataDir = resolveDataDir({ HOMEFLEET_DATA_DIR: tempDir });
  const identity = await loadOrCreateIdentity(dataDir);
  const trustStore = await TrustStore.load(dataDir);
  const nodeInfo = (): NodeInfo => makeNodeInfo(identity.deviceId, name);
  const pairing = new PairingManager({
    trustStore,
    nodeInfoProvider: nodeInfo,
  });

  const workspaceDir = await makeTempDataDir(`homefleet-mcpws-${name}-`);
  const resolveWorkspace: WorkspaceResolver =
    options.resolveWorkspace ??
    (async () => ({ dir: workspaceDir, release: async () => {} }));

  const jobManager = new JobManager({
    executors: options.executors ?? [],
    resolveWorkspace,
    resolveModel: options.resolveModel ?? (() => ({ ok: true })),
    ...(options.maxConcurrentJobs !== undefined
      ? { maxConcurrentJobs: options.maxConcurrentJobs }
      : {}),
    ...(options.maxQueuedJobs !== undefined
      ? { maxQueuedJobs: options.maxQueuedJobs }
      : {}),
  });

  const server = new NodeServer({
    identity,
    trustStore,
    nodeInfoProvider: nodeInfo,
    pairingManager: pairing,
    host: HOST,
    port: 0,
  });
  // No artifact store: this suite never downloads write-job artifacts.
  registerJobRoutes(server, jobManager, undefined);
  const { port } = await server.start();

  cleanups.push(async () => {
    await jobManager.stop();
    await server.stop();
    await removeTempDataDir(workspaceDir);
    await removeTempDataDir(tempDir);
  });

  return {
    name,
    identity,
    trustStore,
    pairing,
    server,
    client: new HfpClient(identity),
    jobManager,
    workspaceDir,
    port,
    nodeInfo,
  };
}

/** Pairs `a` -> `b`: afterwards `b` trusts `a` and `a` trusts (pins) `b`. */
async function pairAToB(a: Daemon, b: Daemon): Promise<void> {
  const { code } = b.pairing.beginPairing();
  const { response, serverDeviceId } = await a.client.pair(
    { host: HOST, port: b.port },
    code,
    a.nodeInfo(),
  );
  expect(response.accepted).toBe(true);
  await a.trustStore.add({
    deviceId: serverDeviceId,
    name: response.nodeInfo?.name ?? b.name,
    addedAt: new Date().toISOString(),
  });
}

interface ConnectAgentOverrides {
  /** Overrides the MCP server's DelegationClient (default: `agent.client`). */
  hfpClient?: DelegationClient;
  /** Overrides the workspace-sync fake (default: always succeeds). */
  workspaceSync?: WorkspaceSyncClient;
  /** Overrides the repo-resolver fake (default: maps `WORKSPACE.repoId`). */
  repoResolver?: RepoResolver;
  /** Overrides the artifact applier (default: fails loudly if ever called). */
  applyArtifact?: ApplyDelegatedArtifactFn;
}

/** Wires an MCP server for `agent`, connects a Client over a linked transport. */
async function connectAgent(
  agent: Daemon,
  endpoints: Map<string, NodeEndpoint>,
  overrides: ConnectAgentOverrides = {},
): Promise<{ client: Client; delegations: DelegationRegistry }> {
  const nodeDirectory = new NodeDirectory({
    trustStore: agent.trustStore,
    source: { endpointFor: (id) => endpoints.get(id) },
    hfpClient: agent.client,
    ourNodeInfo: agent.nodeInfo,
    helloTimeoutMs: 3000,
  });
  const delegations = new DelegationRegistry();
  const mcp = createMcpServer({
    hfpClient: overrides.hfpClient ?? agent.client,
    workspaceSync: overrides.workspaceSync ?? fakeWorkspaceSync(),
    repoResolver: overrides.repoResolver ?? fakeRepoResolver(),
    nodeDirectory,
    delegations,
    applyArtifact:
      overrides.applyArtifact ??
      (async () => {
        throw new Error("applyArtifact should not be called in this test");
      }),
    requestTimeoutMs: 8000,
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(async () => {
    await client.close();
    await mcp.close();
  });
  return { client, delegations };
}

function endpointOf(d: Daemon): NodeEndpoint {
  return { host: HOST, port: d.port };
}

function nodeAllowlist(): CommandExecutor {
  return new CommandExecutor({
    allowlist: { node: { executable: process.execPath } },
  });
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitUntil timed out");
}

test("list_nodes: reachable node shows live nodeInfo; undiscovered and unreachable are reachable:false", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  // `stranger` is a real, running daemon that the agent trusts but which does
  // NOT trust the agent back — its hello returns 401, modelling an unreachable
  // (from our side) node without any timing flakiness.
  const stranger = await createDaemon("stranger");
  await pairAToB(agent, worker);

  // Agent trusts `stranger` (one-way) and an asleep, never-discovered node.
  await agent.trustStore.add({
    deviceId: stranger.identity.deviceId,
    name: "stranger",
    addedAt: new Date().toISOString(),
  });
  const asleepId = "e".repeat(64);
  await agent.trustStore.add({
    deviceId: asleepId,
    name: "asleep",
    addedAt: new Date().toISOString(),
  });

  const endpoints = new Map<string, NodeEndpoint>([
    [worker.identity.deviceId, endpointOf(worker)],
    [stranger.identity.deviceId, endpointOf(stranger)],
    // `asleep` has no endpoint (never discovered).
  ]);
  const { client } = await connectAgent(agent, endpoints);

  const result = await call(client, "list_nodes", {});
  expect(result.isError).toBeFalsy();
  const { nodes } = ListNodesOutputSchema.parse(result.structuredContent);
  expect(nodes).toHaveLength(3);

  const reachable = nodes.find((n) => n.deviceId === worker.identity.deviceId);
  expect(reachable?.reachable).toBe(true);
  expect(reachable?.executors).toContain("command");
  expect(reachable?.roles).toContain("execution");
  expect(reachable?.maxConcurrentJobs).toBeGreaterThanOrEqual(1);

  const asleep = nodes.find((n) => n.deviceId === asleepId);
  expect(asleep?.reachable).toBe(false);
  expect(asleep?.executors).toBeUndefined();

  const strangerNode = nodes.find(
    (n) => n.deviceId === stranger.identity.deviceId,
  );
  // A down/erroring node still appears (the listing did not fail) but has no caps.
  expect(strangerNode?.reachable).toBe(false);
  expect(strangerNode?.executors).toBeUndefined();

  // reachableOnly filter drops the two unreachable nodes.
  const filtered = await call(client, "list_nodes", { reachableOnly: true });
  const only = ListNodesOutputSchema.parse(filtered.structuredContent);
  expect(only.nodes).toHaveLength(1);
  expect(only.nodes[0]?.deviceId).toBe(worker.identity.deviceId);
});

test("delegate_task (command) end-to-end: jobId, then job_status and job_result", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { client, delegations } = await connectAgent(agent, endpoints);

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "process.stdout.write('hello mcp')"],
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId, node } = DelegateTaskOutputSchema.parse(
    delegated.structuredContent,
  );
  expect(node).toBe(worker.identity.deviceId);
  expect(delegations.lookup(jobId)).toBeDefined();

  // job_status returns a valid protocol status.
  const status = await call(client, "job_status", { jobId });
  const parsedStatus = JobStatusOutputSchema.parse(status.structuredContent);
  expect(JobStatusSchema.options).toContain(parsedStatus.status);

  // Poll job_result until the job is terminal.
  let resultStructured: unknown;
  await waitUntil(async () => {
    const r = await call(client, "job_result", { jobId });
    resultStructured = r.structuredContent;
    const parsed = JobResultOutputSchema.parse(r.structuredContent);
    return parsed.result !== null;
  });
  const finished = JobResultOutputSchema.parse(resultStructured);
  expect(finished.status).toBe("succeeded");
  // result IS the protocol JobResult — assert against the protocol schema.
  const jobResult = JobResultSchema.parse(finished.result);
  expect(jobResult.type).toBe("command");
  expect(jobResult.output?.stdout).toBe("hello mcp");
  expect(jobResult.output?.exitCode).toBe(0);
  // Non-write jobs carry NO artifact surface.
  expect(finished.artifactStatus).toBeUndefined();
  expect(finished.reviewCommand).toBeUndefined();
});

test("delegate_task (recon) end-to-end via the mock model endpoint", async () => {
  const script: MockScriptEntry[] = [
    {
      kind: "tool_calls",
      toolCalls: [{ name: "list_dir", arguments: { path: "." } }],
      usage: { promptTokens: 12, completionTokens: 4 },
    },
    {
      kind: "content",
      content: "The workspace contains a README.",
      usage: { promptTokens: 20, completionTokens: 9 },
    },
  ];
  const mock = await MockOpenAiEndpoint.start(script);
  cleanups.push(() => mock.close());

  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", {
    executors: [new AgentExecutor({})],
    resolveModel: () => ({
      ok: true,
      endpoint: {
        baseUrl: mock.baseUrl,
        model: "test-model",
        contextWindow: 32_768,
      },
    }),
  });
  await writeFile(path.join(worker.workspaceDir, "README.md"), "# hello\n");
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { client } = await connectAgent(agent, endpoints);

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "recon",
      workspace: WORKSPACE,
      prompt: "Summarize the repo.",
      maxToolCalls: 5,
      maxWallMs: 30_000,
    },
  });
  const { jobId } = DelegateTaskOutputSchema.parse(delegated.structuredContent);

  let structured: unknown;
  await waitUntil(async () => {
    const r = await call(client, "job_result", { jobId });
    structured = r.structuredContent;
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  });
  const jobResult = JobResultSchema.parse(
    JobResultOutputSchema.parse(structured).result,
  );
  expect(jobResult.status).toBe("succeeded");
  expect(jobResult.type).toBe("recon");
  expect(jobResult.summary).toBe("The workspace contains a README.");
});

test("delegate_task to an unknown/unpaired node is a clean error and records nothing", async () => {
  const agent = await createDaemon("agent");
  const { client, delegations } = await connectAgent(agent, new Map());

  const result = await call(client, "delegate_task", {
    node: "f".repeat(64),
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toMatch(/unpaired|Unknown/i);
  // No delegation was recorded — the tool never called out.
  expect(delegations.size).toBe(0);
});

test("delegate_task to a paired-but-undiscovered node errors before syncing (undiscovered check precedes the sync)", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  // Pair so the worker is TRUSTED, but give the directory NO endpoint for it:
  // resolve() then returns a node with undefined host/port (never discovered).
  await pairAToB(agent, worker);

  let syncCalled = false;
  const workspaceSync: WorkspaceSyncClient = {
    syncWorkspace: async () => {
      syncCalled = true;
      return { headCommit: FAKE_SYNCED_HEAD_COMMIT };
    },
  };
  const { client, delegations } = await connectAgent(agent, new Map(), {
    workspaceSync,
  });

  const result = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toMatch(/not been discovered/i);
  // The undiscovered guard runs BEFORE the sync: nothing was synced or recorded.
  expect(syncCalled).toBe(false);
  expect(delegations.size).toBe(0);
});

test("job_status / job_result / cancel_job for an unknown jobId are clean errors", async () => {
  const agent = await createDaemon("agent");
  const { client } = await connectAgent(agent, new Map());
  const jobId = randomUUID();

  for (const name of ["job_status", "job_result", "cancel_job"]) {
    const result = await call(client, name, { jobId });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Unknown job/i,
    );
  }
});

test("cancel_job cancels a running job", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { client } = await connectAgent(agent, endpoints);

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "setTimeout(()=>{},30000)"],
    },
  });
  const { jobId } = DelegateTaskOutputSchema.parse(delegated.structuredContent);

  // Wait until it is actually running before cancelling.
  await waitUntil(async () => {
    const s = await call(client, "job_status", { jobId });
    return (
      JobStatusOutputSchema.parse(s.structuredContent).status === "running"
    );
  });

  const canceled = await call(client, "cancel_job", { jobId });
  expect(canceled.isError).toBeFalsy();
  expect(JobStatusOutputSchema.parse(canceled.structuredContent).status).toBe(
    "canceled",
  );

  const finished = await call(client, "job_result", { jobId });
  const jobResult = JobResultSchema.parse(
    JobResultOutputSchema.parse(finished.structuredContent).result,
  );
  expect(jobResult.status).toBe("canceled");
  expect(jobResult.error?.code).toBe("CANCELED");
}, 20_000);

test("HFP BUSY maps to an informative tool error (not a raw stack)", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", {
    executors: [nodeAllowlist()],
    maxConcurrentJobs: 1,
    maxQueuedJobs: 0,
  });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { client } = await connectAgent(agent, endpoints);

  const sleep = {
    type: "command",
    workspace: WORKSPACE,
    command: "node",
    args: ["-e", "setTimeout(()=>{},30000)"],
  };
  // First fills the only slot.
  const first = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: sleep,
  });
  const firstJob = DelegateTaskOutputSchema.parse(
    first.structuredContent,
  ).jobId;

  // Second is rejected BUSY (slot busy, queue size 0).
  const busy = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: sleep,
  });
  expect(busy.isError).toBe(true);
  const text = (busy.content[0] as { text: string }).text;
  expect(text).toMatch(/BUSY|capacity/i);
  expect(text).not.toMatch(/\bat .*client\.ts:|Error:.*\n\s+at /); // no stack

  await call(client, "cancel_job", { jobId: firstJob });
}, 20_000);

test("delegate_task syncs the workspace before delegating, and delegates with the SYNCED headCommit", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  const syncCalls: Array<{ repoPath: string; repoId: string }> = [];
  const syncedHead = "b".repeat(40);
  const workspaceSync: WorkspaceSyncClient = {
    syncWorkspace: async (_target, repo) => {
      syncCalls.push(repo);
      return { headCommit: syncedHead };
    },
  };
  const delegateCalls: JobParams[] = [];
  const hfpClient: DelegationClient = {
    delegate: async (target, params) => {
      delegateCalls.push(params);
      return agent.client.delegate(target, params);
    },
    jobSnapshot: (target, jobId) => agent.client.jobSnapshot(target, jobId),
    cancelJob: (target, jobId) => agent.client.cancelJob(target, jobId),
  };
  const repoResolver = fakeRepoResolver({ "repo-y": "/configured/repo-y" });

  const { client } = await connectAgent(agent, endpoints, {
    hfpClient,
    workspaceSync,
    repoResolver,
  });

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: { repoId: "repo-y" },
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(delegated.isError).toBeFalsy();

  expect(syncCalls).toEqual([
    { repoPath: "/configured/repo-y", repoId: "repo-y" },
  ]);
  expect(delegateCalls).toHaveLength(1);
  expect(delegateCalls[0]?.workspace).toEqual({
    repoId: "repo-y",
    headCommit: syncedHead,
  });
});

test("delegate_task with a repoId not mapped in this daemon's config is a clean error; nothing is synced or delegated", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  let syncCalled = false;
  const workspaceSync: WorkspaceSyncClient = {
    syncWorkspace: async () => {
      syncCalled = true;
      return { headCommit: FAKE_SYNCED_HEAD_COMMIT };
    },
  };
  const repoResolver: RepoResolver = { resolveRepoPath: () => undefined };
  const { client, delegations } = await connectAgent(agent, endpoints, {
    workspaceSync,
    repoResolver,
  });

  const result = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: { repoId: "unmapped-repo" },
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toMatch(/no local repo mapped/i);
  expect(text).toContain("unmapped-repo");
  expect(syncCalled).toBe(false);
  expect(delegations.size).toBe(0);
});

test("delegate_task: an HFP sync failure (WORKSPACE_UNAVAILABLE) is a clean worker-error message; nothing is delegated", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  const workspaceSync: WorkspaceSyncClient = {
    syncWorkspace: async () => {
      throw new HfpRequestError(
        403,
        { code: "WORKSPACE_UNAVAILABLE", message: "repo not allowlisted" },
        "HFP request failed with status 403",
      );
    },
  };
  let delegateCalled = false;
  const hfpClient: DelegationClient = {
    delegate: async (target, params) => {
      delegateCalled = true;
      return agent.client.delegate(target, params);
    },
    jobSnapshot: (target, jobId) => agent.client.jobSnapshot(target, jobId),
    cancelJob: (target, jobId) => agent.client.cancelJob(target, jobId),
  };
  const { client, delegations } = await connectAgent(agent, endpoints, {
    workspaceSync,
    hfpClient,
  });

  const result = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toMatch(/WORKSPACE_UNAVAILABLE/);
  expect(delegateCalled).toBe(false);
  expect(delegations.size).toBe(0);
});

test("delegate_task: a local GitError during sync is a distinct 'local repo' error, not the generic worker-error phrasing", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  const workspaceSync: WorkspaceSyncClient = {
    syncWorkspace: async () => {
      throw new GitError("could not resolve HEAD of /nowhere: git exited 128");
    },
  };
  let delegateCalled = false;
  const hfpClient: DelegationClient = {
    delegate: async (target, params) => {
      delegateCalled = true;
      return agent.client.delegate(target, params);
    },
    jobSnapshot: (target, jobId) => agent.client.jobSnapshot(target, jobId),
    cancelJob: (target, jobId) => agent.client.cancelJob(target, jobId),
  };
  const repoResolver = fakeRepoResolver({ "test-repo": "/nowhere" });
  const { client, delegations } = await connectAgent(agent, endpoints, {
    workspaceSync,
    hfpClient,
    repoResolver,
  });

  const result = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toMatch(/Could not read or bundle the local repo/i);
  expect(text).toContain("/nowhere");
  expect(text).toContain("test-repo");
  expect(delegateCalled).toBe(false);
  expect(delegations.size).toBe(0);
});

test("delegate_task: a RAW (non-Git, non-HFP) local error during sync yields a neutral local message, not 'against the worker'", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  const workspaceSync: WorkspaceSyncClient = {
    syncWorkspace: async () => {
      // Models a raw fs fault (e.g. createReadStream EBUSY on the bundle, or
      // an ENOSPC from the temp-dir ops) — NOT a GitError, NOT an HFP error.
      const error = new Error("EBUSY: resource busy or locked") as Error & {
        code: string;
      };
      error.code = "EBUSY";
      throw error;
    },
  };
  let delegateCalled = false;
  const hfpClient: DelegationClient = {
    delegate: async (target, params) => {
      delegateCalled = true;
      return agent.client.delegate(target, params);
    },
    jobSnapshot: (target, jobId) => agent.client.jobSnapshot(target, jobId),
    cancelJob: (target, jobId) => agent.client.cancelJob(target, jobId),
  };
  const repoResolver = fakeRepoResolver({ "test-repo": "/local/src" });
  const { client, delegations } = await connectAgent(agent, endpoints, {
    workspaceSync,
    hfpClient,
    repoResolver,
  });

  const result = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "0"],
    },
  });
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  // Neutral local phrasing that does NOT blame the worker.
  expect(text).toMatch(/Could not sync the local repo/i);
  expect(text).toContain("/local/src");
  expect(text).toContain("test-repo");
  expect(text).toContain("EBUSY");
  expect(text).not.toMatch(/against the worker/i);
  expect(delegateCalled).toBe(false);
  expect(delegations.size).toBe(0);
});

// --- Write delegation: the v0.2 MCP surface (Task 11) ---------------------

/** A worker daemon whose WriteExecutor runs the scripted mock model. */
async function createWriteWorker(
  finalize: FinalizeWriteFn,
  script?: MockScriptEntry[],
): Promise<Daemon> {
  const mock = await MockOpenAiEndpoint.start(
    script ?? [
      {
        kind: "tool_calls",
        toolCalls: [
          {
            name: "finish_task",
            arguments: {
              summary: "changed one file",
              commitMessage: "test: one change",
            },
          },
        ],
      },
    ],
  );
  cleanups.push(() => mock.close());
  return createDaemon("write-worker", {
    executors: [new WriteExecutor({ finalize })],
    resolveModel: () => ({
      ok: true,
      endpoint: {
        baseUrl: mock.baseUrl,
        model: "test-model",
        contextWindow: 32_768,
      },
    }),
  });
}

/** A finalize stub minting a schema-valid artifact for the job. */
function fakeFinalize(): FinalizeWriteFn {
  return async ({ jobId, commitMessage }) => ({
    branchName: writeBranchName(jobId),
    baseCommit: FAKE_SYNCED_HEAD_COMMIT,
    headCommit: "c".repeat(40),
    diffStat: { filesChanged: 1, insertions: 2, deletions: 0 },
    commitMessage,
  });
}

/** Records applyArtifact calls; `failFirst` rejects only the first call. */
function recordingApplier(options: { failFirst?: string } = {}): {
  applyArtifact: ApplyDelegatedArtifactFn;
  calls: Array<{ jobId: string; artifact: WriteArtifact; repoPath: string }>;
} {
  const calls: Array<{
    jobId: string;
    artifact: WriteArtifact;
    repoPath: string;
  }> = [];
  let failNext = options.failFirst;
  return {
    calls,
    applyArtifact: async ({ jobId, artifact, repoPath }) => {
      calls.push({ jobId, artifact, repoPath });
      if (failNext !== undefined) {
        const message = failNext;
        failNext = undefined;
        throw new Error(message);
      }
      return { branchName: artifact.branchName };
    },
  };
}

/** Delegates a write task and polls job_result to the terminal structured output. */
async function runWriteJob(
  client: Client,
  workerDeviceId: string,
): Promise<{ jobId: string; structured: unknown }> {
  const delegated = await call(client, "delegate_task", {
    node: workerDeviceId,
    task: {
      type: "write",
      workspace: WORKSPACE,
      instructions: "Apply the requested change.",
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = DelegateTaskOutputSchema.parse(delegated.structuredContent);
  let structured: unknown;
  await waitUntil(async () => {
    const r = await call(client, "job_result", { jobId });
    structured = r.structuredContent;
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  });
  return { jobId, structured };
}

test("delegate_task (write) passes pathHints and verifyCommand through UNTOUCHED and flattens budgets", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker");
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  const delegateCalls: JobParams[] = [];
  const hfpClient: DelegationClient = {
    delegate: async (_target, params) => {
      delegateCalls.push(params);
      // Never reaches the real worker: the pass-through is the assertion.
      return { jobId: randomUUID() };
    },
    jobSnapshot: (target, jobId) => agent.client.jobSnapshot(target, jobId),
    cancelJob: (target, jobId) => agent.client.cancelJob(target, jobId),
  };
  const { client } = await connectAgent(agent, endpoints, { hfpClient });

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "write",
      workspace: WORKSPACE,
      instructions: "Rename the config key.",
      pathHints: ["src/config.ts", "docs/reference/configuration.md"],
      verifyCommand: { name: "pnpm", args: ["test", "--filter", "config"] },
      maxToolCalls: 42,
      maxWallMs: 120_000,
    },
  });
  expect(delegated.isError).toBeFalsy();

  expect(delegateCalls).toHaveLength(1);
  const params = delegateCalls[0];
  if (params?.type !== "write") {
    throw new Error("expected write JobParams");
  }
  expect(params.instructions).toBe("Rename the config key.");
  // Pure pass-through: the MCP layer never rewrites task content (the write
  // executor incorporates pathHints into the model prompt worker-side).
  expect(params.pathHints).toEqual([
    "src/config.ts",
    "docs/reference/configuration.md",
  ]);
  expect(params.verifyCommand).toEqual({
    name: "pnpm",
    args: ["test", "--filter", "config"],
  });
  // Flattened budgets land in the protocol budgets object; headCommit is the
  // SYNCED one, never agent-supplied.
  expect(params.budgets).toEqual({ maxToolCalls: 42, maxWallMs: 120_000 });
  expect(params.workspace).toEqual({
    repoId: WORKSPACE.repoId,
    headCommit: FAKE_SYNCED_HEAD_COMMIT,
  });
});

test("job_result on a succeeded write job applies the artifact lazily and does not re-download on a second call", async () => {
  const agent = await createDaemon("agent");
  const worker = await createWriteWorker(fakeFinalize());
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { applyArtifact, calls } = recordingApplier();
  const { client } = await connectAgent(agent, endpoints, { applyArtifact });

  const { jobId, structured } = await runWriteJob(
    client,
    worker.identity.deviceId,
  );
  const finished = JobResultOutputSchema.parse(structured);
  expect(finished.status).toBe("succeeded");
  const jobResult = JobResultSchema.parse(finished.result);
  expect(jobResult.type).toBe("write");
  const artifact = jobResult.artifact;
  if (artifact === null || artifact === undefined) {
    throw new Error("expected a write artifact on the result");
  }
  expect(artifact.branchName).toBe(writeBranchName(jobId));

  // The lazy apply ran against the repo mapped for the job's repoId, with
  // the artifact from the result.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    jobId,
    repoPath: FAKE_REPO_PATH,
  });
  expect(calls[0]?.artifact).toEqual(artifact);
  expect(finished.artifactStatus).toBe("applied");
  expect(finished.reviewCommand).toBe(
    `git diff ${artifact.baseCommit}...${artifact.branchName}`,
  );
  expect(finished.applyError).toBeUndefined();

  // A second job_result call remembers the apply — no re-download, no
  // second apply — and still reports the same surface.
  const again = await call(client, "job_result", { jobId });
  expect(again.isError).toBeFalsy();
  const parsedAgain = JobResultOutputSchema.parse(again.structuredContent);
  expect(calls).toHaveLength(1);
  expect(parsedAgain.artifactStatus).toBe("applied");
  expect(parsedAgain.reviewCommand).toBe(
    `git diff ${artifact.baseCommit}...${artifact.branchName}`,
  );
});

test("a failed apply reports artifactStatus failed with the reason, and the next call retries", async () => {
  const agent = await createDaemon("agent");
  const worker = await createWriteWorker(fakeFinalize());
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { applyArtifact, calls } = recordingApplier({
    failFirst: "NON_FAST_FORWARD: the ref already exists and diverged",
  });
  const { client } = await connectAgent(agent, endpoints, { applyArtifact });

  const { jobId, structured } = await runWriteJob(
    client,
    worker.identity.deviceId,
  );
  const failedApply = JobResultOutputSchema.parse(structured);
  // The JOB result is intact and the tool call is NOT an error — only the
  // apply failed, and the reason is surfaced.
  expect(failedApply.status).toBe("succeeded");
  expect(failedApply.artifactStatus).toBe("failed");
  expect(failedApply.applyError).toContain("NON_FAST_FORWARD");
  expect(failedApply.reviewCommand).toBeUndefined();
  expect(calls).toHaveLength(1);

  // The retry (next job_result call) applies successfully.
  const retried = await call(client, "job_result", { jobId });
  const parsedRetry = JobResultOutputSchema.parse(retried.structuredContent);
  expect(calls).toHaveLength(2);
  expect(parsedRetry.artifactStatus).toBe("applied");
  expect(parsedRetry.reviewCommand).toMatch(/^git diff /);
  expect(parsedRetry.applyError).toBeUndefined();
});

test("two overlapping job_result calls share ONE apply (single-flight) and report identical surfaces", async () => {
  const agent = await createDaemon("agent");
  const worker = await createWriteWorker(fakeFinalize());
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);

  // A GATED applier: the first caller blocks inside the apply until the test
  // releases it, giving the second job_result call time to overlap.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const applied: string[] = [];
  const applyArtifact: ApplyDelegatedArtifactFn = async ({
    jobId,
    artifact,
  }) => {
    applied.push(jobId);
    await gate;
    return { branchName: artifact.branchName };
  };
  const { client } = await connectAgent(agent, endpoints, { applyArtifact });

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "write",
      workspace: WORKSPACE,
      instructions: "Apply the requested change.",
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = DelegateTaskOutputSchema.parse(delegated.structuredContent);

  // Wait for the job to be terminal WITHOUT job_result (each terminal
  // job_result call triggers the gated apply under test), by snapshotting
  // over HFP directly.
  const target: HfpTarget = {
    host: HOST,
    port: worker.port,
    expectedDeviceId: worker.identity.deviceId,
  };
  await waitUntil(
    async () => (await agent.client.jobSnapshot(target, jobId)).result != null,
  );

  const first = call(client, "job_result", { jobId });
  const second = call(client, "job_result", { jobId });
  await waitUntil(() => applied.length >= 1);
  // Let the second handler reach the single-flight gate before opening it.
  // (If it arrives only after the flight settles, the remembered apply
  // answers it — either way the assertions below must hold.)
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  // Exactly one fetch+apply ran, and both callers report the SAME surface —
  // never one "failed" (git ref lock) alongside one "applied".
  expect(applied).toEqual([jobId]);
  const firstParsed = JobResultOutputSchema.parse(
    firstResult.structuredContent,
  );
  const secondParsed = JobResultOutputSchema.parse(
    secondResult.structuredContent,
  );
  expect(firstParsed.artifactStatus).toBe("applied");
  expect(secondParsed.artifactStatus).toBe("applied");
  expect(firstParsed.reviewCommand).toBe(secondParsed.reviewCommand);
  expect(firstParsed.applyError).toBeUndefined();
  expect(secondParsed.applyError).toBeUndefined();
});

test("a write job that changed nothing (artifact null) reports artifactStatus none and never applies", async () => {
  const agent = await createDaemon("agent");
  const worker = await createWriteWorker(async () => null);
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { applyArtifact, calls } = recordingApplier();
  const { client } = await connectAgent(agent, endpoints, { applyArtifact });

  const { structured } = await runWriteJob(client, worker.identity.deviceId);
  const finished = JobResultOutputSchema.parse(structured);
  expect(finished.status).toBe("succeeded");
  expect(JobResultSchema.parse(finished.result).artifact).toBeNull();
  expect(finished.artifactStatus).toBe("none");
  expect(finished.reviewCommand).toBeUndefined();
  expect(calls).toHaveLength(0);
});

test("an apply against a repoId no longer mapped locally reports failed without calling the applier", async () => {
  const agent = await createDaemon("agent");
  const worker = await createWriteWorker(fakeFinalize());
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  const { applyArtifact, calls } = recordingApplier();
  // The mapping exists at delegate time but is gone by job_result time
  // (config edited between the two): the apply must fail closed.
  const mapping: Record<string, string | undefined> = {
    "test-repo": FAKE_REPO_PATH,
  };
  const repoResolver: RepoResolver = {
    resolveRepoPath: (repoId) => mapping[repoId],
  };
  const { client } = await connectAgent(agent, endpoints, {
    applyArtifact,
    repoResolver,
  });

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "write",
      workspace: WORKSPACE,
      instructions: "Apply the requested change.",
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = DelegateTaskOutputSchema.parse(delegated.structuredContent);
  mapping["test-repo"] = undefined;

  let structured: unknown;
  await waitUntil(async () => {
    const r = await call(client, "job_result", { jobId });
    structured = r.structuredContent;
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  });
  const finished = JobResultOutputSchema.parse(structured);
  expect(finished.artifactStatus).toBe("failed");
  expect(finished.applyError).toMatch(/no local repo mapped/i);
  expect(calls).toHaveLength(0);
});
