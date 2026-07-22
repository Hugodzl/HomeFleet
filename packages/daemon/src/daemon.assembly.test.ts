/**
 * Daemon assembly seams that the integration suite cannot reach: the mDNS
 * rename diagnostics ride DiscoveryAggregatorOptions.onDiagnostic, but the
 * real daemon's mDNS channel is the live bonjour backend — deliberately
 * disabled in tests (see daemon.integration.test.ts) because real multicast
 * is non-deterministic in CI. So instead of driving a rename end to end,
 * this pins the wiring line itself: the aggregator must be constructed with
 * the daemon's own onDiagnostic sink. The v0.1 legacy-cache seam bug (commit
 * 60a916e) was exactly a diagnostic emitted into a dropped sink, and the
 * WorkspaceStore leg of this sink is covered end to end by the integration
 * suite; this covers the discovery leg.
 *
 * The write-delegation assembly seams (Task 11) are pinned the same way:
 * job eviction must reap the evicted job's artifact bundle
 * (JobManagerOptions.onJobEvicted → ArtifactStore.remove) and daemon
 * teardown must sweep the store (ArtifactStore.removeAll) — eviction is
 * retention-cap-driven and teardown file deletion is not observable through
 * the integration suite's surfaces, so the wiring lines themselves are
 * asserted here. The WriteExecutor's finalize closure is likewise driven
 * directly against the daemon's REAL workspace store (unknown jobId →
 * NO_WRITE_WORKSPACE), which the integration suite only exercises on the
 * happy path.
 *
 * The mocks wrap (not replace) the real classes, recording constructor
 * options/instances — every other test in this FILE-scoped mock still runs
 * the real code. Kept separate from daemon.integration.test.ts so the mocks
 * cannot leak into the full-stack tests.
 */
import { randomUUID } from "node:crypto";
import type { WriteExecutorOptions as ExecutorsWriteExecutorOptions } from "@homefleet/executors";
import { afterEach, expect, test, vi } from "vitest";
import { DaemonConfigSchema } from "./config/config.js";
import { resolveDataDir } from "./config/paths.js";
import { Daemon } from "./daemon.js";
import type { DiscoveryAggregatorOptions } from "./discovery/aggregator.js";
import type { JobManagerOptions } from "./jobs/job-manager.js";
import { makeTempDataDir, removeTempDataDir } from "./test-fixtures.js";
import type { ArtifactStoreOptions } from "./workspace/artifact-store.js";

const captured = vi.hoisted(() => ({
  options: [] as unknown[],
  jobManagerOptions: [] as unknown[],
  artifactStores: [] as unknown[],
  writeExecutorOptions: [] as unknown[],
}));

vi.mock("./discovery/aggregator.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./discovery/aggregator.js")>();
  class RecordingAggregator extends original.DiscoveryAggregator {
    constructor(options: DiscoveryAggregatorOptions) {
      super(options);
      captured.options.push(options);
    }
  }
  return { ...original, DiscoveryAggregator: RecordingAggregator };
});

vi.mock("./jobs/job-manager.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./jobs/job-manager.js")>();
  class RecordingJobManager extends original.JobManager {
    constructor(options: JobManagerOptions) {
      super(options);
      captured.jobManagerOptions.push(options);
    }
  }
  return { ...original, JobManager: RecordingJobManager };
});

/** The recording subclass's extra bookkeeping, for test-side downcasts. */
interface RecordingArtifactStoreShape {
  removeCalls: string[];
  removeAllCalls: number;
}

vi.mock("./workspace/artifact-store.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./workspace/artifact-store.js")>();
  class RecordingArtifactStore
    extends original.ArtifactStore
    implements RecordingArtifactStoreShape
  {
    removeCalls: string[] = [];
    removeAllCalls = 0;
    constructor(options: ArtifactStoreOptions = {}) {
      super(options);
      captured.artifactStores.push(this);
    }
    override async remove(jobId: string): Promise<void> {
      this.removeCalls.push(jobId);
      return super.remove(jobId);
    }
    override async removeAll(): Promise<void> {
      this.removeAllCalls += 1;
      return super.removeAll();
    }
  }
  return { ...original, ArtifactStore: RecordingArtifactStore };
});

vi.mock("@homefleet/executors", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@homefleet/executors")>();
  class RecordingWriteExecutor extends original.WriteExecutor {
    constructor(options: ExecutorsWriteExecutorOptions) {
      super(options);
      captured.writeExecutorOptions.push(options);
    }
  }
  return { ...original, WriteExecutor: RecordingWriteExecutor };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  captured.options.length = 0;
  captured.jobManagerOptions.length = 0;
  captured.artifactStores.length = 0;
  captured.writeExecutorOptions.length = 0;
});

