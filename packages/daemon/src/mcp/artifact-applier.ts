/**
 * Delegator-side artifact fetch-and-apply plumbing (v0.2 Task 11): the
 * `applyArtifact` collaborator `job_result`'s lazy apply drives. Owns
 * everything the MCP tool layer should not touch — the temp download dir,
 * the empty hooks dir handed to git, the header integrity check, and the
 * {@link applyWriteArtifact} call — so tools.ts stays free of fs/git
 * plumbing and tests can fake this one seam.
 *
 * Trust chain: `fetchJobArtifact` streams the bundle over the mTLS-pinned
 * connection and returns the worker's `x-homefleet-head-commit` header; that
 * header MUST equal the JobResult artifact's claimed `headCommit` before the
 * apply gate even runs (a worker whose download disagrees with its own
 * result is refused outright). `applyWriteArtifact` then re-verifies
 * everything against the bundle itself — see artifact-apply.ts for the full
 * gate. The TEST-SEAM-ONLY `testHookBeforeFetch` field is never set here
 * (pinned by artifact-applier.test.ts).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WriteArtifact } from "@homefleet/protocol";
import type { HfpTarget } from "../transport/client.js";
import { ApplyError, applyWriteArtifact } from "../workspace/artifact-apply.js";

/**
 * The one HfpClient method this module needs (HfpClient satisfies it
 * structurally). Kept narrow so tests fake the download without a network.
 */
export interface ArtifactFetchClient {
  fetchJobArtifact(
    target: HfpTarget,
    jobId: string,
    destPath: string,
    options: { maxBytes: number },
  ): Promise<{ headCommit: string }>;
}

/** What `job_result` hands the applier for one write job's artifact. */
export interface ApplyDelegatedArtifactInput {
  /** The worker the job ran on (route from the delegation registry). */
  target: HfpTarget;
  jobId: string;
  /** The claim from the JobResult (re-verified downstream, never trusted). */
  artifact: WriteArtifact;
  /** This daemon's OWN local repo path for the job's repoId. */
  repoPath: string;
}

/**
 * The applier function shape the MCP tools consume. Resolves with the
 * applied branch name; rejects on any fetch or apply refusal (the caller
 * turns the rejection into `artifactStatus: "failed"` + reason — never a
 * tool error, the job result itself is still valid).
 */
export type ApplyDelegatedArtifactFn = (
  input: ApplyDelegatedArtifactInput,
) => Promise<{ branchName: string }>;

export interface ArtifactApplierOptions {
  client: ArtifactFetchClient;
  /**
   * Byte cap on the downloaded bundle — `config.workspace.maxBundleBytes`,
   * the same cap the worker side puts on inbound sync bundles.
   */
  maxBundleBytes: number;
}

/**
 * Builds the production applier: download to a fresh temp dir, check the
 * header tip against the artifact's claim, apply into the source repo, and
 * always remove the temp dir (bundle + hooks dir) on the way out.
 */
export function createArtifactApplier(
  options: ArtifactApplierOptions,
): ApplyDelegatedArtifactFn {
  return async ({ target, jobId, artifact, repoPath }) => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "homefleet-artifact-in-"),
    );
    try {
      const bundlePath = path.join(tempDir, "artifact.bundle");
      // An existing, EMPTY dir: pinned as core.hooksPath for every git the
      // apply gate runs, so fetched content can never execute a hook.
      const hooksPathDir = path.join(tempDir, "no-hooks");
      await mkdir(hooksPathDir);
      const { headCommit } = await options.client.fetchJobArtifact(
        target,
        jobId,
        bundlePath,
        { maxBytes: options.maxBundleBytes },
      );
      if (headCommit !== artifact.headCommit) {
        // Typed like every other apply refusal (the download's advertised
        // tip disagrees with the artifact's claim = REF_MISMATCH), so the
        // MCP surface renders the uniform "CODE: message" reason.
        throw new ApplyError(
          "REF_MISMATCH",
          `the worker's artifact download claims head ${headCommit} but the ` +
            `job result claims ${artifact.headCommit}; refusing to apply an ` +
            "artifact the worker cannot describe consistently",
        );
      }
      // NOTE: `testHookBeforeFetch` (TEST SEAM ONLY) is deliberately absent.
      return await applyWriteArtifact({
        sourceRepoPath: repoPath,
        artifact,
        bundlePath,
        hooksPathDir,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
  };
}
