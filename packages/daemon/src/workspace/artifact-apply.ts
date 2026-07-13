/**
 * Delegator-side apply gate for write-job artifacts (v0.2, Task 9).
 *
 * This is the ONLY code that ever writes into the user's actual repository,
 * so every input is treated as hostile — including a JobResult that already
 * passed schema validation upstream (defense in depth: it is re-parsed here).
 *
 * The apply creates REFS ONLY, exclusively under the reserved
 * `refs/heads/homefleet/` namespace. It never touches the working tree, the
 * index, HEAD, or any existing user branch:
 *
 * 1. `WriteArtifactSchema.parse` structurally pins the branch name to
 *    `homefleet/<12 lowercase hex>` BEFORE anything else runs. The refspec
 *    below is built from that parsed value and from nothing else — no other
 *    input ever reaches a refspec.
 * 2. `git bundle list-heads` (header-only, imports NO objects) must advertise
 *    EXACTLY the claimed ref at EXACTLY the claimed head commit, mirroring the
 *    M7 sync-in pre-filter: a "claims X, delivers Y" bundle is refused before
 *    a single object enters the repo.
 * 3. `git bundle verify` requires the bundle's prerequisites (the job's base
 *    commit) to already exist in the source repo — true by construction,
 *    since the job was delegated FROM this repo.
 * 4. The fetch uses a NON-forced refspec (`ref:ref`, no `+`), so git itself
 *    enforces fast-forward-only: an existing diverged ref is rejected by git,
 *    not by our bookkeeping. Every call runs under {@link delegatorConfig}
 *    (hooks neutralized, `ext::` transport refused, no submodule recursion),
 *    so fetched content can never execute anything.
 * 5. AFTER the fetch, the delivered tip is re-read from the source repo and
 *    must equal the claimed head commit — the authoritative backstop that
 *    closes the list-heads -> fetch TOCTOU window (M7's sync-in keeps the
 *    same post-fetch delivered-check; list-heads is only the cheap gate).
 */
import { type WriteArtifact, WriteArtifactSchema } from "@homefleet/protocol";
import {
  COMMIT_HASH_RE,
  DEFAULT_GIT_TIMEOUT_MS,
  delegatorConfig,
  describeGitFailure,
  type GitCommandResult,
  listBundleHeadsDetailed,
  ok,
  runGit,
  verifyBundleDetailed,
  type WorkerGit,
} from "./git.js";

/** Why an apply was refused, as a stable, typed classification. */
export type ApplyErrorCode =
  /** The file is not a usable bundle, or its prerequisites are missing. */
  | "BAD_BUNDLE"
  /** The bundle's advertised refs do not match the artifact's claim. */
  | "REF_MISMATCH"
  /** The target ref exists and does not fast-forward to the artifact head. */
  | "NON_FAST_FORWARD"
  /** git itself failed (spawn error, timeout, abort, unexpected exit). */
  | "GIT_FAILURE";

export class ApplyError extends Error {
  readonly code: ApplyErrorCode;

  constructor(code: ApplyErrorCode, message: string) {
    super(message);
    this.name = "ApplyError";
    this.code = code;
  }
}

