/**
 * Daemon configuration: a zod-validated `config.json` in the data dir.
 *
 * A missing file yields all defaults (a fresh install needs no config), but
 * a file that exists and cannot be read or does not validate throws — fail
 * closed, same rationale as the trust store: config governs
 * security-adjacent behavior (which discovery channels run, which interface
 * they bind), and silently substituting defaults could re-enable a channel
 * the user deliberately disabled.
 *
 * Parsing is STRICT (`z.strictObject`): an unknown or typo'd key throws
 * instead of being silently stripped — a stripped `"allowList"` would
 * otherwise substitute the fail-closed default while the file LOOKS
 * configured. The accepted trade-off: an older daemon refuses a newer
 * config's unknown keys instead of ignoring them (consistent fail-closed).
 *
 * Sections: `discovery` (M3), `workspace` (M7, worker side), and the M9
 * daemon-assembly set — `node`, `hfp`, `mcp`, `control`, `executors`,
 * `models`, `jobs`, `repos`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentEndpointOptions,
  type CommandAllowlistEntry,
  MIN_AGENT_CONTEXT_WINDOW,
} from "@homefleet/executors";
import {
  DeviceIdSchema,
  DISCOVERY_MULTICAST_GROUP,
  DISCOVERY_UDP_PORT,
  HFP_DEFAULT_PORT,
  ModelInfoSchema,
  NodeNameSchema,
  RepoIdSchema,
} from "@homefleet/protocol";
import { z } from "zod";
import { LOOPBACK_HOSTS } from "../mcp/http-transport.js";

/**
 * Compile-time exact-shape guard: `true` only when `A` and `B` are mutually
 * assignable. Used below to pin the config mirrors of executors' TS types —
 * drift becomes a compile error instead of a silently-outdated comment.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Expect<T extends true> = T;

/** A config-provided discovery entry for a node mDNS/UDP cannot see. */
export const StaticNodeSchema = z.strictObject({
  host: z.string().min(1),
  /** The node's HFP HTTPS port. */
  port: z.int().min(1).max(65535),
  /**
   * The device ID expected at `host:port`, when known. Like every discovery
   * datum this is a hint — trust still comes from pairing + the mTLS pin.
   */
  expectedDeviceId: DeviceIdSchema.optional(),
});
export type StaticNode = z.infer<typeof StaticNodeSchema>;

