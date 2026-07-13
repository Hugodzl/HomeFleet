/**
 * Loopback dispatch integration tests (M5): N paired daemon stacks on
 * 127.0.0.1, each with a JobManager wired to real executors. The only fake
 * is MockOpenAiEndpoint (the agent's model server); processes, sockets, TLS,
 * and the SSE stream are all real.
 */
import { existsSync } from "node:fs";
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
  type JobEvent,
  JobEventSchema,
  type JobParams,
  JobResultSchema,
  JobSnapshotSchema,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { resolveDataDir } from "../config/paths.js";
import { type Identity, loadOrCreateIdentity } from "../identity/identity.js";
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
  HfpTimeoutError,
} from "../transport/client.js";
import { NodeServer } from "../transport/server.js";
import { TrustStore } from "../trust/trust-store.js";
import { JobManager, type WorkspaceResolver } from "./job-manager.js";
import { registerJobRoutes } from "./routes.js";

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
  nodeInfo: () => ReturnType<typeof makeNodeInfo>;
}

interface DaemonOptions {
  executors?: Executor[];
  resolveWorkspace?: WorkspaceResolver;
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createDaemon(
  name: string,
  options: DaemonOptions = {},
): Promise<Daemon> {
  const tempDir = await makeTempDataDir(`homefleet-dispatch-${name}-`);
  const dataDir = resolveDataDir({ HOMEFLEET_DATA_DIR: tempDir });
  const identity = await loadOrCreateIdentity(dataDir);
  const trustStore = await TrustStore.load(dataDir);
  const nodeInfo = (): ReturnType<typeof makeNodeInfo> =>
    makeNodeInfo(identity.deviceId, name);
  const pairing = new PairingManager({
    trustStore,
    nodeInfoProvider: nodeInfo,
  });

  const workspaceDir = await makeTempDataDir(`homefleet-ws-${name}-`);
  const resolveWorkspace: WorkspaceResolver =
    options.resolveWorkspace ??
    (async () => ({ dir: workspaceDir, release: async () => {} }));

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

function targetOf(b: Daemon): HfpTarget {
  return { host: HOST, port: b.port, expectedDeviceId: b.identity.deviceId };
}

function commandParams(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): JobParams {
  return { type: "command", workspace: WORKSPACE, command, args, timeoutMs };
}

function nodeAllowlist(): CommandExecutor {
  return new CommandExecutor({
    allowlist: { node: { executable: process.execPath } },
  });
}

/** Drains a job's event stream to completion (ends after the terminal result). */
async function collectStream(
  client: HfpClient,
  target: HfpTarget,
  jobId: string,
  options: { fromSeq?: number } = {},
): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for await (const event of client.streamJobEvents(target, jobId, options)) {
    events.push(event);
  }
  return events;
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

test("command job end-to-end: delegate, stream to a succeeded result, snapshot", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "process.stdout.write('hello world')"]),
  );
  expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

  const events = await collectStream(a.client, target, jobId);

  // Every event validates against the wire schema (superRefines included).
  for (const event of events) {
    JobEventSchema.parse(event);
  }
  // Ordered, gap-free seqs starting at 0; running first, result last.
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  expect(events[0]).toMatchObject({ type: "status", status: "running" });
  const last = events.at(-1);
  expect(last?.type).toBe("result");
  if (last?.type !== "result") {
    throw new Error("expected a terminal result event");
  }
  const result = JobResultSchema.parse(last.result);
  expect(result.status).toBe("succeeded");
  expect(result.type).toBe("command");
  expect(result.output?.stdout).toBe("hello world");
  expect(result.output?.exitCode).toBe(0);
  expect(result.error).toBeUndefined();

  // Snapshot after completion agrees with the streamed result.
  const snapshot = JobSnapshotSchema.parse(
    await a.client.jobSnapshot(target, jobId),
  );
  expect(snapshot.status).toBe("succeeded");
  expect(snapshot.result).toEqual(result);
});

test("command job with a nonzero exit is a failed result carrying the output", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", [
      "-e",
      "process.stderr.write('boom');process.exit(3)",
    ]),
  );
  const events = await collectStream(a.client, target, jobId);
  const last = events.at(-1);
  if (last?.type !== "result") {
    throw new Error("expected a terminal result event");
  }
  const result = JobResultSchema.parse(last.result);
  expect(result.status).toBe("failed");
  expect(result.output?.stderr).toBe("boom");
  expect(result.output?.exitCode).toBe(3);
  expect(result.error).toBeDefined();
  expect(result.error?.details).toMatchObject({ exitCode: 3 });
});