export interface ApplyWriteArtifactInput {
  /** The user's real repository (`repos[].path` from config). */
  sourceRepoPath: string;
  /**
   * The claim from the JobResult. Schema-validated upstream, but re-parsed
   * here anyway — this module trusts nothing it did not verify itself.
   */
  artifact: WriteArtifact;
  /** The fetched bundle file (Task 8's `fetchJobArtifact` destPath). */
  bundlePath: string;
  /** An existing, empty directory used as `core.hooksPath` (no hooks). */
  hooksPathDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * TEST SEAM ONLY (mirrors runGit's `binary`/`killGraceMs` seams): awaited
   * after the pre-fetch checks pass and immediately before the fetch, so the
   * TOCTOU regression test can deterministically swap the bundle file in
   * that window. Production callers must never set this.
   */
  testHookBeforeFetch?: () => Promise<void> | void;
}

/** `true` when a git result reflects a kill/timeout/spawn failure, not a verdict. */
function neverRan(result: GitCommandResult): boolean {
  // A killed child (timeout OR abort) settles with `code === null`; a spawn
  // failure also has `code === null` plus `spawnError`.
  return result.timedOut || result.code === null;
}

/**
 * Verifies `bundlePath` against the artifact's claim and fetches its single
 * branch into `sourceRepoPath` under `refs/heads/homefleet/`. Returns the
 * branch name on success; throws {@link ApplyError} on any refusal.
 *
 * Re-applying the same bundle is an idempotent success (the non-forced fetch
 * of an already-current ref is a no-op).
 */
export async function applyWriteArtifact(
  input: ApplyWriteArtifactInput,
): Promise<{ branchName: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  // 1. Structural gate, before any git runs. A hostile branchName (`main`,
  //    `../x`, option-shaped strings, ...) dies here on the schema's
  //    `^homefleet\/[0-9a-f]{12}$` regex.
  const parsed = WriteArtifactSchema.safeParse(input.artifact);
  if (!parsed.success) {
    throw new ApplyError(
      "REF_MISMATCH",
      `write artifact failed schema re-validation: ${parsed.error.message}`,
    );
  }
  const artifact = parsed.data;
  // The ONLY refspec component in this module, built exclusively from the
  // schema-validated branch name above.
  const targetRef = `refs/heads/${artifact.branchName}`;

  // The delegator has no WorkerGit, but the shape fits exactly: the source
  // repo plays `repoDir`, and the same hooks pin applies. Reusing the M7
  // helpers (rather than reimplementing them) keeps one bundle-inspection
  // code path for both sides.
  const git: WorkerGit = {
    repoDir: input.sourceRepoPath,
    hooksPath: input.hooksPathDir,
    timeoutMs,
    signal: input.signal,
  };

  // Wraps a stage verdict: a git that was killed (timeout/abort) or never
  // spawned must surface as GIT_FAILURE, never as a BAD_BUNDLE verdict on a
  // bundle that was never really inspected.
  const verdictOrGitFailure = (
    result: GitCommandResult,
    verdict: ApplyError,
  ): ApplyError =>
    input.signal?.aborted || neverRan(result)
      ? new ApplyError(
          "GIT_FAILURE",
          `git was interrupted: ${describeGitFailure(result)}`,
        )
      : verdict;

  // 2. Header-only pre-filter (M7 pattern): refuse BEFORE anything is
  //    fetched. `list-heads` imports no objects. This is the CHEAP gate; the
  //    authoritative check is the post-fetch delivered-tip re-read below.
  const listed = await listBundleHeadsDetailed(git, input.bundlePath);
  const heads = listed.heads;
  if (heads.size === 0) {
    throw verdictOrGitFailure(
      listed.result,
      new ApplyError(
        "BAD_BUNDLE",
        `${input.bundlePath} is not a readable git bundle (no advertised refs)`,
      ),
    );
  }
  if (heads.size !== 1) {
    throw new ApplyError(
      "REF_MISMATCH",
      `bundle advertises ${heads.size} refs; expected exactly ${targetRef}`,
    );
  }
  const advertisedTip = heads.get(targetRef);
  if (advertisedTip === undefined) {
    throw new ApplyError(
      "REF_MISMATCH",
      `bundle's single ref is not ${targetRef}`,
    );
  }
  if (advertisedTip !== artifact.headCommit) {
    throw new ApplyError(
      "REF_MISMATCH",
      `bundle advertises ${targetRef} at ${advertisedTip}, ` +
        `but the artifact claims ${artifact.headCommit}`,
    );
  }

  // 3. Structural + prerequisite check: the bundle's recorded base must
  //    already exist in the source repo (it does by construction — the job
  //    was delegated from this repo at that commit).
  const verified = await verifyBundleDetailed(git, input.bundlePath);
  if (!ok(verified)) {
    throw verdictOrGitFailure(
      verified,
      new ApplyError(
        "BAD_BUNDLE",
        `git bundle verify refused ${input.bundlePath} ` +
          "(corrupt bundle or missing prerequisite commit)",
      ),
    );
  }

  await input.testHookBeforeFetch?.();

  // 4. The fetch. NON-forced refspec (no `+`), so git enforces
  //    fast-forward-only on an existing ref. Ref updates in git are atomic
  //    (lockfile + rename per ref transaction), so a kill/abort mid-fetch
  //    leaves either no ref update or the completed one — never a partial
  //    ref; at worst some unreferenced objects that gc reclaims.
  //    Deliberately NOT `--quiet`: quiet suppresses the per-ref report,
  //    including the `! [rejected] ... (non-fast-forward)` line this code
  //    classifies on (verified against real git: quiet non-ff = exit 1 with
  //    EMPTY stderr, indistinguishable from other failures).
  //    `--end-of-options` pins the bundle path and refspec as positionals.
  const fetched = await runGit(
    [
      "fetch",
      "--no-tags",
      "--end-of-options",
      input.bundlePath,
      `${targetRef}:${targetRef}`,
    ],
    {
      cwd: input.sourceRepoPath,
      timeoutMs,
      config: delegatorConfig(input.hooksPathDir),
      signal: input.signal,
    },
  );
  if (!ok(fetched)) {
    // A kill (timeout/abort) settles with code === null; classify it before
    // reading stderr, which a killed git may have left mid-sentence.
    if (input.signal?.aborted || neverRan(fetched)) {
      throw new ApplyError(
        "GIT_FAILURE",
        `git fetch was interrupted: ${describeGitFailure(fetched)}`,
      );
    }
    // runGit pins LC_ALL=C, so git's rejection wording is stable.
    if (/non-fast-forward|\[rejected\]/.test(fetched.stderr)) {
      throw new ApplyError(
        "NON_FAST_FORWARD",
        `${targetRef} already exists and does not fast-forward to ` +
          `${artifact.headCommit}`,
      );
    }
    throw new ApplyError(
      "GIT_FAILURE",
      `git fetch failed: ${describeGitFailure(fetched)}`,
    );
  }

  // 5. Authoritative backstop (closes the list-heads -> fetch TOCTOU): the
  //    file could have been swapped for a same-ref-name bundle at a different
  //    tip after the pre-filter read it. Re-read what the fetch actually
  //    delivered; anything but the claimed head is refused. The damage is
  //    already capped to the reserved namespace by the schema-pinned refspec,
  //    but success must never be reported for an unverified tip.
  const delivered = await runGit(
    ["rev-parse", "--verify", "--quiet", targetRef],
    {
      cwd: input.sourceRepoPath,
      timeoutMs,
      config: delegatorConfig(input.hooksPathDir),
      signal: input.signal,
    },
  );
  const deliveredTip = delivered.stdout.trim();
  if (!ok(delivered) || !COMMIT_HASH_RE.test(deliveredTip)) {
    throw new ApplyError(
      "GIT_FAILURE",
      `could not re-read ${targetRef} after the fetch: ` +
        describeGitFailure(delivered),
    );
  }
  if (deliveredTip !== artifact.headCommit) {
    throw new ApplyError(
      "REF_MISMATCH",
      `post-fetch check: ${targetRef} WAS advanced to ${deliveredTip}, which ` +
        `differs from the claimed ${artifact.headCommit} (bundle changed ` +
        "between verification and fetch). The write stayed inside the " +
        "reserved refs/heads/homefleet/ namespace, but the branch should be " +
        "inspected or deleted, not reviewed as the job's result.",
    );
  }

  return { branchName: artifact.branchName };
}
