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
  MockOpenAiEndpoint,
  type MockScriptEntry,
} from "@homefleet/executors";
import {
  JobResultSchema,
  JobStatusSchema,
  type NodeInfo,
} from "@homefleet/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { resolveDataDir } from "../config/paths.js";
import { type Identity, loadOrCreateIdentity } from "../identity/identity.js";
import { JobManager, type WorkspaceResolver } from "../jobs/job-manager.js";
import { registerJobRoutes } from "../jobs/routes.js";
import { PairingManager } from "../pairing/pairing.js";
import {
  makeNodeInfo,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import { HfpClient } from "../transport/client.js";
import { NodeServer } from "../transport/server.js";
import { TrustStore } from "../trust/trust-store.js";
import { DelegationRegistry } from "./delegation-registry.js";
import { NodeDirectory, type NodeEndpoint } from "./node-directory.js";
import { createMcpServer } from "./server.js";
import {
  DelegateTaskOutputSchema,
  JobResultOutputSchema,
  JobStatusOutputSchema,
  ListNodesOutputSchema,
} from "./tools.js";

const HOST = "127.0.0.1";
const WORKSPACE = { repoId: "test-repo", headCommit: "a".repeat(40) };

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
    options.resolveWorkspace ?? (async () => workspaceDir);

  const jobManager = new JobManager({
    executors: options.executors ?? [],
    resolveWorkspace,
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
  registerJobRoutes(server, jobManager);
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

/** Wires an MCP server for `agent`, connects a Client over a linked transport. */
async function connectAgent(
  agent: Daemon,
  endpoints: Map<string, NodeEndpoint>,
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
    hfpClient: agent.client,
    nodeDirectory,
    delegations,
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
    executors: [
      new AgentExecutor({
        endpoint: {
          baseUrl: mock.baseUrl,
          model: "test-model",
          contextWindow: 32_768,
        },
      }),
    ],
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
