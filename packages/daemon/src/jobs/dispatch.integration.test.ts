/**
 * Loopback dispatch integration tests (M5): N paired daemon stacks on
 * 127.0.0.1, each with a JobManager wired to real executors. The only fake
 * is MockOpenAiEndpoint (the agent's model server); processes, sockets, TLS,
 * and the SSE stream are all real.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  ArtifactHeadCommitError,
  HfpClient,
  HfpRequestError,
  HfpResponseTooLargeError,
  type HfpTarget,
  HfpTimeoutError,
} from "../transport/client.js";
import { NodeServer } from "../transport/server.js";
import { TrustStore } from "../trust/trust-store.js";
import { ArtifactStore } from "../workspace/artifact-store.js";
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
  artifacts: ArtifactStore;
  workspaceDir: string;
  port: number;
  nodeInfo: () => ReturnType<typeof makeNodeInfo>;
}

interface DaemonOptions {
  executors?: Executor[];
  resolveWorkspace?: WorkspaceResolver;
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
  maxRetainedJobs?: number;
  /** Register the job routes WITHOUT an artifact store (Task 11 not wired). */
  omitArtifactStore?: boolean;
  /** Runs before registerJobRoutes: an earlier route shadows a later one. */
  preRegister?: (server: NodeServer) => void;
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
    ...(options.maxRetainedJobs !== undefined
      ? { maxRetainedJobs: options.maxRetainedJobs }
      : {}),
  });
  const artifacts = new ArtifactStore();

  const server = new NodeServer({
    identity,
    trustStore,
    nodeInfoProvider: nodeInfo,
    pairingManager: pairing,
    host: HOST,
    port: 0,
  });
  options.preRegister?.(server);
  registerJobRoutes(
    server,
    jobManager,
    options.omitArtifactStore ? undefined : artifacts,
  );
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
    artifacts,
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

// --- Artifact download: GET /hfp/v0/jobs/{id}/artifact (v0.2 Task 8) ---

const FAKE_HEAD = "f".repeat(40);

/** Delegates a trivial command job and drains it to a terminal result. */
async function runTerminalJob(a: Daemon, target: HfpTarget): Promise<string> {
  const { jobId } = await a.client.delegate(
    target,
    commandParams("node", ["-e", "0"]),
  );
  await collectStream(a.client, target, jobId);
  return jobId;
}

/** Writes `bytes` as a fake bundle file and registers it for `jobId` on `b`. */
async function registerArtifact(
  b: Daemon,
  jobId: string,
  bytes: Buffer,
): Promise<string> {
  const dir = await makeTempDataDir("homefleet-artifact-");
  cleanups.push(() => removeTempDataDir(dir));
  const bundlePath = path.join(dir, "job.bundle");
  await writeFile(bundlePath, bytes);
  b.artifacts.register(jobId, {
    bundlePath,
    headCommit: FAKE_HEAD,
    byteLength: bytes.length,
  });
  return bundlePath;
}

async function makeDestPath(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-artifact-dest-");
  cleanups.push(() => removeTempDataDir(dir));
  return path.join(dir, "fetched.bundle");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const expectHfpError = (
  thrown: unknown,
  status: number,
  code: string,
): void => {
  expect(thrown).toBeInstanceOf(HfpRequestError);
  expect((thrown as HfpRequestError).status).toBe(status);
  expect((thrown as HfpRequestError).hfpError?.code).toBe(code);
};

test("artifact download round-trips the bundle byte-identically with the head-commit header", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const jobId = await runTerminalJob(a, target);
  const bytes = randomBytes(256 * 1024);
  await registerArtifact(b, jobId, bytes);

  const destPath = await makeDestPath();
  const { headCommit } = await a.client.fetchJobArtifact(
    target,
    jobId,
    destPath,
    { maxBytes: 1024 * 1024 },
  );
  expect(headCommit).toBe(FAKE_HEAD);
  expect(sha256(await readFile(destPath))).toBe(sha256(bytes));
}, 20_000);

