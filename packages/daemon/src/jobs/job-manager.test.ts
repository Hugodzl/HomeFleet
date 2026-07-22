/**
 * JobManager engine unit tests: fast fake executors, no TLS/HTTP/processes.
 * These lock the trickiest lifecycle paths — retention eviction, the runJob
 * backstop, post-terminal event drops, concurrent cancel, subscriber
 * force-close on stop, and the bounded cancel/stop unwind — that the loopback
 * suite only exercises indirectly.
 */
import type { ExecutionContext, Executor } from "@homefleet/executors";
import type {
  CommandJobParams,
  JobEvent,
  JobId,
  JobParams,
  JobResult,
  ReconJobParams,
  WriteJobParams,
} from "@homefleet/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { JobDispatchError } from "./job.js";
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  JobManager,
  type JobManagerOptions,
  type WorkspaceResolver,
} from "./job-manager.js";

const OWNER = "owner-device-a";
const OTHER_OWNER = "owner-device-b";

function commandParams(): JobParams {
  return {
    type: "command",
    workspace: { repoId: "r", headCommit: "a".repeat(40) },
    command: "noop",
    args: [],
    timeoutMs: 60_000,
  };
}

/** Succeeds immediately, emitting one log event first. Records its context. */
class SucceedingExecutor implements Executor<"command"> {
  readonly type = "command" as const;
  lastContext: ExecutionContext | undefined;

  async execute(
    _params: CommandJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    this.lastContext = context;
    context.emit({ type: "log", level: "info", message: "working" });
    return {
      jobId: context.jobId,
      type: "command",
      status: "succeeded",
      output: { stdout: "", stderr: "", exitCode: 0 },
      stats: { toolCalls: 0, wallMs: 0 },
    };
  }
}

/** Throws — exercises the runJob backstop. */
class ThrowingExecutor implements Executor<"command"> {
  readonly type = "command" as const;
  async execute(): Promise<JobResult> {
    throw new Error("kaboom");
  }
}

/** Resolves `canceled` only once its AbortSignal fires (a well-behaved job). */
class AbortAwareExecutor implements Executor<"command"> {
  readonly type = "command" as const;
  async execute(
    _params: CommandJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
      } else {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }
    });
    return {
      jobId: context.jobId,
      type: "command",
      status: "canceled",
      stats: { toolCalls: 0, wallMs: 0 },
      error: { code: "CANCELED", message: "job canceled" },
    };
  }
}

/** Ignores its AbortSignal and never resolves (a misbehaving M6-style job). */
class StuckExecutor implements Executor<"command"> {
  readonly type = "command" as const;
  execute(): Promise<JobResult> {
    return new Promise<JobResult>(() => {});
  }
}

const managers: JobManager[] = [];

function makeManager(options: Partial<JobManagerOptions> = {}): JobManager {
  const manager = new JobManager({
    executors: options.executors ?? [new SucceedingExecutor()],
    resolveWorkspace:
      options.resolveWorkspace ??
      (async () => ({ dir: "/unit-ws", release: async () => {} })),
    // Permissive by default (no endpoint): none of this file's fake
    // executors read context.endpoint, so only tests exercising submit-time
    // model enforcement need to override this.
    resolveModel: options.resolveModel ?? (() => ({ ok: true })),
    ...options,
  });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  // stop() is bounded, so even a manager holding a stuck job tears down.
  for (const manager of managers.splice(0)) {
    await manager.stop();
  }
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitUntil timed out");
}

function isSucceeded(manager: JobManager, jobId: string): boolean {
  try {
    return manager.snapshot(jobId, OWNER).status === "succeeded";
  } catch {
    return false;
  }
}