test("agent recon job end-to-end: tool_call/tool_result/result events in order", async () => {
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

  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", {
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
  await writeFile(path.join(b.workspaceDir, "README.md"), "# hello\n");
  await pairAToB(a, b);
  const target = targetOf(b);

  const { jobId } = await a.client.delegate(target, {
    type: "recon",
    workspace: WORKSPACE,
    prompt: "Summarize the repo.",
    budgets: { maxToolCalls: 5, maxWallMs: 30_000 },
  });

  const events = await collectStream(a.client, target, jobId);
  const types = events.map((e) => e.type);
  expect(types).toEqual([
    "status", // running
    "tool_call",
    "tool_result",
    "status", // succeeded
    "result",
  ]);
  expect(types.indexOf("tool_call")).toBeLessThan(types.indexOf("tool_result"));

  const toolCall = events.find((e) => e.type === "tool_call");
  expect(toolCall).toMatchObject({ type: "tool_call", name: "list_dir" });

  const last = events.at(-1);
  if (last?.type !== "result") {
    throw new Error("expected a terminal result event");
  }
  const result = JobResultSchema.parse(last.result);
  expect(result.status).toBe("succeeded");
  expect(result.type).toBe("recon");
  expect(result.summary).toBe("The workspace contains a README.");
});

test("cancellation mid-flight: the stream ends with a canceled result and the process is killed", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  // Writes a marker (proving it spawned) then sleeps well past the test.
  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", [
      "-e",
      "require('fs').writeFileSync('started.marker','x');setTimeout(()=>{},30000)",
    ]),
  );

  const collected = collectStream(a.client, target, jobId);

  // The process actually started (so the kill has a live process to reap).
  const markerPath = path.join(b.workspaceDir, "started.marker");
  await waitUntil(() => existsSync(markerPath));

  const cancelResponse = await a.client.cancelJob(target, jobId);
  expect(cancelResponse.status).toBe("canceled");

  const events = await collected;
  const last = events.at(-1);
  if (last?.type !== "result") {
    throw new Error("expected a terminal result event");
  }
  const result = JobResultSchema.parse(last.result);
  expect(result.status).toBe("canceled");
  expect(result.error?.code).toBe("CANCELED");
  // exitCode null is only produced by safeSpawn's kill path: the process was
  // terminated by us, not left to exit on its own.
  expect(result.output?.exitCode).toBeNull();
}, 20_000);

test("concurrency and queue: one running, one queued, third rejected with BUSY", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", {
    executors: [nodeAllowlist()],
    maxConcurrentJobs: 1,
    maxQueuedJobs: 1,
  });
  await pairAToB(a, b);
  const target = targetOf(b);

  const sleep = commandParams("node", ["-e", "setTimeout(()=>{},30000)"]);
  const first = await a.client.delegate(target, sleep);
  const second = await a.client.delegate(target, sleep);

  // The first occupies the single slot; the second waits in the queue.
  expect((await a.client.jobSnapshot(target, first.jobId)).status).toBe(
    "running",
  );
  expect((await a.client.jobSnapshot(target, second.jobId)).status).toBe(
    "queued",
  );

  // Slot busy and queue full: the third is rejected, state never grows.
  const error = await a.client.delegate(target, sleep).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HfpRequestError);
  expect((error as HfpRequestError).status).toBe(503);
  expect((error as HfpRequestError).hfpError?.code).toBe("BUSY");
}, 20_000);

test("an unpaired peer delegating is rejected at the chokepoint with 401", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  // No pairing: B does not trust A.

  const error = await a.client
    .delegate(targetOf(b), commandParams("node", ["-e", "0"]))
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
  expect(error).toBeInstanceOf(HfpRequestError);
  expect((error as HfpRequestError).status).toBe(401);
  expect((error as HfpRequestError).hfpError?.code).toBe("UNAUTHORIZED");
});

