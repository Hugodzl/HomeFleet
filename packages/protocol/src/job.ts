/**
 * Job model: parameters, lifecycle status, stats, and results.
 */
import { z } from "zod";
import { HfpErrorSchema } from "./errors.js";

export const JobIdSchema = z.uuid();
export type JobId = z.infer<typeof JobIdSchema>;

/**
 * Reference to a workspace by repo identity and committed state.
 * Workspace *transfer* (git bundles, ADR-0005) is a later milestone; this is
 * only the reference shape.
 */
export const WorkspaceRefSchema = z.object({
  repoId: z.string(),
  headCommit: z
    .string()
    .regex(
      /^[0-9a-f]{40}$/,
      "headCommit must be a 40-char lowercase hex commit hash",
    ),
});
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

export const JobBudgetsSchema = z.object({
  maxToolCalls: z.int().min(1).max(200).default(50),
  maxWallMs: z.int().min(1000).default(600000),
});
export type JobBudgets = z.infer<typeof JobBudgetsSchema>;

/** Read-only repo analysis performed by a worker's local model. */
export const ReconJobParamsSchema = z.object({
  type: z.literal("recon"),
  workspace: WorkspaceRefSchema,
  prompt: z.string().min(1).max(16384),
  model: z.string().optional(),
  budgets: JobBudgetsSchema.default({ maxToolCalls: 50, maxWallMs: 600000 }),
});
export type ReconJobParams = z.infer<typeof ReconJobParamsSchema>;

/** Allowlisted command execution (tests, builds) in a workspace. */
export const CommandJobParamsSchema = z.object({
  type: z.literal("command"),
  workspace: WorkspaceRefSchema,
  command: z.string(),
  args: z.array(z.string()).default([]),
  timeoutMs: z.int().min(1000).max(3600000).default(600000),
});
export type CommandJobParams = z.infer<typeof CommandJobParamsSchema>;

/**
 * All job parameter shapes, discriminated on `type`.
 *
 * This union is the protocol's extension point: future job types (e.g.
 * model-pool orchestration) are added as new variants here without
 * redesigning the job model.
 */
export const JobParamsSchema = z.discriminatedUnion("type", [
  ReconJobParamsSchema,
  CommandJobParamsSchema,
]);
export type JobParams = z.infer<typeof JobParamsSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const CommandOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  /** `null` when the process was killed by timeout or cancellation. */
  exitCode: z.number().nullable(),
});
export type CommandOutput = z.infer<typeof CommandOutputSchema>;

export const JobStatsSchema = z.object({
  toolCalls: z.int().min(0),
  wallMs: z.int().min(0),
  promptTokens: z.int().optional(),
  completionTokens: z.int().optional(),
});
export type JobStats = z.infer<typeof JobStatsSchema>;

export const JobResultSchema = z.object({
  jobId: JobIdSchema,
  status: JobStatusSchema.refine(
    (status) =>
      status === "succeeded" || status === "failed" || status === "canceled",
    "JobResult status must be terminal (succeeded | failed | canceled)",
  ),
  summary: z.string().optional(),
  output: CommandOutputSchema.optional(),
  stats: JobStatsSchema,
  error: HfpErrorSchema.optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;
