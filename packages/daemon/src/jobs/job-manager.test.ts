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
  JobParams,
  JobResult,
  ReconJobParams,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { JobDispatchError } from "./job.js";
import {
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
      (async () => ({ dir: "/unit-ws", release: () => {} })),
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

test("the resolver release handle fires when a job reaches a terminal state", async () => {
  // Each resolve hands out a handle whose release bumps a shared counter, so we
  // can assert the pin is released on every post-acquire terminal path.
  let releases = 0;
  const resolveWorkspace: WorkspaceResolver = async () => ({
    dir: "/unit-ws",
    release: () => {
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

  // Exactly one release per job — succeeded, failed, canceled — and never twice.
  expect(releases).toBe(3);
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

function reconParams(): JobParams {
  return {
    type: "recon",
    workspace: { repoId: "r", headCommit: "a".repeat(40) },
    prompt: "hi",
    budgets: { maxToolCalls: 5, maxWallMs: 30_000 },
  };
}