test("non-owner, unknown job, and unpaired peers cannot fetch an artifact", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  const c = await createDaemon("charlie");
  const d = await createDaemon("delta"); // never paired with b
  await pairAToB(a, b);
  await pairAToB(c, b);
  const target = targetOf(b);

  const jobId = await runTerminalJob(a, target);
  await registerArtifact(b, jobId, randomBytes(1024));

  // A different paired peer gets the same UNKNOWN_JOB 404 as an absent job:
  // existence never leaks, and the artifact is not served.
  const destPath = await makeDestPath();
  expectHfpError(
    await c.client
      .fetchJobArtifact(target, jobId, destPath, { maxBytes: 1024 * 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    404,
    "UNKNOWN_JOB",
  );
  expectHfpError(
    await a.client
      .fetchJobArtifact(target, "not-a-job-id", destPath, {
        maxBytes: 1024 * 1024,
      })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    404,
    "UNKNOWN_JOB",
  );
  expectHfpError(
    await d.client
      .fetchJobArtifact(target, jobId, destPath, { maxBytes: 1024 * 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    401,
    "UNAUTHORIZED",
  );
  expect(existsSync(destPath)).toBe(false);
}, 20_000);

test("a known job with no artifact entry answers 404 NO_ARTIFACT", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const jobId = await runTerminalJob(a, target);
  const destPath = await makeDestPath();
  expectHfpError(
    await a.client
      .fetchJobArtifact(target, jobId, destPath, { maxBytes: 1024 * 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    404,
    "NO_ARTIFACT",
  );
  expect(existsSync(destPath)).toBe(false);
});

test("an evicted job's artifact is indistinguishable from an unknown job (404 UNKNOWN_JOB)", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", {
    executors: [nodeAllowlist()],
    maxRetainedJobs: 1,
  });
  await pairAToB(a, b);
  const target = targetOf(b);

  const first = await runTerminalJob(a, target);
  await registerArtifact(b, first, randomBytes(1024));
  // A second job pushes the retained-jobs cap: the first record is evicted.
  await runTerminalJob(a, target);

  // The RFC's "410 after eviction" is amended: eviction drops the job record,
  // so the ownership gate answers the same UNKNOWN_JOB 404 as for an absent
  // job — existence-hiding beats status precision.
  const destPath = await makeDestPath();
  expectHfpError(
    await a.client
      .fetchJobArtifact(target, first, destPath, { maxBytes: 1024 * 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    404,
    "UNKNOWN_JOB",
  );
}, 20_000);

test("routes registered without an artifact store always answer NO_ARTIFACT", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", {
    executors: [nodeAllowlist()],
    omitArtifactStore: true,
  });
  await pairAToB(a, b);
  const target = targetOf(b);

  const jobId = await runTerminalJob(a, target);
  const destPath = await makeDestPath();
  expectHfpError(
    await a.client
      .fetchJobArtifact(target, jobId, destPath, { maxBytes: 1024 * 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    404,
    "NO_ARTIFACT",
  );
});

test("a bundle file that vanished after registration yields a clean error, not a wedged daemon", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const jobId = await runTerminalJob(a, target);
  const bundlePath = await registerArtifact(b, jobId, randomBytes(1024));
  // Eviction race: the file is deleted while the registry entry survives.
  await rm(bundlePath, { force: true });

  const destPath = await makeDestPath();
  expectHfpError(
    await a.client
      .fetchJobArtifact(target, jobId, destPath, { maxBytes: 1024 * 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      ),
    404,
    "NO_ARTIFACT",
  );
  expect(existsSync(destPath)).toBe(false);

  // The daemon still serves requests after the failed open.
  expect((await a.client.jobSnapshot(target, jobId)).status).toBe("succeeded");
});

test("a response exceeding maxBytes aborts with a typed error and cleans up the partial file", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo", { executors: [nodeAllowlist()] });
  await pairAToB(a, b);
  const target = targetOf(b);

  const jobId = await runTerminalJob(a, target);
  await registerArtifact(b, jobId, randomBytes(64 * 1024));

  const destPath = await makeDestPath();
  const thrown = await a.client
    .fetchJobArtifact(target, jobId, destPath, { maxBytes: 1000 })
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(thrown).toBeInstanceOf(HfpResponseTooLargeError);
  expect((thrown as HfpResponseTooLargeError).limitBytes).toBe(1000);
  expect(existsSync(destPath)).toBe(false);
}, 20_000);

test("a 200 artifact response without the head-commit header is a typed error", async () => {
  const a = await createDaemon("alpha");
  // A misbehaving worker: its artifact route streams bytes but omits the
  // integrity-anchor header. Registered BEFORE the real routes so it shadows.
  const b = await createDaemon("bravo", {
    executors: [nodeAllowlist()],
    preRegister: (server) => {
      server.routeStream("GET", "/jobs/:id/artifact", {}, ({ res }) => {
        const bytes = randomBytes(2048);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": bytes.length,
        });
        res.end(bytes);
      });
    },
  });
  await pairAToB(a, b);

  const destPath = await makeDestPath();
  const thrown = await a.client
    .fetchJobArtifact(targetOf(b), "any-job-id", destPath, {
      maxBytes: 1024 * 1024,
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(thrown).toBeInstanceOf(ArtifactHeadCommitError);
  expect(existsSync(destPath)).toBe(false);
});
