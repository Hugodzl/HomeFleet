/**
 * The daemon assembly (M9): one `Daemon` class that wires every module —
 * identity, trust, pairing, HFP transport, discovery, workspace store, job
 * manager, NodeInfo, and the MCP front — into a runnable `homefleetd`
 * process. Construction order is load-bearing and documented inline; the
 * matching teardown order lives in {@link Daemon.stop}.
 */
import path from "node:path";
import {
  AgentExecutor,
  CommandExecutor,
  type Executor,
} from "@homefleet/executors";
import { HFP_PROTOCOL_VERSION, type NodeInfo } from "@homefleet/protocol";
import type { DaemonConfig } from "./config/config.js";
import { DiscoveryAggregator } from "./discovery/aggregator.js";
import { KnownNodesRegistry } from "./discovery/known-nodes.js";
import { loadOrCreateIdentity } from "./identity/identity.js";
import { JobManager } from "./jobs/job-manager.js";
import { registerJobRoutes } from "./jobs/routes.js";
import { DelegationRegistry } from "./mcp/delegation-registry.js";
import { startMcpHttpServer } from "./mcp/http-transport.js";
import {
  endpointSourceFromDiscovery,
  NodeDirectory,
} from "./mcp/node-directory.js";
import { createRepoResolver } from "./mcp/repo-resolver.js";
import { createMcpServer } from "./mcp/server.js";
import { createNodeInfoProvider } from "./node/node-info.js";
import { PairingManager } from "./pairing/pairing.js";
import { HfpClient } from "./transport/client.js";
import { NodeServer } from "./transport/server.js";
import { TrustStore } from "./trust/trust-store.js";
import { DAEMON_VERSION } from "./version.js";
import { registerWorkspaceRoutes } from "./workspace/routes.js";
import { WorkspaceStore } from "./workspace/workspace-store.js";

// Re-exported so existing consumers of the daemon assembly (this module's
// public surface) keep working; the string itself is owned by ./version.js.
export { DAEMON_VERSION };

export interface DaemonOptions {
  /** The data directory (identity, trust, config, workspaces live here). */
  dataDir: string;
  /** The loaded (validated) daemon config. */
  config: DaemonConfig;
  /**
   * Receives background failures that must not crash the daemon: the
   * DiscoveryAggregator's background errors, and failures thrown by
   * individual {@link Daemon.stop} teardown steps (so one component's
   * shutdown error doesn't prevent the daemon from reporting it while still
   * tearing down the rest). Defaults to a no-op.
   *
   * Known v0 limitation: NodeServer and the MCP front's post-listen async
   * socket errors are NOT routed here — those servers swallow their own
   * post-listen errors and take no onError param yet. The WorkspaceStore is
   * also not wired to this sink: it's built without its `logger`, and its
   * diagnostics are informational strings rather than errors, so routing
   * them here would be a category mismatch.
   */
  onError?: (error: unknown) => void;
}

/**
 * Everything a started daemon holds. Grouped in one object so "started" is a
 * single nullable field, not a dozen individually-nullable ones.
 */
interface DaemonRuntime {
  deviceId: string;
  trustStore: TrustStore;
  pairingManager: PairingManager;
  nodeInfoProvider: () => NodeInfo;
  hfpClient: HfpClient;
  jobManager: JobManager;
  workspaceStore: WorkspaceStore;
  hfpPort: number;
  mcpPort: number;
}

/** Builds the executor list from config. Nothing configured = run no jobs. */
function buildExecutors(config: DaemonConfig): Executor[] {
  const executors: Executor[] = [];
  const { command, agent } = config.executors;
  if (command !== undefined) {
    executors.push(new CommandExecutor({ allowlist: command.allowlist }));
  }
  if (agent !== undefined) {
    executors.push(
      new AgentExecutor({
        endpoint: agent.endpoint,
        ...(agent.commandAllowlist !== undefined
          ? { commandAllowlist: agent.commandAllowlist }
          : {}),
      }),
    );
  }
  return executors;
}