export const DiscoveryConfigSchema = z.strictObject({
  mdnsEnabled: z.boolean().default(true),
  udpEnabled: z.boolean().default(true),
  /**
   * UDP discovery port. `0` binds an ephemeral port (tests, multiple
   * daemons on one machine); note that multicast discovery only works when
   * all nodes listen on the same port, so production stays on the default.
   */
  udpPort: z.int().min(0).max(65535).default(DISCOVERY_UDP_PORT),
  multicastGroup: z.string().min(1).default(DISCOVERY_MULTICAST_GROUP),
  /** How often to re-announce over UDP (it is lossy). */
  announceIntervalMs: z.int().min(1).default(60_000),
  /**
   * Interface-selection override: the local address to bind discovery to.
   * VPN/virtual adapters grabbing multicast traffic are the known Windows
   * failure mode; this applies to the UDP socket bind and is passed to
   * bonjour-service's interface option. Default: all interfaces.
   */
  bindAddress: z.string().min(1).optional(),
  staticNodes: z.array(StaticNodeSchema).default([]),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/**
 * Generous default cap on a received bundle, streamed to disk (NOT the 1 MiB
 * JSON body limit): a full first-sync bundle of a real repo can be many MiB.
 */
export const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/**
 * Default cap on the NUMBER of materialized checkouts retained across all
 * repos. When exceeded, the least-recently-used checkout directory is evicted
 * (the recurring "no unbounded peer-driven state" discipline). This bounds the
 * count of checkout working trees, not total disk (checkout sizes vary). Set
 * comfortably above the worker's job concurrency.
 */
export const DEFAULT_MAX_CACHED_CHECKOUTS = 32;

/** Default per-invocation git timeout for workspace ops (bundle/fetch/checkout). */
export const DEFAULT_WORKSPACE_GIT_TIMEOUT_MS = 120_000;

/**
 * Default number of successful bundle fetches into a repo's bare cache before
 * `git gc --prune=now` runs (per repo). Bounds bare object-store accretion: an
 * unbundle imports objects even for a subsequently-rejected upload, so without
 * periodic gc a peer could grow `repo.git` without limit. gc is expensive, so
 * it is amortized over this many fetches rather than run every time.
 */
export const DEFAULT_WORKSPACE_GC_AFTER_FETCHES = 20;

/**
 * Worker-side workspace sync config (M7, ADR-0005). The worker only accepts
 * sync/jobs for repos on `allowedRepoIds`; an EMPTY allowlist (the default)
 * means accept NOTHING — fail closed. `cacheDir` defaults to
 * `<dataDir>/workspaces`. Peer-driven growth is bounded on two axes:
 * `maxCachedCheckouts` caps the checkout COUNT, and `gcAfterFetches` bounds the
 * bare object store by periodic gc.
 */
export const WorkspaceConfigSchema = z.strictObject({
  /** Repo identities this worker will sync and run jobs for. Empty = none. */
  allowedRepoIds: z.array(z.string().min(1)).default([]),
  /** Override for the per-repo cache root; defaults to `<dataDir>/workspaces`. */
  cacheDir: z.string().min(1).optional(),
  maxBundleBytes: z.int().min(1).default(DEFAULT_MAX_BUNDLE_BYTES),
  maxCachedCheckouts: z.int().min(1).default(DEFAULT_MAX_CACHED_CHECKOUTS),
  /** Fetches per repo between `git gc --prune=now` runs on its bare cache. */
  gcAfterFetches: z.int().min(1).default(DEFAULT_WORKSPACE_GC_AFTER_FETCHES),
  gitTimeoutMs: z.int().min(1000).default(DEFAULT_WORKSPACE_GIT_TIMEOUT_MS),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/**
 * Default port for the daemon's local MCP HTTP endpoint. Part of the
 * HomeFleet 5637x port family (HFP 56370, UDP discovery 56371, MCP 56372,
 * control 56373 — see `HFP_DEFAULT_PORT` / `DISCOVERY_UDP_PORT` in
 * @homefleet/protocol): a stable well-known localhost port so MCP clients
 * (agent configs) are set up once per machine, in a range unlikely to
 * collide with common services.
 */
export const DEFAULT_MCP_PORT = 56372;

/** Default port for the loopback daemon control API (5637x family, above). */
export const DEFAULT_CONTROL_PORT = 56373;

/**
 * Node identity. `name` is OPTIONAL with no default on purpose: when omitted
 * the daemon assembly falls back to `os.hostname()` at startup. That
 * fallback lives in the assembly, NOT here — config parsing stays pure (no
 * os/fs calls), so parsing the same file always yields the same object.
 */
export const NodeConfigSchema = z.strictObject({
  /** Human-readable node name advertised in discovery and NodeInfo. */
  name: NodeNameSchema.optional(),
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

/** Bind address for the HFP node service (the mTLS HTTPS endpoint peers hit). */
export const HfpConfigSchema = z.strictObject({
  /**
   * LAN-facing by design — peers must be able to reach it. Note `0.0.0.0`
   * is IPv4-only; that is intentional for v0 (discovery announces IPv4
   * addresses). Set `"::"` explicitly for a dual-stack bind if needed.
   */
  host: z.string().min(1).default("0.0.0.0"),
  /** `0` binds an ephemeral port (tests, multiple daemons on one machine). */
  port: z.int().min(0).max(65535).default(HFP_DEFAULT_PORT),
});
export type HfpConfig = z.infer<typeof HfpConfigSchema>;

/**
 * A host field restricted to loopback, validated at PARSE time against the
 * same `LOOPBACK_HOSTS` set the MCP transport enforces at bind time — a
 * non-loopback value fails with a config error immediately instead of a
 * bind-time crash later (same refuse-early posture as the agent
 * contextWindow floor).
 */
const LoopbackHostSchema = z
  .string()
  .refine((host) => LOOPBACK_HOSTS.has(host), {
    message: `must be a loopback host: ${[...LOOPBACK_HOSTS].join(", ")}`,
  });

/**
 * Bind address for the MCP front local agents connect to. Loopback by
 * default AND by enforcement: the MCP HTTP transport refuses to bind a
 * non-loopback host outright (it carries no auth), so `host` here selects
 * among loopback aliases (`127.0.0.1`, `::1`, `localhost`) — it is not a
 * way to expose MCP on the LAN. The default port is a stable well-known
 * value so MCP client configs are written once.
 */
export const McpConfigSchema = z.strictObject({
  host: LoopbackHostSchema.default("127.0.0.1"),
  port: z.int().min(0).max(65535).default(DEFAULT_MCP_PORT),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Bind address for the daemon control API the `homefleet` CLI talks to.
 * Loopback-only by design: it is a local admin surface; remote
 * administration goes through HFP (mTLS + pairing), never this port.
 */
export const ControlConfigSchema = z.strictObject({
  host: LoopbackHostSchema.default("127.0.0.1"),
  port: z.int().min(0).max(65535).default(DEFAULT_CONTROL_PORT),
});
export type ControlConfig = z.infer<typeof ControlConfigSchema>;

/**
 * Mirrors `CommandAllowlistEntry` from `@homefleet/executors` (that package
 * exports only the TS interface, not a zod schema, so config validates its
 * own copy — the guard below keeps the two shapes in sync at compile time).
 */
export const CommandAllowlistEntryConfigSchema = z.strictObject({
  /**
   * Executable path or name to spawn for this logical command; defaults to
   * the logical name itself (see the executors package for the win32
   * `.cmd` caveat).
   */
  executable: z.string().min(1).optional(),
});
export type CommandAllowlistEntryConfig = z.infer<
  typeof CommandAllowlistEntryConfigSchema
>;
// Compile error here = the schema above drifted from CommandAllowlistEntry.
type _CommandAllowlistEntryMirrorGuard = Expect<
  MutuallyAssignable<CommandAllowlistEntryConfig, CommandAllowlistEntry>
>;

/** Logical command name -> how it runs. Enforcement is an exact-name match. */
const CommandAllowlistConfigSchema = z.record(
  z.string().min(1),
  CommandAllowlistEntryConfigSchema,
);

export const CommandExecutorConfigSchema = z.strictObject({
  /** Empty allowlist = the executor is offered but no command may run. */
  allowlist: CommandAllowlistConfigSchema.default({}),
});
export type CommandExecutorConfig = z.infer<typeof CommandExecutorConfigSchema>;

/** Mirrors `AgentEndpointOptions` in @homefleet/executors (guard below). */
export const AgentEndpointConfigSchema = z.strictObject({
  /** OpenAI-compatible base URL; `/chat/completions` is appended. */
  baseUrl: z.url(),
  /** Sent as a Bearer token when present. */
  apiKey: z.string().min(1).optional(),
  /** Default model ID; a job's `params.model` overrides it (same endpoint). */
  model: z.string().min(1),
  /**
   * Context window served by the endpoint, in tokens. The floor mirrors
   * `MIN_AGENT_CONTEXT_WINDOW` in @homefleet/executors: model servers
   * commonly default to ~4k contexts, which silently break agentic tool use
   * (truncated histories, dropped tool schemas) — refuse at config time
   * instead of failing confusingly mid-job.
   */
  contextWindow: z.int().min(MIN_AGENT_CONTEXT_WINDOW),
});
export type AgentEndpointConfig = z.infer<typeof AgentEndpointConfigSchema>;
// Compile error here = the schema above drifted from AgentEndpointOptions.
type _AgentEndpointMirrorGuard = Expect<
  MutuallyAssignable<AgentEndpointConfig, AgentEndpointOptions>
>;

export const AgentExecutorConfigSchema = z.strictObject({
  endpoint: AgentEndpointConfigSchema,
  /** Allowlist for the agent's run_command tool; absent disables the tool. */
  commandAllowlist: CommandAllowlistConfigSchema.optional(),
});
export type AgentExecutorConfig = z.infer<typeof AgentExecutorConfigSchema>;

/**
 * Which executors this node offers. Both sub-keys OPTIONAL and absent by
 * default — fail closed: a fresh install runs NO executors (accepts no
 * jobs) until one is explicitly configured, the same posture as the
 * workspace allowlist.
 */
export const ExecutorsConfigSchema = z.strictObject({
  command: CommandExecutorConfigSchema.optional(),
  agent: AgentExecutorConfigSchema.optional(),
});
export type ExecutorsConfig = z.infer<typeof ExecutorsConfigSchema>;

/**
 * JobManager limit overrides. All optional: absent means the JobManager's
 * own `DEFAULT_MAX_*` values apply — those numbers are deliberately NOT
 * duplicated here, so the JobManager stays their single owner.
 */
export const JobsConfigSchema = z.strictObject({
  maxConcurrentJobs: z.int().min(1).optional(),
  maxQueuedJobs: z.int().min(1).optional(),
  maxRetainedJobs: z.int().min(1).optional(),
});
export type JobsConfig = z.infer<typeof JobsConfigSchema>;

/**
 * Delegating-side repo mapping: a repo this daemon may bundle and sync to a
 * worker when `delegate_task` names its `repoId`. Fail closed: a repoId not
 * listed here cannot be synced FROM this machine (the worker side has its
 * own independent allowlist, `workspace.allowedRepoIds`).
 */
export const RepoMappingSchema = z.strictObject({
  repoId: RepoIdSchema,
  /** Local path of the git working copy to bundle from. */
  path: z.string().min(1),
});
export type RepoMapping = z.infer<typeof RepoMappingSchema>;

/**
 * The delegating-side repo list. Duplicate `repoId`s are REJECTED at load
 * time (fail closed, like the rest of this file): a repoId maps to exactly one
 * local path, so a second entry for the same id is an ambiguous, silently
 * last-wins config the user almost certainly did not intend — surfacing it as
 * an error is safer than picking one.
 */
export const ReposConfigSchema = z
  .array(RepoMappingSchema)
  .default([])
  .refine(
    (repos) => new Set(repos.map((r) => r.repoId)).size === repos.length,
    {
      message:
        "repos contains duplicate repoId entries; each repoId must be unique",
    },
  );

export const DaemonConfigSchema = z.strictObject({
  // prefault: a config file without a `discovery` key gets the sub-object's
  // field-level defaults applied, same as an empty file.
  discovery: DiscoveryConfigSchema.prefault({}),
  // Same treatment for `workspace`: absent -> the fail-closed defaults (empty
  // allowlist, so the worker accepts no repos until one is configured).
  workspace: WorkspaceConfigSchema.prefault({}),
  // M9 sections, same prefault treatment (absent key = section defaults).
  node: NodeConfigSchema.prefault({}),
  hfp: HfpConfigSchema.prefault({}),
  mcp: McpConfigSchema.prefault({}),
  control: ControlConfigSchema.prefault({}),
  executors: ExecutorsConfigSchema.prefault({}),
  /** Models this node advertises in NodeInfo (protocol `ModelInfoSchema`). */
  models: z.array(ModelInfoSchema).default([]),
  jobs: JobsConfigSchema.prefault({}),
  repos: ReposConfigSchema,
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

const CONFIG_FILE = "config.json";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Loads `config.json` from `dataDir`. A missing file (ENOENT) yields all
 * defaults; any other read error and any file that does not parse or
 * validate throws.
 */
export async function loadDaemonConfig(dataDir: string): Promise<DaemonConfig> {
  const filePath = path.join(dataDir, CONFIG_FILE);
  let text: string | null = null;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw new Error(
        `Failed to read daemon config ${filePath}; refusing to start with ` +
          "default settings (they may re-enable behavior this file disables).",
        { cause: error },
      );
    }
    // ENOENT: no config file — run on defaults.
  }
  if (text === null) {
    return DaemonConfigSchema.parse({});
  }
  try {
    return DaemonConfigSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw new Error(
      `Invalid daemon config: ${filePath} is not a valid config file. ` +
        "Fix it or remove it to run on defaults.",
      { cause },
    );
  }
}