test("retention evicts the oldest terminal job past the cap", async () => {
  const logs: string[] = [];
  const manager = makeManager({
    maxConcurrentJobs: 1, // serialize so termination order == submit order
    maxRetainedJobs: 2,
    logger: (message) => logs.push(message),
  });

  const first = manager.submit(commandParams(), OWNER);
  const second = manager.submit(commandParams(), OWNER);
  const third = manager.submit(commandParams(), OWNER);

  await waitUntil(() => isSucceeded(manager, third.jobId));

  // Oldest terminal (first) evicted; the two newest retained.
  expect(() => manager.snapshot(first.jobId, OWNER)).toThrow(JobDispatchError);
  expect(manager.snapshot(second.jobId, OWNER).status).toBe("succeeded");
  expect(manager.snapshot(third.jobId, OWNER).status).toBe("succeeded");
  expect(logs.some((line) => line.includes(first.jobId))).toBe(true);
});

test("a throwing executor is backstopped: job fails and the slot is released", async () => {
  const manager = makeManager({
    executors: [new ThrowingExecutor(), new SucceedingExecutor2()],
    maxConcurrentJobs: 1,
  });

  const bad = manager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(bad.jobId, OWNER).status === "failed";
    } catch {
      return false;
    }
  });
  const failed = manager.snapshot(bad.jobId, OWNER);
  expect(failed.result?.error?.code).toBe("INTERNAL");

  // The slot was freed (no leak): a subsequent job on the single slot runs.
  const good = manager.submit(reconParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(good.jobId, OWNER).status === "succeeded";
    } catch {
      return false;
    }
  });
});

test("events emitted after a job is terminal are dropped; result stays last", async () => {
  const executor = new SucceedingExecutor();
  const manager = makeManager({ executors: [executor] });

  const { jobId } = manager.submit(commandParams(), OWNER);
  await waitUntil(() => isSucceeded(manager, jobId));

  const before: JobEvent[] = [];
  manager.subscribe(jobId, OWNER, 0, {
    onEvent: (event) => before.push(event),
    onClose: () => {},
  });
  expect(before.at(-1)?.type).toBe("result");

  // A straggler emit through the captured context (after resolve) is dropped.
  executor.lastContext?.emit({ type: "log", level: "warn", message: "late" });

  const after: JobEvent[] = [];
  manager.subscribe(jobId, OWNER, 0, {
    onEvent: (event) => after.push(event),
    onClose: () => {},
  });
  expect(after.length).toBe(before.length);
  expect(after.at(-1)?.type).toBe("result");
});

test("a second concurrent cancel is a safe no-op returning the terminal status", async () => {
  const manager = makeManager({ executors: [new AbortAwareExecutor()] });
  const { jobId } = manager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(jobId, OWNER).status === "running";
    } catch {
      return false;
    }
  });

  const [first, second] = await Promise.all([
    manager.cancel(jobId, OWNER),
    manager.cancel(jobId, OWNER),
  ]);
  expect(first.status).toBe("canceled");
  expect(second.status).toBe("canceled");
});

test("stop force-closes an open subscriber and delivers its terminal result", async () => {
  const manager = makeManager({ executors: [new AbortAwareExecutor()] });
  const { jobId } = manager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(jobId, OWNER).status === "running";
    } catch {
      return false;
    }
  });

  const received: JobEvent[] = [];
  let closed = false;
  manager.subscribe(jobId, OWNER, 0, {
    onEvent: (event) => received.push(event),
    onClose: () => {
      closed = true;
    },
  });

  await manager.stop();
  expect(closed).toBe(true);
  expect(received.some((event) => event.type === "result")).toBe(true);
});

test("cancel and stop are bounded when an executor ignores its AbortSignal", async () => {
  const manager = makeManager({
    executors: [new StuckExecutor()],
    cancelUnwindTimeoutMs: 100,
  });
  const { jobId } = manager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(jobId, OWNER).status === "running";
    } catch {
      return false;
    }
  });

  // cancel gives up after the bounded wait and reports the honest (still
  // non-terminal) status instead of hanging on the stuck executor.
  const startCancel = Date.now();
  const response = await manager.cancel(jobId, OWNER);
  expect(Date.now() - startCancel).toBeLessThan(2000);
  expect(response.status).toBe("running");

  // stop likewise proceeds with teardown rather than wedging shutdown.
  const startStop = Date.now();
  await manager.stop();
  expect(Date.now() - startStop).toBeLessThan(2000);
});

