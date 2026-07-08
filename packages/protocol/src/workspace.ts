/**
 * Workspace-sync wire messages (M7, ADR-0005). The binary bundle body does NOT
 * travel in these JSON schemas — it streams as an `application/octet-stream`
 * request body, with `repoId` and `headCommit` carried in request headers (see
 * docs/rfc/hfp-v0.md, "Workspace sync"). These schemas cover the small JSON
 * messages: the have-tip query/response and the upload's JSON result.
 */
import { z } from "zod";

/** A 40-char lowercase hex commit hash (matches `WorkspaceRef.headCommit`). */
export const CommitHashSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase hex commit hash");
export type CommitHash = z.infer<typeof CommitHashSchema>;

/** Repo identity on the wire. Opaque string; the worker hashes it for storage. */
export const RepoIdSchema = z.string().min(1).max(1024);
export type RepoId = z.infer<typeof RepoIdSchema>;

/**
 * `POST /hfp/v0/workspace/have` — the delegator asks the worker which commit it
 * already has for `repoId`, so it can build a full or incremental bundle.
 */
export const HaveTipRequestSchema = z.object({
  repoId: RepoIdSchema,
});
export type HaveTipRequest = z.infer<typeof HaveTipRequestSchema>;

/**
 * `headCommit` is the worker's current known commit for the repo, or `null`
 * when it has never been synced. A non-allowlisted repo is NOT reported as
 * `null`; it is an HFP error response (`WORKSPACE_UNAVAILABLE`) so the
 * delegator learns the repo is not accepted rather than mistaking it for
 * "never synced".
 */
export const HaveTipResponseSchema = z.object({
  headCommit: CommitHashSchema.nullable(),
});
export type HaveTipResponse = z.infer<typeof HaveTipResponseSchema>;

/**
 * JSON result of a successful `POST /hfp/v0/workspace/bundle` upload. Echoes
 * the head the worker now has for the repo (equals the uploaded `headCommit`).
 */
export const BundleUploadResponseSchema = z.object({
  ok: z.literal(true),
  headCommit: CommitHashSchema,
});
export type BundleUploadResponse = z.infer<typeof BundleUploadResponseSchema>;
