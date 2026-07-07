/**
 * Node identity and capabilities: what a daemon advertises about itself
 * during `hello` and pairing.
 */
import { z } from "zod";

/** SHA-256 fingerprint of the node's self-signed certificate (ADR-0004). */
export const DeviceIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "device ID must be 64 lowercase hex chars (SHA-256 cert fingerprint)",
  );
export type DeviceId = z.infer<typeof DeviceIdSchema>;

/** Light semver check — enough for v0 version strings like "0.1.0". */
export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a semver string (X.Y.Z)");

/**
 * Human-readable node name, 1-64 chars. Shared by `NodeInfo` and
 * `DiscoveryAnnouncement` so the two cannot drift.
 */
export const NodeNameSchema = z.string().min(1).max(64);

export const GpuInfoSchema = z.object({
  name: z.string(),
  vramBytes: z.int().min(0).optional(),
});
export type GpuInfo = z.infer<typeof GpuInfoSchema>;

/** A model reachable via the node's OpenAI-compatible endpoint(s). */
export const ModelInfoSchema = z.object({
  id: z.string(),
  contextWindow: z.int().min(1).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const NodeRoleSchema = z.enum(["inference", "execution"]);
export type NodeRole = z.infer<typeof NodeRoleSchema>;

export const ExecutorKindSchema = z.enum(["command", "agent"]);
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;

export const NodeInfoSchema = z.object({
  deviceId: DeviceIdSchema,
  name: NodeNameSchema,
  daemonVersion: SemverSchema,
  protocolVersion: SemverSchema,
  platform: z.enum(["win32", "linux", "darwin"]),
  roles: z.array(NodeRoleSchema),
  executors: z.array(ExecutorKindSchema),
  models: z.array(ModelInfoSchema),
  hardware: z.object({
    cpu: z.string(),
    ramBytes: z.int().min(0),
    gpus: z.array(GpuInfoSchema),
  }),
  maxConcurrentJobs: z.int().min(1),
  activeJobs: z.int().min(0),
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;
