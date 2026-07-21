/**
 * Job model: parameters, lifecycle status, stats, and results.
 */
import { z } from "zod";
import { HfpErrorSchema } from "./errors.js";
import { CommitHashSchema } from "./workspace.js";

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
export const JobTypeSchema = z.enum(["recon", "command", "write"]);
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

export const WriteBudgetsSchema = z.object({
  // Write tasks default to double recon's tool budget: edits burn a read+write
  // pair per file touched. Wall default matches recon (10 min).
  maxToolCalls: z.int().min(1).max(200).default(100),
  maxWallMs: z.int().min(1000).max(3600000).default(600000),
});
export type WriteBudgets = z.infer<typeof WriteBudgetsSchema>;

/** Optional post-commit verification run (report-only; never fails the job). */
export const VerifyCommandSchema = z.object({
  /** Must name an entry in the worker's command allowlist. */
  name: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type VerifyCommand = z.infer<typeof VerifyCommandSchema>;

/** Code-writing task executed by the worker's local model in a workspace. */
export const WriteJobParamsSchema = z.object({
  type: z.literal("write"),
  workspace: WorkspaceRefSchema,
  /** Optional model id to target; worker's default if absent. */
  model: z.string().optional(),
  instructions: z.string().min(1).max(16384),
  /** Advisory starting points only — never an access restriction. */
  pathHints: z.array(z.string().min(1).max(1024)).max(32).optional(),
  verifyCommand: VerifyCommandSchema.optional(),
  // prefault({}) parses the empty object, so the field-level defaults above
  // stay the single source of truth for budget values.
  budgets: WriteBudgetsSchema.prefault({}),
});
export type WriteJobParams = z.infer<typeof WriteJobParamsSchema>;

/**
 * The ref namespace reserved for write-job result branches, on both the
 * worker (bundle-out) and delegator (fetch-in) sides.
 */
export const WRITE_BRANCH_PREFIX = "homefleet/";

/**
 * Last 12 hex of the job UUID — its final hyphen-group, so no hyphen
 * stripping is needed. The LAST 12, not the first: `JobIdSchema` admits
 * UUID v1–v8, and a v7's leading 48 bits are a millisecond timestamp, so
 * two same-ms jobs would deterministically collide on the first 12 hex.
 * The last 12 are random in both v4 and v7.
 */
export function jobId12(jobId: JobId): string {
  return jobId.slice(-12);
}

/** The branch a write job's artifact is delivered on: `homefleet/<jobId12>`. */
export function writeBranchName(jobId: JobId): string {
  return `${WRITE_BRANCH_PREFIX}${jobId12(jobId)}`;
}

export const WriteBranchNameSchema = z
  .string()
  .regex(
    /^homefleet\/[0-9a-f]{12}$/,
    "must be homefleet/ followed by exactly 12 lowercase hex chars",
  );
export type WriteBranchName = z.infer<typeof WriteBranchNameSchema>;

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
  WriteJobParamsSchema,
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

export const DiffStatSchema = z.object({
  filesChanged: z.int().min(0),
  insertions: z.int().min(0),
  deletions: z.int().min(0),
});
export type DiffStat = z.infer<typeof DiffStatSchema>;

/**
 * The reviewable outcome of a write job: one branch, one commit, delivered
 * as a git bundle via `GET /jobs/{id}/artifact`. `headCommit` is the
 * integrity anchor — the fetched bundle's tip MUST equal it.
 */
export const WriteArtifactSchema = z.object({
  branchName: WriteBranchNameSchema,
  baseCommit: CommitHashSchema,
  headCommit: CommitHashSchema,
  diffStat: DiffStatSchema,
  commitMessage: z.string().min(1).max(4096),
});
export type WriteArtifact = z.infer<typeof WriteArtifactSchema>;

/** Outcome of the requested verify command (report-only). */
export const VerifyReportSchema = z.object({
  name: z.string().min(1),
  args: z.array(z.string()),
  /** `null` when the process was killed by timeout or cancellation. */
  exitCode: z.int().nullable(),
  outputTail: z.string(),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

export const JobResultSchema = z
  .object({
    jobId: JobIdSchema,
    type: JobTypeSchema,
    status: TerminalJobStatusSchema,
    summary: z.string().optional(),
    output: CommandOutputSchema.optional(),
    stats: JobStatsSchema,
    error: HfpErrorSchema.optional(),
    /** Write jobs only. `null` = the job finished without producing changes. */
    artifact: WriteArtifactSchema.nullable().optional(),
    /** Write jobs only; present iff `verifyCommand` was requested and ran. */
    verify: VerifyReportSchema.optional(),
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
    if (result.artifact !== undefined && result.type !== "write") {
      ctx.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "artifact (even null) is only allowed on write results",
      });
    }
    if (result.verify !== undefined && result.type !== "write") {
      ctx.addIssue({
        code: "custom",
        path: ["verify"],
        message: "verify is only allowed on write results",
      });
    }
    // Failed/canceled write jobs discard their worktree; committed work is
    // never delivered from a non-succeeded job.
    if (
      result.status !== "succeeded" &&
      result.artifact !== undefined &&
      result.artifact !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact"],
        message: `artifact must be absent or null when status is ${result.status}`,
      });
    }
    // A succeeded write result must state its outcome explicitly: `null` for
    // "no changes", a full artifact otherwise. An ABSENT artifact would be
    // indistinguishable from "no changes", letting a finalize bug silently
    // drop completed work.
    if (
      result.type === "write" &&
      result.status === "succeeded" &&
      result.artifact === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact"],
        message:
          "artifact (or explicit null) is required on succeeded write results",
      });
    }
  });
export type JobResult = z.infer<typeof JobResultSchema>;
