/**
 * The real NodeInfo builder (M9): assembles the capability profile this
 * daemon advertises in `hello`/pairing from config (name, executors),
 * OS facts (hostname, platform, hardware), live job load, and the
 * caller-supplied, status-stamped model catalog (built by the daemon from
 * `buildCatalog` + `validateCatalog`; see `node/catalog.ts`).
 *
 * The provider is a `() => NodeInfo` closure so consumers (the node
 * directory's `hello`, discovery announcements) always see CURRENT load:
 * static facts are computed once, `activeJobs` is re-read per call.
 */
import os from "node:os";
import {
  type ExecutorKind,
  HFP_PROTOCOL_VERSION,
  type ModelInfo,
  type NodeInfo,
  NodeInfoSchema,
  type NodeRole,
} from "@homefleet/protocol";
import type { DaemonConfig } from "../config/config.js";

/** The config sections the profile is derived from (DaemonConfig satisfies it). */
export type NodeInfoConfig = Pick<DaemonConfig, "node" | "executors">;

/**
 * Live job-load surface the profile reads on every call. A `Pick`-style
 * structural type the JobManager satisfies, so the builder needs no
 * dependency on the jobs module.
 */
export interface JobLoadSource {
  /** Number of jobs currently running (queued jobs are not counted). */
  readonly activeJobs: number;
  /** The effective concurrency limit the manager enforces. */
  readonly maxConcurrent: number;
}

export interface NodeInfoProviderOptions {
  /** This node's device ID (SHA-256 cert fingerprint), from its identity. */
  deviceId: string;
  /** The loaded daemon config (only `node`/`executors` are read). */
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
  /** The status-stamped catalog to advertise (built by the daemon). */
  models: ModelInfo[];
}

/** Node's platform coerced into the protocol's supported set. */
export function currentPlatform(): NodeInfo["platform"] {
  const platform = process.platform;
  return platform === "win32" || platform === "darwin" ? platform : "linux";
}

/** The schema's maximum advertised-name length, in characters. */
const MAX_NODE_NAME_LENGTH = 64;

/**
 * Resolves the advertised node name.
 *
 * A configured `node.name` wins verbatim — the operator owns its uniqueness.
 * Otherwise the DEFAULT is the hostname with a short deviceId suffix appended
 * (e.g. `tower-3f9a1c2b`). The suffix is load-bearing, not cosmetic: two
 * machines that share a hostname (a real risk on a home LAN) would otherwise
 * announce the SAME mDNS service name and hit a probe-time collision where the
 * loser's publication dies silently (see the discovery backlog). Disambiguating
 * the name at the source prevents the collision entirely, and doubles as a
 * readable way to tell same-hostname machines apart in `homefleet nodes`.
 *
 * A machine can report an empty hostname, and `NodeNameSchema` requires at
 * least one character, so that case uses a fixed base ("homefleet") — still
 * suffixed, so two no-hostname machines also stay distinct. The base is
 * truncated so base + suffix never exceeds the schema's 64-char cap.
 */
function resolveNodeName(
  configuredName: string | undefined,
  hostnameOverride: string | undefined,
  deviceId: string,
): string {
  if (configuredName !== undefined) {
    return configuredName;
  }
  const rawHostname = hostnameOverride ?? os.hostname();
  const base = rawHostname === "" ? "homefleet" : rawHostname;
  const suffix = deviceId.slice(0, 8);
  // Reserve suffix.length + 1 (the "-" join) so base + suffix fits the cap.
  const maxBase = MAX_NODE_NAME_LENGTH - suffix.length - 1;
  return `${base.slice(0, maxBase)}-${suffix}`;
}

/**
 * Builds the `() => NodeInfo` provider the daemon assembly injects wherever
 * a self-profile is needed.
 *
 * Roles are DERIVED from the configured executors, one honest mapping each:
 * `command` -> "execution" (the node runs command jobs), `agent` ->
 * "inference" (the node runs recon/agent jobs, which are inference work),
 * `write` -> "inference" (write jobs are the same agentic-inference work,
 * pointed at code-writing). A role implied by two executors (agent + write)
 * is advertised once. An agent or write executor does NOT imply the
 * "execution" role: a node with only those is inference-only — it accepts
 * no plain command jobs.
 *
 * Every call validates its output with `NodeInfoSchema.parse` — fail closed:
 * a bad config value or hostname can never emit an invalid profile to peers.
 * Validation ALSO runs once eagerly inside this factory (see below), so a
 * deterministically-invalid profile fails daemon assembly at startup with a
 * clear zod error instead of surfacing per `hello`.
 */
export function createNodeInfoProvider(
  options: NodeInfoProviderOptions,
): () => NodeInfo {
  const { deviceId, config, daemonVersion, jobs, models } = options;
  const name = resolveNodeName(config.node.name, options.hostname, deviceId);

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
  if (config.executors.write !== undefined) {
    executors.push("write");
    // agent + write both imply "inference"; a role is advertised only once.
    if (!roles.includes("inference")) {
      roles.push("inference");
    }
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

  const build = (): NodeInfo =>
    NodeInfoSchema.parse({
      deviceId,
      name,
      daemonVersion,
      protocolVersion: HFP_PROTOCOL_VERSION,
      platform,
      roles,
      executors,
      models,
      hardware,
      // See {@link NodeInfoProviderOptions.jobs} for the 1/0 default.
      maxConcurrentJobs: jobs?.maxConcurrent ?? 1,
      activeJobs: jobs?.activeJobs ?? 0,
    } satisfies NodeInfo);

  // Eager validation: every realistically-failable field (name, versions,
  // models) is STATIC, so an invalid profile is invalid deterministically
  // forever — better to fail assembly right here, at startup, than to have
  // every later `hello` throw mid-handshake (and, in pairing, after trust
  // was already granted). The per-call parse above stays as belt-and-
  // suspenders for the live fields.
  build();
  return build;
}