async function startTestDaemon(
  overrides: Record<string, unknown> = {},
): Promise<Daemon> {
  const dir = await makeTempDataDir("homefleet-daemon-assembly-");
  cleanups.push(() => removeTempDataDir(dir));
  const dataDir = resolveDataDir({ HOMEFLEET_DATA_DIR: dir });
  const daemon = new Daemon({
    dataDir,
    config: DaemonConfigSchema.parse({
      node: { name: "assembly" },
      hfp: { host: "127.0.0.1", port: 0 },
      mcp: { host: "127.0.0.1", port: 0 },
      control: { host: "127.0.0.1", port: 0 },
      discovery: { mdnsEnabled: false, udpEnabled: false },
      ...overrides,
    }),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

test("the daemon threads its onDiagnostic sink into the DiscoveryAggregator", async () => {
  const dir = await makeTempDataDir("homefleet-daemon-assembly-");
  cleanups.push(() => removeTempDataDir(dir));
  const dataDir = resolveDataDir({ HOMEFLEET_DATA_DIR: dir });

  const diagnostics: string[] = [];
  const daemon = new Daemon({
    dataDir,
    config: DaemonConfigSchema.parse({
      node: { name: "assembly" },
      hfp: { host: "127.0.0.1", port: 0 },
      mcp: { host: "127.0.0.1", port: 0 },
      control: { host: "127.0.0.1", port: 0 },
      discovery: { mdnsEnabled: false, udpEnabled: false },
    }),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());

  expect(captured.options).toHaveLength(1);
  const options = captured.options[0] as DiscoveryAggregatorOptions;
  expect(options.onDiagnostic).toBeDefined();
  // Behavioral identity, not mere presence: a message emitted into the
  // aggregator's sink must come out of the daemon's. Substring, not
  // equality — a future daemon-side prefixing wrapper would still pass
  // the message through, which is all this seam promises.
  options.onDiagnostic?.("assembly-check: discovery diagnostic");
  expect(
    diagnostics.some((m) => m.includes("assembly-check: discovery diagnostic")),
  ).toBe(true);
}, 30_000);

test("job eviction reaps the job's artifact (onJobEvicted → ArtifactStore.remove) and stop() sweeps the store", async () => {
  const daemon = await startTestDaemon();

  expect(captured.artifactStores).toHaveLength(1);
  const store = captured.artifactStores[0] as RecordingArtifactStoreShape;
  expect(captured.jobManagerOptions).toHaveLength(1);
  const jobOptions = captured.jobManagerOptions[0] as JobManagerOptions;
  expect(jobOptions.onJobEvicted).toBeDefined();

  // The hook is SYNC by ratified design (remove() deletes its map entry
  // before its only await and never rejects): firing it must call the
  // store's remove with the evicted jobId, without returning a promise.
  const evictedId = randomUUID();
  const returned = jobOptions.onJobEvicted?.(evictedId);
  expect(returned).toBeUndefined();
  expect(store.removeCalls).toContain(evictedId);

  // Teardown sweeps the store (the removeAll leg of the teardown stack);
  // stop-fired eviction hooks and removeAll overlap by design (remove
  // tolerates unknown ids, so the double-reap is a no-op).
  await daemon.stop();
  expect(store.removeAllCalls).toBeGreaterThanOrEqual(1);
}, 30_000);

test("executors.write config assembles a WriteExecutor whose finalize closure hits the REAL workspace store", async () => {
  await startTestDaemon({
    catalog: {
      models: [
        {
          id: "test-model",
          contextWindow: 32_768,
          endpoint: { baseUrl: "http://127.0.0.1:9/v1" },
        },
      ],
    },
    executors: {
      write: { defaultModel: "test-model" },
    },
  });

  expect(captured.writeExecutorOptions).toHaveLength(1);
  const options = captured
    .writeExecutorOptions[0] as ExecutorsWriteExecutorOptions;
  // The construction options carry NO endpoint (Task 7/8): the model
  // endpoint is resolved per-job from the catalog and threaded through
  // ExecutionContext, not baked into the executor at assembly time.
  expect(options).not.toHaveProperty("endpoint");

  // The finalize closure is wired to the daemon's real WorkspaceStore: a
  // jobId with no live write worktree surfaces the store's typed
  // NO_WRITE_WORKSPACE error (the documented unknown-jobId contract).
  await expect(
    options.finalize({
      jobId: randomUUID(),
      workspaceDir: "irrelevant",
      commitMessage: "m",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "NO_WRITE_WORKSPACE" });
}, 30_000);

test("a config without executors.write assembles NO WriteExecutor (fail closed)", async () => {
  await startTestDaemon();
  expect(captured.writeExecutorOptions).toHaveLength(0);
}, 30_000);