export class Daemon {
  private readonly dataDir: string;
  private readonly config: DaemonConfig;
  private readonly onError: (error: unknown) => void;

  private state: "new" | "started" | "stopped" = "new";
  private runtime: DaemonRuntime | null = null;
  /**
   * Teardown steps, pushed as each component starts and popped in REVERSE by
   * {@link stop} — which is exactly the required shutdown order because start
   * order was chosen for it (see the comment in {@link stop}). The same stack
   * unwinds a partially-failed {@link start}, so a daemon that failed to come
   * up never leaks sockets or child processes.
   */
  private readonly teardown: Array<() => Promise<void>> = [];

  constructor(options: DaemonOptions) {
    this.dataDir = options.dataDir;
    this.config = options.config;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Starts every component in dependency order. Not restartable (like the
   * aggregator): a stopped daemon holds burned single-use state, so callers
   * build a fresh instance instead. On partial failure every
   * already-started component is stopped before the error propagates.
   */
  async start(): Promise<void> {
    if (this.state !== "new") {
      throw new Error("Daemon cannot be restarted; create a new instance");
    }
    this.state = "started";
    try {
      await this.startComponents();
    } catch (error) {
      // Unwind: stop whatever came up, in reverse start order, then let the
      // original failure propagate. Unwind failures are secondary — they must
      // not mask the root cause — so they go to onError instead.
      this.state = "stopped";
      this.runtime = null;
      for (const step of this.teardown.splice(0).reverse()) {
        try {
          await step();
        } catch (teardownError) {
          this.onError(teardownError);
        }
      }
      throw error;
    }
  }

  private async startComponents(): Promise<void> {
    const { dataDir, config } = this;

    // Persistent state first: identity (cert + key), trust, known nodes.
    const identity = await loadOrCreateIdentity(dataDir);
    const [trustStore, knownNodes] = await Promise.all([
      TrustStore.load(dataDir),
      KnownNodesRegistry.load(dataDir),
    ]);

    // Workspace store before the JobManager (jobs resolve workspaces from it).
    const workspaceStore = new WorkspaceStore({
      cacheDir: config.workspace.cacheDir ?? path.join(dataDir, "workspaces"),
      allowedRepoIds: config.workspace.allowedRepoIds,
      maxBundleBytes: config.workspace.maxBundleBytes,
      maxCachedCheckouts: config.workspace.maxCachedCheckouts,
      gcAfterFetches: config.workspace.gcAfterFetches,
      gitTimeoutMs: config.workspace.gitTimeoutMs,
    });
    await workspaceStore.init();
    this.teardown.push(() => workspaceStore.stop());

    // JobManager: config overrides are spread only when present so the
    // manager's own defaults stay the single owner of those numbers.
    const jobs = config.jobs;
    const jobManager = new JobManager({
      executors: buildExecutors(config),
      resolveWorkspace: workspaceStore.createResolver(),
      ...(jobs.maxConcurrentJobs !== undefined
        ? { maxConcurrentJobs: jobs.maxConcurrentJobs }
        : {}),
      ...(jobs.maxQueuedJobs !== undefined
        ? { maxQueuedJobs: jobs.maxQueuedJobs }
        : {}),
      ...(jobs.maxRetainedJobs !== undefined
        ? { maxRetainedJobs: jobs.maxRetainedJobs }
        : {}),
    });
    this.teardown.push(() => jobManager.stop());

    // NodeInfo AFTER the JobManager (it advertises live load from it);
    // validates eagerly, so a bad profile fails assembly right here.
    const nodeInfoProvider = createNodeInfoProvider({
      deviceId: identity.deviceId,
      config,
      daemonVersion: DAEMON_VERSION,
      jobs: jobManager,
    });
    const pairingManager = new PairingManager({
      trustStore,
      nodeInfoProvider,
    });

    // The LAN-facing HFP server. Started before discovery because the
    // announcement must carry the actually-bound port (config may say 0).
    const nodeServer = new NodeServer({
      identity,
      trustStore,
      nodeInfoProvider,
      pairingManager,
      host: config.hfp.host,
      port: config.hfp.port,
    });
    registerJobRoutes(nodeServer, jobManager);
    registerWorkspaceRoutes(nodeServer, workspaceStore);
    const { port: hfpPort } = await nodeServer.start();
    this.teardown.push(() => nodeServer.stop());

    // Discovery announces the REAL bound port and the resolved node name.
    const aggregator = new DiscoveryAggregator({
      config: config.discovery,
      announcement: {
        deviceId: identity.deviceId,
        name: nodeInfoProvider().name,
        port: hfpPort,
        protocolVersion: HFP_PROTOCOL_VERSION,
      },
      knownNodes,
      onError: this.onError,
    });
    await aggregator.start();
    this.teardown.push(() => aggregator.stop());

    // The MCP front (delegating side) comes up LAST: it must never accept a
    // delegation against a half-assembled daemon. Collaborators are shared
    // across the per-request MCP servers (the delegation registry is the
    // cross-request state; the servers themselves are stateless).
    const hfpClient = new HfpClient(identity);
    const nodeDirectory = new NodeDirectory({
      trustStore,
      source: endpointSourceFromDiscovery({ aggregator, knownNodes }),
      hfpClient,
      ourNodeInfo: nodeInfoProvider,
    });
    const delegations = new DelegationRegistry();
    // Delegating-side repo mapping (M9 Unit 6): delegate_task syncs a repoId
    // from ITS local path here, resolved from config, before dispatching.
    const repoResolver = createRepoResolver(config.repos);
    const mcpFront = await startMcpHttpServer({
      createServer: () =>
        createMcpServer({
          hfpClient,
          workspaceSync: hfpClient,
          repoResolver,
          nodeDirectory,
          delegations,
        }),
      host: config.mcp.host,
      port: config.mcp.port,
    });
    this.teardown.push(() => mcpFront.close());

    this.runtime = {
      deviceId: identity.deviceId,
      trustStore,
      pairingManager,
      nodeInfoProvider,
      hfpClient,
      jobManager,
      workspaceStore,
      hfpPort,
      mcpPort: mcpFront.port,
    };
  }

  /**
   * Idempotent, ORDERED teardown (the reverse of start order): close the MCP
   * front first (no new delegations), then discovery (stop announcing), then
   * the LAN server (no new peer requests), then drain/abort jobs, then cancel
   * in-flight git in the workspace store.
   */
  async stop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopped";
    this.runtime = null;
    // Shielded, like start()'s unwind: a teardown step throwing must not skip
    // the remaining (earlier-started) steps — e.g. jobManager.stop() and
    // workspaceStore.stop() abort running jobs and in-flight git child
    // processes, so dropping them on the floor leaks handles. Every
    // component must get its stop, so failures are routed to onError instead
    // of aborting the loop.
    for (const step of this.teardown.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /** The started runtime, or a clear error when start() has not completed. */
  private get started(): DaemonRuntime {
    if (this.runtime === null) {
      throw new Error("Daemon is not started");
    }
    return this.runtime;
  }

  /** This node's device ID (SHA-256 cert fingerprint). */
  get deviceId(): string {
    return this.started.deviceId;
  }

  /** The actually-bound HFP (LAN, mTLS) port. */
  get hfpPort(): number {
    return this.started.hfpPort;
  }

  /** The actually-bound MCP front (loopback) port. */
  get mcpPort(): number {
    return this.started.mcpPort;
  }

  /** Exposed for pairing flows (begin/complete a pairing on this node). */
  get pairingManager(): PairingManager {
    return this.started.pairingManager;
  }

  /** Exposed for pairing flows (recording the peer after a client-side pair). */
  get trustStore(): TrustStore {
    return this.started.trustStore;
  }

  /** This daemon's outbound HFP client (pairing, workspace sync). */
  get hfpClient(): HfpClient {
    return this.started.hfpClient;
  }

  /** Exposed for tests asserting on job state. */
  get jobManager(): JobManager {
    return this.started.jobManager;
  }

  /** This node's own live NodeInfo profile. */
  nodeInfo(): NodeInfo {
    return this.started.nodeInfoProvider();
  }
}