test("subscriberCount is owner-checked and does not leak another peer's job", async () => {
  const manager = makeManager({ executors: [new AbortAwareExecutor()] });
  const { jobId } = manager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(jobId, OWNER).status === "running";
    } catch {
      return false;
    }
  });

  expect(manager.subscriberCount(jobId, OWNER)).toBe(0);
  expect(() => manager.subscriberCount(jobId, OTHER_OWNER)).toThrow(
    JobDispatchError,
  );
});

test("activeJobs and maxConcurrent expose live load for NodeInfo", async () => {
  expect(makeManager().maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT_JOBS);

  const manager = makeManager({
    executors: [new AbortAwareExecutor()],
    maxConcurrentJobs: 3,
  });
  expect(manager.maxConcurrent).toBe(3);
  expect(manager.activeJobs).toBe(0);

  const { jobId } = manager.submit(commandParams(), OWNER);
  await waitUntil(() => manager.activeJobs === 1);

  // cancel awaits the executor's terminal unwind, so the slot is freed.
  await manager.cancel(jobId, OWNER);
  expect(manager.activeJobs).toBe(0);
});

test("the resolver release handle fires exactly once when a job reaches a terminal state", async () => {
  // Each resolve hands out a handle whose release bumps a shared counter, so
  // we can assert the pin is released exactly once on every post-acquire
  // terminal path. (That the manager AWAITS the promise-shaped release is
  // pinned by the slot-holding test below — a counter alone cannot
  // discriminate awaited from fire-and-forget.)
  let releases = 0;
  const resolveWorkspace: WorkspaceResolver = async () => ({
    dir: "/unit-ws",
    release: async () => {
      releases += 1;
    },
  });

  // Succeeded: the executor resolves normally.
  const okManager = makeManager({
    executors: [new SucceedingExecutor()],
    resolveWorkspace,
  });
  const okJob = okManager.submit(commandParams(), OWNER);
  await waitUntil(() => isSucceeded(okManager, okJob.jobId));

  // Failed: a throwing executor is backstopped into a terminal `failed`.
  const failManager = makeManager({
    executors: [new ThrowingExecutor()],
    resolveWorkspace,
  });
  const failJob = failManager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return failManager.snapshot(failJob.jobId, OWNER).status === "failed";
    } catch {
      return false;
    }
  });

  // Canceled: a running job is aborted and unwinds to `canceled`.
  const cancelManager = makeManager({
    executors: [new AbortAwareExecutor()],
    resolveWorkspace,
  });
  const cancelJob = cancelManager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return (
        cancelManager.snapshot(cancelJob.jobId, OWNER).status === "running"
      );
    } catch {
      return false;
    }
  });
  const response = await cancelManager.cancel(cancelJob.jobId, OWNER);
  expect(response.status).toBe("canceled");

  // Exactly one release per job — succeeded, failed, canceled — and never
  // twice (a small settle wait would catch a double-fire as a 4th bump).
  await waitUntil(() => releases === 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(releases).toBe(3);
});