test("another paired peer cannot see, cancel, or stream a job it did not submit", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  const c = await createDaemon("charlie");
  await pairAToB(a, b);
  await pairAToB(c, b);
  const target = targetOf(b);

  // A delegates a long job to B; C is a different paired peer of B.
  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "setTimeout(()=>{},30000)"]),
  );

  const expectUnknownJob = (thrown: unknown): void => {
    expect(thrown).toBeInstanceOf(HfpRequestError);
    expect((thrown as HfpRequestError).status).toBe(404);
    expect((thrown as HfpRequestError).hfpError?.code).toBe("UNKNOWN_JOB");
  };

  expectUnknownJob(
    await c.client.jobSnapshot(target, jobId).then(
      () => null,
      (e) => e,
    ),
  );
  expectUnknownJob(
    await c.client.cancelJob(target, jobId).then(
      () => null,
      (e) => e,
    ),
  );
  expectUnknownJob(
    await collectStream(c.client, target, jobId).then(
      () => null,
      (e) => e,
    ),
  );

  // The rightful owner still sees it (existence did not leak, but is intact).
  expect((await a.client.jobSnapshot(target, jobId)).status).toBe("running");
}, 20_000);

test("SSE Last-Event-ID resume replays only events from the requested seq", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "process.stdout.write('ok')"]),
  );

  const full = await collectStream(a.client, target, jobId);
  expect(full.length).toBeGreaterThanOrEqual(3); // running, terminal status, result

  const fromSeq = 1;
  const resumed = await collectStream(a.client, target, jobId, { fromSeq });
  expect(resumed.map((e) => e.seq)).toEqual(
    full.filter((e) => e.seq >= fromSeq).map((e) => e.seq),
  );
  expect(resumed[0]?.seq).toBe(fromSeq);
});

test("a client disconnecting mid-stream frees the server-side subscription", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "setTimeout(()=>{},30000)"]),
  );

  // Consume the first (running) event, then break — the socket is destroyed.
  for await (const event of a.client.streamJobEvents(target, jobId)) {
    expect(event.type).toBe("status");
    break;
  }

  // The server notices the disconnect and drops the subscription. The count
  // is owner-checked, so A queries with its own device id.
  const owner = a.identity.deviceId;
  await waitUntil(() => b.jobManager.subscriberCount(jobId, owner) === 0);
  expect(b.jobManager.subscriberCount(jobId, owner)).toBe(0);
}, 20_000);

test("a silent stream trips the client idle timeout instead of hanging", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  // A long, silent job: after the initial running event nothing is sent, and
  // the server heartbeat is far off. A short injected idle timeout must trip
  // (throw HfpTimeoutError) rather than block the iterator on a half-open
  // socket forever.
  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "setTimeout(()=>{},30000)"]),
  );

  const seen: JobEvent[] = [];
  const thrown = await (async () => {
    try {
      for await (const event of a.client.streamJobEvents(target, jobId, {
        idleTimeoutMs: 250,
      })) {
        seen.push(event);
      }
      return null;
    } catch (error) {
      return error;
    }
  })();

  expect(thrown).toBeInstanceOf(HfpTimeoutError);
  // The running event arrived before the silence that tripped the timeout.
  expect(seen[0]?.type).toBe("status");
}, 20_000);

test("an unavailable workspace yields a terminal failed result (WORKSPACE_UNAVAILABLE)", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", {
    executors: [nodeAllowlist()],
    resolveWorkspace: async () => {
      throw new Error("repo not on allowlist");
    },
  });
  await pairAToB(a, b);
  const target = targetOf(b);

  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "0"]),
  );
  const events = await collectStream(a.client, target, jobId);
  // running was emitted before the workspace failure (never queued -> failed).
  expect(events[0]).toMatchObject({ type: "status", status: "running" });
  const last = events.at(-1);
  if (last?.type !== "result") {
    throw new Error("expected a terminal result event");
  }
  const result = JobResultSchema.parse(last.result);
  expect(result.status).toBe("failed");
  expect(result.error?.code).toBe("WORKSPACE_UNAVAILABLE");
});

test("delegating a job type the worker has no executor for is rejected with UNSUPPORTED_JOB_TYPE", async () => {
  const a = await createDaemon("alpha");
  // B offers only the command executor, not the agent (recon) executor.
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const error = await a.client
    .delegate(target, {
      type: "recon",
      workspace: WORKSPACE,
      prompt: "anything",
      budgets: { maxToolCalls: 5, maxWallMs: 30_000 },
    })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
  expect(error).toBeInstanceOf(HfpRequestError);
  expect((error as HfpRequestError).status).toBe(400);
  expect((error as HfpRequestError).hfpError?.code).toBe(
    "UNSUPPORTED_JOB_TYPE",
  );
});
