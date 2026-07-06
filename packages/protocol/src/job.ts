/**
 * Job model: parameters, lifecycle status, stats, and results.
 */
import { z } from "zod";
import { HfpErrorSchema } from "./errors.js";

/**
 * Canonical lowercase RFC 4122 UUID (crypto.randomUUID() already emits one).
 * The version nibble (`[1-8]`) and variant nibble (`[89ab]`) are enforced, so
 * shapes like the nil UUID or a version-0 UUID are rejected.
 */
export const JobIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "jobId must be a lowercase RFC 4122 UUID",
  );
export type JobId = z.infer<typeof JobIdSchema>;

/**
 * All job types defined by this protocol version. Kept in sync with the
 * `JobParamsSchema` union: adding a job type means adding an entry here.
 */
export const JobTypeSchema = z.enum(["recon", "command"]);
export type JobType = z.infer<typeof JobTypeSchema>;

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
  maxWallMs: z.int().min(1000).max(3600000).default(600000),
});
export type JobBudgets = z.infer<typeof JobBudgetsSchema>;

/** Read-only repo analysis performed by a worker's local model. */
export const ReconJobParamsSchema = z.object({
  type: z.literal("recon"),
  workspace: WorkspaceRefSchema,
  prompt: z.string().min(1).max(16384),
  model: z.string().optional(),
  // prefault({}) parses the empty object, so the field-level defaults above
  // stay the single source of truth for budget values.
  budgets: JobBudgetsSchema.prefault({}),
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
 * This union is the protocol's extension point: a future job type (e.g.
 * model-pool orchestration) is added as a new params schema, a new entry in
 * this union, and a new entry in `JobTypeSchema` — without redesigning the
 * job model.
 */
export const JobParamsSchema = z.discriminatedUnion("type", [
  ReconJobParamsSchema,
  CommandJobParamsSchema,
]);
export type JobParams = z.infer<typeof JobParamsSchema>;

/**
 * Compile-time guard: `JobTypeSchema` and the `JobParamsSchema` union must
 * declare exactly the same set of job types. If a variant is added to either
 * side without the other, this assignment stops typechecking.
 */
const _jobTypesInSync: JobParams["type"] extends JobType
  ? JobType extends JobParams["type"]
    ? true
    : never
  : never = true;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** The statuses a job can never leave once reached. */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
] as const;

export const TerminalJobStatusSchema = z.enum(TERMINAL_JOB_STATUSES);
export type TerminalJobStatus = z.infer<typeof TerminalJobStatusSchema>;

export const isTerminalJobStatus = (
  status: JobStatus,
): status is TerminalJobStatus =>
  (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);

export const CommandOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  /** `null` when the process was killed by timeout or cancellation. */
  exitCode: z.int().nullable(),
});
export type CommandOutput = z.infer<typeof CommandOutputSchema>;

export const JobStatsSchema = z.object({
  toolCalls: z.int().min(0),
  wallMs: z.int().min(0),
  promptTokens: z.int().min(0).optional(),
  completionTokens: z.int().min(0).optional(),
});
export type JobStats = z.infer<typeof JobStatsSchema>;

export const JobResultSchema = z
  .object({
    jobId: JobIdSchema,
    type: JobTypeSchema,
    status: TerminalJobStatusSchema,
    summary: z.string().optional(),
    output: CommandOutputSchema.optional(),
    stats: JobStatsSchema,
    error: HfpErrorSchema.optional(),
  })
  .superRefine((result, ctx) => {
    if (result.status === "failed" && result.error === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required when status is failed",
      });
    }
    if (result.status === "succeeded" && result.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error must be absent when status is succeeded",
      });
    }
    // "canceled" MAY carry an error (typically code CANCELED).
  });
export type JobResult = z.infer<typeof JobResultSchema>;
