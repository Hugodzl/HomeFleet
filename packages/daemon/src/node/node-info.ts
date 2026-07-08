/**
 * The real NodeInfo builder (M9): assembles the capability profile this
 * daemon advertises in `hello`/pairing from config (name, executors,
 * models), OS facts (hostname, platform, hardware), and live job load.
 *
 * The provider is a `() => NodeInfo` closure so consumers (the node
 * directory's `hello`, discovery announcements) always see CURRENT load:
 * static facts are computed once, `activeJobs` is re-read per call.
 */
import os from "node:os";
import {
  type ExecutorKind,
  HFP_PROTOCOL_VERSION,
  type NodeInfo,
  NodeInfoSchema,
  type NodeRole,
} from "@homefleet/protocol";
import type { DaemonConfig } from "../config/config.js";

/** The config sections the profile is derived from (DaemonConfig satisfies it). */
export type NodeInfoConfig = Pick<
  DaemonConfig,
  "node" | "executors" | "models"
>;

/**
 * Live job-load surface the profile reads on every call. A `Pick`-style
 * structural type the JobManager satisfies, so the builder needs no
 * dependency on the jobs module.
 */
export interface JobLoadSource {
  /** Number of jobs currently running. */
  activeJobCount(): number;
  /** The effective concurrency limit the manager enforces. */
  readonly maxConcurrent: number;
}

export interface NodeInfoProviderOptions {
  /** This node's device ID (SHA-256 cert fingerprint), from its identity. */
  deviceId: string;
  /** The loaded daemon config (only `node`/`executors`/`models` are read). */
  config: NodeInfoConfig;
  /** The daemon's own version, advertised as `daemonVersion` (semver). */
  daemonVersion: string;
  /**
   * Live job load. Absent for a delegating-only front that runs no
   * JobManager (e.g. the stdio shim): the profile then advertises
   * `maxConcurrentJobs: 1, activeJobs: 0` — the schema requires a limit
   * >= 1 even for a node that accepts no jobs, and 1/0 is the honest floor.
   */
  jobs?: JobLoadSource;
  /** Test override for `os.hostname()` (the name-fallback chain is OS-dependent). */
  hostname?: string;
}

/** Node's platform coerced into the protocol's supported set. */
export function currentPlatform(): NodeInfo["platform"] {
  const platform = process.platform;
  return platform === "win32" || platform === "darwin" ? platform : "linux";
}

/**
 * Resolves the advertised node name: a configured name wins; otherwise the
 * hostname, truncated to the schema's 64-char cap. A machine can report an
 * empty hostname, and `NodeNameSchema` requires at least one character, so
 * that case falls back to a fixed name rather than emit an invalid profile.
 */
function resolveNodeName(
  configuredName: string | undefined,
  hostnameOverride: string | undefined,
): string {
  if (configuredName !== undefined) {
    return configuredName;
  }
  const hostname = (hostnameOverride ?? os.hostname()).slice(0, 64);
  return hostname === "" ? "homefleet" : hostname;
}

/**
 * Builds the `() => NodeInfo` provider the daemon assembly injects wherever
 * a self-profile is needed.
 *
 * Roles are DERIVED from the configured executors, one honest mapping each:
 * `command` -> "execution" (the node runs command jobs), `agent` ->
 * "inference" (the node runs recon/agent jobs, which are inference work).
 * An agent executor does NOT imply the "execution" role: a node with only an
 * agent executor is inference-only — it accepts no plain command jobs.
 *
 * Every call validates its output with `NodeInfoSchema.parse` — fail closed:
 * a bad config value or hostname can never emit an invalid profile to peers.
 */
export function createNodeInfoProvider(
  options: NodeInfoProviderOptions,
): () => NodeInfo {
  const { deviceId, config, daemonVersion, jobs } = options;
  const name = resolveNodeName(config.node.name, options.hostname);

  const executors: ExecutorKind[] = [];
  const roles: NodeRole[] = [];
  if (config.executors.command !== undefined) {
    executors.push("command");
    roles.push("execution");
  }
  if (config.executors.agent !== undefined) {
    executors.push("agent");
    roles.push("inference");
  }

  // Static hardware facts, computed once. GPU detection is deliberately out
  // of scope for v0: there is no reliable cross-platform GPU probe without
  // native dependencies, and an empty array is honest ("none advertised"),
  // where a guess would not be.
  const hardware: NodeInfo["hardware"] = {
    cpu: os.cpus()[0]?.model ?? "unknown",
    ramBytes: os.totalmem(),
    gpus: [],
  };
  const platform = currentPlatform();

  return (): NodeInfo =>
    NodeInfoSchema.parse({
      deviceId,
      name,
      daemonVersion,
      protocolVersion: HFP_PROTOCOL_VERSION,
      platform,
      roles,
      executors,
      models: config.models,
      hardware,
      // See {@link NodeInfoProviderOptions.jobs} for the 1/0 default.
      maxConcurrentJobs: jobs?.maxConcurrent ?? 1,
      activeJobs: jobs?.activeJobCount() ?? 0,
    } satisfies NodeInfo);
}