test("executeJob AWAITS release: the run slot is held until the release settles", async () => {
  // A fire-and-forget `handle.release()` would free the slot the moment the
  // job turns terminal; an awaited one holds it through the (possibly slow)
  // worktree teardown. Discriminate with a manually-gated release on a
  // single-slot manager: while the first job's release is pending, a queued
  // second job must NOT have started.
  let openRelease: () => void = () => {};
  const releaseGate = new Promise<void>((resolve) => {
    openRelease = resolve;
  });
  let releases = 0;
  const resolveWorkspace: WorkspaceResolver = async () => ({
    dir: "/unit-ws",
    release: () => {
      releases += 1;
      // Only the FIRST job's release blocks; by the time the second job
      // releases, the gate is already open.
      return releaseGate;
    },
  });
  const manager = makeManager({ maxConcurrentJobs: 1, resolveWorkspace });

  const first = manager.submit(commandParams(), OWNER);
  const second = manager.submit(commandParams(), OWNER);

  // The first job reaches its terminal state (finishJob runs BEFORE the
  // finally's release), but its release has not settled: the slot must still
  // be held and the second job still queued.
  await waitUntil(() => isSucceeded(manager, first.jobId));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(releases).toBe(1);
  expect(manager.snapshot(second.jobId, OWNER).status).toBe("queued");

  // Settling the release frees the slot; the second job now runs.
  openRelease();
  await waitUntil(() => isSucceeded(manager, second.jobId));
  expect(releases).toBe(2);
});

test("the resolver receives the job's identity: a write job's {jobId, type} reach it", async () => {
  const seen: Array<{ jobId: JobId; type: string }> = [];
  const resolveWorkspace: WorkspaceResolver = async (_ref, _owner, job) => {
    seen.push({ jobId: job.jobId, type: job.type });
    return { dir: "/unit-ws", release: async () => {} };
  };
  const manager = makeManager({
    executors: [new SucceedingWriteExecutor(), new SucceedingExecutor()],
    resolveWorkspace,
  });

  const writeJob = manager.submit(writeParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(writeJob.jobId, OWNER).status === "succeeded";
    } catch {
      return false;
    }
  });
  const commandJob = manager.submit(commandParams(), OWNER);
  await waitUntil(() => isSucceeded(manager, commandJob.jobId));

  expect(seen).toEqual([
    { jobId: writeJob.jobId, type: "write" },
    { jobId: commandJob.jobId, type: "command" },
  ]);
});

test("a write job with no write executor registered is rejected UNSUPPORTED_JOB_TYPE", () => {
  const manager = makeManager({ executors: [new SucceedingExecutor()] });
  const thrown = ((): unknown => {
    try {
      manager.submit(writeParams(), OWNER);
      return null;
    } catch (error) {
      return error;
    }
  })();
  expect(thrown).toBeInstanceOf(JobDispatchError);
  expect((thrown as JobDispatchError).code).toBe("UNSUPPORTED_JOB_TYPE");
});

test("submit rejects an un-offered model with MODEL_NOT_OFFERED", () => {
  // A recon-capable executor must be registered so the request clears the
  // UNSUPPORTED_JOB_TYPE gate and actually reaches model resolution.
  const manager = makeManager({
    executors: [new SucceedingExecutor2()],
    resolveModel: () => ({
      ok: false,
      code: "MODEL_NOT_OFFERED",
      message: "not offered",
      details: { model: "ghost" },
    }),
  });
  try {
    manager.submit(reconParams({ model: "ghost" }), OWNER);
    expect.unreachable("submit should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(JobDispatchError);
    expect((e as JobDispatchError).code).toBe("MODEL_NOT_OFFERED");
  }
});

test("submit rejects when no model resolves (NO_MODEL_SPECIFIED)", () => {
  const manager = makeManager({
    executors: [new SucceedingExecutor2()],
    resolveModel: () => ({
      ok: false,
      code: "NO_MODEL_SPECIFIED",
      message: "no default",
    }),
  });
  expect(() => manager.submit(reconParams(), OWNER)).toThrow(JobDispatchError);
});

test("submit runs a command job through resolution, which short-circuits (no model)", () => {
  const resolveModel = vi.fn(() => ({ ok: true as const }));
  const manager = makeManager({ resolveModel });
  expect(() => manager.submit(commandParams(), OWNER)).not.toThrow();
  // The resolver IS consulted for every job type — it just returns { ok: true }
  // for a non-model-bearing command job (requestedModel is always undefined).
  expect(resolveModel).toHaveBeenCalledWith("command", undefined);
});

test("onJobEvicted fires with the evicted jobId on retention overflow", async () => {
  const evicted: JobId[] = [];
  const manager = makeManager({
    maxConcurrentJobs: 1, // serialize so termination order == submit order
    maxRetainedJobs: 2,
    onJobEvicted: (jobId) => evicted.push(jobId),
  });

  const first = manager.submit(commandParams(), OWNER);
  const second = manager.submit(commandParams(), OWNER);
  const third = manager.submit(commandParams(), OWNER);
  await waitUntil(() => isSucceeded(manager, third.jobId));

  expect(evicted).toEqual([first.jobId]);
  expect(manager.snapshot(second.jobId, OWNER).status).toBe("succeeded");
});

test("onJobEvicted fires for every retained record on stop()", async () => {
  const evicted: JobId[] = [];
  const manager = makeManager({
    executors: [new SucceedingExecutor(), new SucceedingExecutor2()],
    onJobEvicted: (jobId) => evicted.push(jobId),
  });

  const a = manager.submit(commandParams(), OWNER);
  const b = manager.submit(reconParams(), OWNER);
  await waitUntil(() => isSucceeded(manager, a.jobId));
  await waitUntil(() => isSucceeded(manager, b.jobId));

  await manager.stop();
  expect(evicted.sort()).toEqual([a.jobId, b.jobId].sort());
});

test("a throwing onJobEvicted hook breaks neither eviction nor stop", async () => {
  const logs: string[] = [];
  const manager = makeManager({
    maxConcurrentJobs: 1,
    maxRetainedJobs: 2,
    logger: (message) => logs.push(message),
    onJobEvicted: () => {
      throw new Error("hook kaboom");
    },
  });

  const first = manager.submit(commandParams(), OWNER);
  const second = manager.submit(commandParams(), OWNER);
  const third = manager.submit(commandParams(), OWNER);
  await waitUntil(() => isSucceeded(manager, third.jobId));

  // The eviction still happened despite the throwing hook, and was shielded.
  expect(() => manager.snapshot(first.jobId, OWNER)).toThrow(JobDispatchError);
  expect(manager.snapshot(second.jobId, OWNER).status).toBe("succeeded");
  expect(logs.some((line) => line.includes("hook kaboom"))).toBe(true);

  // stop()'s per-record teardown notifications are shielded the same way.
  await expect(manager.stop()).resolves.toBeUndefined();
});

/** A second command-typed executor is a config error, so the backstop test's
 * "subsequent job" is a recon job served by this agent-typed stand-in. */
class SucceedingExecutor2 implements Executor<"recon"> {
  readonly type = "recon" as const;
  async execute(
    _params: ReconJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    return {
      jobId: context.jobId,
      type: "recon",
      status: "succeeded",
      summary: "ok",
      stats: { toolCalls: 0, wallMs: 0 },
    };
  }
}

function reconParams(overrides: Partial<ReconJobParams> = {}): JobParams {
  return {
    type: "recon",
    workspace: { repoId: "r", headCommit: "a".repeat(40) },
    prompt: "hi",
    budgets: { maxToolCalls: 5, maxWallMs: 30_000 },
    ...overrides,
  };
}

function writeParams(): JobParams {
  return {
    type: "write",
    workspace: { repoId: "r", headCommit: "a".repeat(40) },
    instructions: "change things",
    budgets: { maxToolCalls: 5, maxWallMs: 30_000 },
  };
}

/** Minimal write executor: succeeds with the mandatory explicit artifact. */
class SucceedingWriteExecutor implements Executor<"write"> {
  readonly type = "write" as const;
  async execute(
    _params: WriteJobParams,
    context: ExecutionContext,
  ): Promise<JobResult> {
    return {
      jobId: context.jobId,
      type: "write",
      status: "succeeded",
      artifact: null,
      stats: { toolCalls: 0, wallMs: 0 },
    };
  }
}
