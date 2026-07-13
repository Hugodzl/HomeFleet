/**
 * Worker-side workspace store + resolver (M7, ADR-0005).
 *
 * Turns received git bundles into materialized checkouts a job executor can
 * read. On-disk layout (kept deliberately short — Windows MAX_PATH (260)
 * defense-in-depth; a checkout dir sits exactly 37 chars past the cache root,
 * so checkout file paths rarely approach the limit regardless of git's
 * `core.longpaths` mode):
 *
 *   <cacheDir>\<repoKey>\repo.git        bare cache repo
 *   <cacheDir>\<repoKey>\co\<commitKey>  checkout worktrees (cached, LRU)
 *   <cacheDir>\<repoKey>\jobs\<jobId12>  ephemeral write-job worktrees
 *   <cacheDir>\.no-hooks                 empty hooks dir (disables hooks)
 *
 * where `repoKey` is the first 16 hex chars of SHA-256(repoId), `commitKey`
 * is the first 16 hex chars of the 40-hex commit, and `jobId12` is the last
 * 12 hex of the write job's UUID. Four security invariants:
 *
 * 1. **Allowlist, fail-closed.** Only repoIds in `allowedRepoIds` are accepted.
 *    An empty allowlist accepts nothing. A non-allowlisted repoId is rejected
 *    BEFORE any directory is created, so a probe leaves no trace on disk.
 * 2. **repoId never forms a path.** The per-repo cache directory is named by
 *    a truncated SHA-256 of the repoId (hex only), so a repoId like `../../x`,
 *    `C:\evil`, or `..\\..` cannot escape the cache root — traversal is
 *    structurally impossible, not filtered. 16 hex chars (2^64) are enough:
 *    repoIds are operator-configured allowlist entries, not attacker-chosen
 *    names. The repoKey is the per-repo identity EVERYWHERE — dir name, lock
 *    key, checkout-map key prefix — so even a colliding pair of repoIds would
 *    merely share one cache dir with all its git ops still serialized through
 *    the one per-key lock, never interleaved.
 * 3. **Only check out what was delivered.** `applyBundle` verifies the bundle,
 *    rejects (before importing any object) a bundle whose advertised `HEAD`
 *    ref does not match the claimed `headCommit`, fetches into a scratch ref,
 *    and refuses to advance the repo's tip unless the fetched commit equals the
 *    claimed `headCommit`. The resolver refuses to materialize a commit the
 *    cache does not actually contain.
 * 4. **Verify before reuse.** A checkout dir's truncated name no longer proves
 *    which commit it holds, so the resolver re-checks an existing worktree's
 *    HEAD against the requested FULL 40-hex commit before handing it out. An
 *    unpinned mismatch is removed and re-materialized; a PINNED mismatch (a
 *    running job is reading that dir — reachable if a paired peer grinds two
 *    of its own commits to a shared 16-hex prefix, ~2^32 work) fails the
 *    resolve instead of yanking the dir out from under the job: correctness
 *    over availability.
 *
 * Git is not concurrency-safe on one repository, so every operation for a given
 * repoId is serialized through a per-repo promise chain: two syncs, or a sync
 * racing a job's checkout, for the same repo can never interleave.
 *
 * Peer-driven growth is bounded on two axes, both under the per-repo lock:
 * - Materialized checkout COUNT is capped (`maxCachedCheckouts`, least-recently
 *   -used evicted, evictions logged).
 * - Bare object-store accretion is reclaimed by `git gc --prune=now` every
 *   `gcAfterFetches` fetches per repo — an unbundle imports objects even for a
 *   later-rejected upload, so periodic gc keeps `repo.git` from growing without
 *   limit (the tip ref and live worktrees are the only anchors, so in-use
 *   checkouts are never pruned).
 * These bound checkout count and object-store size, respectively; they are not
 * a hard total-disk guarantee.
 *
 * WRITE-JOB worktrees (`resolve(ref, { write: { jobId } })`) are deliberately
 * OUTSIDE all of the above cache machinery: each write job gets a dedicated
 * worktree under `<repoRoot>\jobs\<jobId12>` that no other job ever shares,
 * is never entered into the checkout map (so it neither counts against
 * `maxCachedCheckouts` nor can be an eviction victim), and is torn down when
 * the job's handle is released. Their lifetime is bounded by the daemon
 * process: {@link init} purges every `jobs` dir, because an in-flight write
 * job never survives a restart — anything left there is garbage by definition.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  type HfpError,
  type JobId,
  jobId12,
  type WorkspaceRef,
  type WriteArtifact,
  writeBranchName,
} from "@homefleet/protocol";
import type { WorkspaceResolver } from "../jobs/job-manager.js";
import {
  addWorktree,
  COMMIT_HASH_RE,
  commitAllInWorktree,
  commitPresent,
  createWorkerBundle,
  type DiffStatCounts,
  deleteRef,
  describeGitFailure,
  diffStat,
  fetchBundleHead,
  GitError,
  gc,
  initBareRepo,
  listBundleHeads,
  ok,
  removeWorktree,
  revParse,
  updateRef,
  verifyBundle,
  type WorkerGit,
  worktreeHead,
} from "./git.js";
import {
  isPopulatedCheckout,
  pathExists,
  purgeWriteWorktrees,
  scanExistingCheckouts,
  type WorkspaceInitContext,
} from "./workspace-init.js";

/** The single ref the worker maintains per repo: its current known head. */
const TIP_REF = "refs/homefleet/tip";
/** Scratch ref a bundle fetch lands in before it is validated and promoted. */
const INCOMING_REF = "refs/homefleet/incoming";
/** The ref name our bundles advertise their head under (`git bundle create HEAD`). */
const BUNDLE_HEAD_REF = "HEAD";
/** Author/committer name on every write-job commit (design doc §2, "Commit"). */
const WRITE_AUTHOR_NAME = "HomeFleet Worker";

export type WorkspaceErrorCode =
  | "REPO_NOT_ALLOWED"
  | "BUNDLE_INVALID"
  | "COMMIT_NOT_DELIVERED"
  | "NOT_SYNCED"
  | "GIT_FAILED"
  /**
   * A write resolve for a jobId whose worktree is already live (materialized
   * or mid-materialization, not yet released). Maps to `INVALID_REQUEST` on
   * the wire: the request is invalid given the job's current state.
   */
  | "WRITE_IN_PROGRESS"
  /**
   * `finalizeWriteJob` was called for a jobId with no live write worktree
   * (never resolved, resolve failed, or already released). Reaching this
   * means the write-job lifecycle (resolve -> execute -> finalize ->
   * release) was broken by the caller; the WriteExecutor surfaces it as a
   * failed/INTERNAL result. Maps to `INVALID_REQUEST` on the wire.
   */
  | "NO_WRITE_WORKSPACE";

/** A typed workspace failure the sync routes/resolver map to HFP errors. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details?: Record<string, string | null>;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    details?: Record<string, string | null>,
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }

  /** Maps to a wire {@link HfpError} for the workspace HTTP routes. */
  toHfpError(): HfpError {
    const code =
      this.code === "REPO_NOT_ALLOWED" || this.code === "NOT_SYNCED"
        ? "WORKSPACE_UNAVAILABLE"
        : this.code === "GIT_FAILED"
          ? "INTERNAL"
          : "INVALID_REQUEST";
    return {
      code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export interface WorkspaceStoreOptions {
  /** Absolute cache root; per-repo dirs live under it, named by {@link repoKey}. */
  cacheDir: string;
  /** Fail-closed allowlist. Empty = accept nothing. */
  allowedRepoIds: string[];
  maxBundleBytes: number;
  maxCachedCheckouts: number;
  /** Fetches per repo between `git gc --prune=now` runs on its bare cache. */
  gcAfterFetches: number;
  gitTimeoutMs: number;
  /** Diagnostic sink (evictions, git failures); defaults to no-op. */
  logger?: (message: string) => void;
}

/** A materialized checkout tracked for LRU eviction. */
interface CheckoutEntry {
  repoKey: string;
  /**
   * The checkout's dir name (truncated commit key), NOT the full commit — the
   * full commit is not recoverable from a dir found on restart. Identity for
   * map keys and eviction only; content correctness is enforced by the
   * resolver's verify-on-reuse against the requested full commit.
   */
  commitKey: string;
  dir: string;
  /** Monotonic last-use tick; higher = more recently used. */
  usedAt: number;
  /**
   * Number of live resolve handles reading this checkout. A checkout with
   * `refcount > 0` is PINNED: eviction skips it so a running job's checkout is
   * never `git worktree remove`d out from under it. Decremented (floored at 0)
   * when a handle's `release` is called.
   */
  refcount: number;
}

/** Options for {@link WorkspaceStore.resolve}. Absent = read-mode (cached checkout). */
export interface ResolveOptions {
  /**
   * Write mode: instead of a shared cached checkout, materialize a DEDICATED
   * ephemeral worktree for this write job at `<repoRoot>/jobs/<jobId12>`,
   * detached at `ref.headCommit`. The job owns the dir exclusively until its
   * handle is released, which removes the worktree from disk. At most one
   * live write worktree may exist per jobId ({@link WorkspaceError}
   * `WRITE_IN_PROGRESS` otherwise).
   */
  write?: { jobId: JobId };
}

/**
 * A live write-job worktree, keyed by jobId in {@link WorkspaceStore}'s
 * registry. Registered BEFORE materialization (so a concurrent duplicate
 * resolve for the same jobId is rejected without a race) and deregistered on
 * release — or immediately, if the materializing resolve fails.
 *
 * Task 6 dependency: the daemon's finalize closure can only see the jobId, so
 * this entry is the bridge from jobId to everything artifact-bundle creation
 * needs — the worktree dir, the repo it belongs to, and `baseCommit` (the
 * `ref.headCommit` the job started from, i.e. the bundle's `--not`
 * prerequisite). See {@link WorkspaceStore.writeJobWorkspace}.
 */
interface WriteWorkspaceEntry {
  repoKey: string;
  dir: string;
  baseCommit: string;
}

/**
 * Non-null result of {@link WorkspaceStore.finalizeWriteJob}: the wire
 * artifact for the executor's JobResult, plus everything ArtifactStore
 * registration needs — so the assembly's finalize closure never re-derives
 * the bundle path or races a stat outside the repo lock.
 */
export interface FinalizedWriteJob {
  artifact: WriteArtifact;
  /** Absolute path of the bundle: `<repoRoot>/jobs/<jobId12>.bundle`. */
  bundlePath: string;
  /** Bundle size in bytes, measured under the repo lock after creation. */
  byteLength: number;
}

export class WorkspaceStore {
  private readonly cacheDir: string;
  private readonly allowed: ReadonlySet<string>;
  private readonly maxBundleBytesValue: number;
  private readonly maxCachedCheckouts: number;
  private readonly gcAfterFetches: number;
  private readonly gitTimeoutMs: number;
  private readonly log: (message: string) => void;

  /** Per-repo (by {@link repoKey}) promise chain: serializes its git ops. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Live checkouts, keyed `${repoKey}:${commitKey}`, for LRU eviction. */
  private readonly checkouts = new Map<string, CheckoutEntry>();
  /**
   * Live write-job worktrees, keyed by jobId. Entirely separate from
   * {@link checkouts}: a write worktree is never cached, counted, or evicted.
   */
  private readonly writeWorkspaces = new Map<string, WriteWorkspaceEntry>();
  /** Fetches applied per repoKey since its last gc (gc-gating counter). */
  private readonly fetchesSinceGc = new Map<string, number>();
  private useTick = 0;
  private initialized = false;

  /**
   * Cancels in-flight worker-side git. Its signal is threaded into every
   * {@link WorkerGit} this store builds (and into {@link initBareRepo}), so
   * {@link stop} can abort a running fetch/checkout/gc immediately rather than
   * letting it run to `gitTimeoutMs`.
   */
  private readonly abort = new AbortController();
  /** Set by {@link stop}; makes the public entry points fail closed. */
  private stopped = false;

  constructor(options: WorkspaceStoreOptions) {
    this.cacheDir = path.resolve(options.cacheDir);
    this.allowed = new Set(options.allowedRepoIds);
    this.maxBundleBytesValue = options.maxBundleBytes;
    this.maxCachedCheckouts = options.maxCachedCheckouts;
    this.gcAfterFetches = options.gcAfterFetches;
    this.gitTimeoutMs = options.gitTimeoutMs;
    this.log = options.logger ?? (() => {});
  }

  /** Max accepted bundle size (bytes) — the upload route caps the stream here. */
  get maxBundleBytes(): number {
    return this.maxBundleBytesValue;
  }

  /** Whether `repoId` is on the allowlist. */
  isAllowed(repoId: string): boolean {
    return this.allowed.has(repoId);
  }

  /**
   * Prepares the cache root and the empty hooks directory, purges write-job
   * worktrees left by a previous daemon run (an in-flight write job never
   * survives a restart), then registers any checkouts left on disk by a
   * previous daemon run (oldest first) so the retention cap holds across
   * restarts. Idempotent.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.hooksPath(), { recursive: true });
    await purgeWriteWorktrees(this.initContext());
    await this.registerExistingCheckouts();
    this.initialized = true;
  }

  /**
   * The worker's current known commit for `repoId`, or `null` if it has never
   * been synced. Allowlist-gated: a non-allowlisted repoId throws
   * {@link WorkspaceError} `REPO_NOT_ALLOWED` (the route maps it to a clear
   * error so the delegator learns the repo is not accepted).
   */
  async haveTip(repoId: string): Promise<string | null> {
    this.requireNotStopped();
    this.requireAllowed(repoId);
    const rKey = repoKey(repoId);
    return this.withRepoLock(rKey, async () => {
      const repoDir = this.repoDir(rKey);
      if (!(await pathExists(repoDir))) {
        return null;
      }
      return revParse(this.worker(rKey), TIP_REF);
    });
  }

  /**
   * Applies a received bundle for `repoId` claiming to deliver `headCommit`:
   * allowlist check -> verify -> reject-before-fetch if the advertised HEAD
   * mismatches -> fetch into a scratch ref -> confirm the fetched commit equals
   * `headCommit` -> advance the tip -> periodically gc. Serialized per repo.
   *
   * Throws {@link WorkspaceError} on any failure; on rejection the tip is never
   * advanced and no checkout is produced (the cache is left as it was).
   */
  async applyBundle(
    repoId: string,
    bundlePath: string,
    headCommit: string,
  ): Promise<void> {
    this.requireNotStopped();
    this.requireAllowed(repoId);
    if (!COMMIT_HASH_RE.test(headCommit)) {
      throw new WorkspaceError(
        "BUNDLE_INVALID",
        "headCommit must be a 40-char lowercase hex commit hash",
        { headCommit },
      );
    }
    const rKey = repoKey(repoId);
    await this.withRepoLock(rKey, async () => {
      // Normalize the one raw throw on this path: initBareRepo throws GitError
      // (e.g. when a shutdown aborts a first-ever sync), but applyBundle's
      // contract is "throws WorkspaceError on any failure".
      try {
        await this.ensureRepo(rKey);
      } catch (error) {
        if (error instanceof GitError) {
          throw new WorkspaceError(
            "GIT_FAILED",
            `could not initialize cache: ${error.message}`,
            { repoId },
          );
        }
        throw error;
      }
      const worker = this.worker(rKey);

      if (!(await verifyBundle(worker, bundlePath))) {
        throw new WorkspaceError(
          "BUNDLE_INVALID",
          "received bundle failed `git bundle verify` " +
            "(malformed, or its prerequisites are not present)",
          { repoId },
        );
      }

      // Cheap pre-fetch gate: reject a "claims X, advertises Y" bundle from the
      // header alone (list-heads imports NO objects), so the gross-mismatch
      // case never accretes objects in the bare cache. The authoritative
      // post-fetch delivered-check below stays as the backstop.
      const advertised = (await listBundleHeads(worker, bundlePath)).get(
        BUNDLE_HEAD_REF,
      );
      if (advertised !== undefined && advertised !== headCommit) {
        throw new WorkspaceError(
          "COMMIT_NOT_DELIVERED",
          "bundle advertises a head other than the claimed headCommit",
          { repoId, headCommit, advertised },
        );
      }

      const fetched = await fetchBundleHead(worker, bundlePath, INCOMING_REF);
      if (!ok(fetched)) {
        await deleteRef(worker, INCOMING_REF);
        throw new WorkspaceError(
          "BUNDLE_INVALID",
          `could not unbundle received content: ${describeGitFailure(fetched)}`,
          { repoId },
        );
      }

      // The bundle's delivered head MUST equal the claimed headCommit: never
      // advance the tip to — or later check out — a commit the bundle did not
      // actually deliver.
      const delivered = await revParse(worker, INCOMING_REF);
      if (
        delivered !== headCommit ||
        !(await commitPresent(worker, headCommit))
      ) {
        await deleteRef(worker, INCOMING_REF);
        throw new WorkspaceError(
          "COMMIT_NOT_DELIVERED",
          "bundle did not deliver the claimed headCommit",
          { repoId, headCommit, delivered },
        );
      }

      const updated = await updateRef(worker, TIP_REF, headCommit);
      await deleteRef(worker, INCOMING_REF);
      if (!ok(updated)) {
        throw new WorkspaceError(
          "GIT_FAILED",
          `could not advance workspace tip: ${describeGitFailure(updated)}`,
          { repoId },
        );
      }

      // Bound bare object-store growth: the fetch imported objects (and a
      // rejected upload's fetch would have too), so gc unreachable objects
      // every `gcAfterFetches` fetches. Still under the per-repo lock, so gc
      // cannot race a fetch or a checkout; the tip ref + live worktrees anchor
      // everything in use, so nothing needed is pruned.
      await this.maybeGc(rKey, worker);
    });
  }

  /**
   * The {@link WorkspaceResolver} implementation: resolves a `WorkspaceRef` to
   * a release handle — the absolute, materialized checkout directory plus a
   * `release` callback. Fails (throws {@link WorkspaceError}, which the
   * JobManager turns into a terminal `WORKSPACE_UNAVAILABLE`) if the repo is
   * not allowlisted or the commit has not been synced into the cache.
   *
   * Handing out the dir PINS the checkout: its refcount is incremented (under
   * the repo lock, before eviction runs) so a running job's checkout is never
   * evicted out from under it. The returned `release` decrements the refcount
   * (floored at 0); it is guarded so a double-call is a harmless no-op.
   *
   * With `options.write` set, none of the above cache machinery applies: the
   * resolve materializes a dedicated ephemeral worktree for that one write
   * job instead — see {@link resolveForWrite}.
   */
  async resolve(
    ref: WorkspaceRef,
    options?: ResolveOptions,
  ): Promise<{ dir: string; release: () => void }> {
    this.requireNotStopped();
    this.requireAllowed(ref.repoId);
    if (options?.write !== undefined) {
      return this.resolveForWrite(ref, options.write.jobId);
    }
    const rKey = repoKey(ref.repoId);
    const { headCommit } = ref;
    const cKey = commitKey(headCommit);
    const key = checkoutKey(rKey, cKey);
    const dir = await this.withRepoLock(rKey, async () => {
      const worker = await this.requireSyncedCommit(rKey, ref);
      const checkoutDir = this.checkoutDir(rKey, cKey);
      if (await isPopulatedCheckout(checkoutDir)) {
        // Verify-on-reuse (invariant 4): the dir name is a truncated commit
        // key, so an existing worktree MUST prove it holds the requested FULL
        // commit before it is handed out. `null` is a read FAILURE (aborted or
        // timed-out git, corrupt gitlink) — NOT evidence of a different
        // commit — so the two diverge below: a failure must never be reported
        // as a commit-key collision.
        const actual = await worktreeHead(worker, checkoutDir);
        if (actual !== headCommit) {
          const existing = this.checkouts.get(key);
          const pinned = existing !== undefined && existing.refcount > 0;
          if (actual === null) {
            if (pinned) {
              // Unreadable but a running job is reading it: never remove.
              throw new WorkspaceError(
                "GIT_FAILED",
                "could not read checkout HEAD to verify reuse of a checkout " +
                  "pinned by a running job",
                { repoId: ref.repoId, headCommit },
              );
            }
            if (this.abort.signal.aborted) {
              // The store is stopping, so the failed read IS (almost surely)
              // the abort, not a broken checkout. Don't destroy a probably
              // valid checkout on the way down; fail this resolve instead.
              throw new WorkspaceError(
                "GIT_FAILED",
                "could not read checkout HEAD (store is stopping)",
                { repoId: ref.repoId, headCommit },
              );
            }
            // Unreadable, unpinned, store live: a broken checkout (e.g.
            // corrupt gitlink). Fall through to self-heal like a mismatch.
          } else if (pinned) {
            // PINNED mismatch: a running job is reading this dir. Removing it
            // would be exactly the yank pinning exists to prevent, so fail
            // this resolve instead (correctness over availability).
            throw new WorkspaceError(
              "GIT_FAILED",
              "checkout dir holds a different commit and is pinned by a " +
                "running job (truncated commit-key conflict); retry later",
              { repoId: ref.repoId, headCommit, checkedOut: actual },
            );
          }
          // Unpinned mismatch/breakage: this is a REGISTERED worktree, so
          // remove it properly (like eviction does), then fall through to
          // re-add.
          await removeWorktree(worker, checkoutDir);
          await this.removeCheckoutDir(checkoutDir, ref.repoId, headCommit);
        }
      }
      if (!(await isPopulatedCheckout(checkoutDir))) {
        // Remove any stale/partial dir before re-adding the worktree.
        await this.removeCheckoutDir(checkoutDir, ref.repoId, headCommit);
        const added = await addWorktree(worker, checkoutDir, headCommit);
        if (!ok(added)) {
          throw new WorkspaceError(
            "GIT_FAILED",
            `could not materialize checkout: ${describeGitFailure(added)}`,
            { repoId: ref.repoId, headCommit },
          );
        }
      }
      // Track the checkout (bumping last-use) and PIN it before we release the
      // lock, so the eviction pass below — and any concurrent resolve's pass —
      // cannot pick it as a victim while this handle is outstanding.
      this.touch(key, rKey, cKey, checkoutDir);
      this.pin(key);
      return checkoutDir;
    });
    // The pin was committed under the repo lock; the `return` below is its
    // commit point — the caller only learns the handle (and thus how to
    // `release` the pin) once we return. Any throw before that return must
    // unpin, or this checkout leaks a pin and becomes permanently unevictable.
    try {
      // Evict AFTER releasing this repo's lock, and take only the victim's
      // lock, so eviction never holds two repo locks at once (no deadlock).
      await this.evictToCapacity();
    } catch (error) {
      this.unpin(key);
      throw error;
    }
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      this.unpin(key);
    };
    return { dir, release };
  }

  /**
   * Stops the store for daemon shutdown. Idempotent. Guarantees:
   * - Any git op already in flight is cancelled: {@link abort} fires, which the
   *   threaded signal turns into the same kill path as a timeout, so a running
   *   fetch/checkout/gc returns in milliseconds instead of at `gitTimeoutMs`.
   *   On Windows this releases a live `git worktree` lock promptly, so teardown
   *   `rm` does not fail with EBUSY.
   * - New work fails closed: after stop, `applyBundle`, `resolve`, and
   *   `haveTip` reject before touching disk.
   *
   * Best-effort waits out the current per-repo lock chains so a just-cancelled
   * op has unwound before we return; this is a courtesy, not a correctness
   * requirement (the abort already makes those settle fast). Rejections in the
   * chain are swallowed — a cancelled op rejecting is the expected outcome.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abort.abort();
    // Await whatever is currently chained per repo so in-flight (now-aborted)
    // ops have unwound. Snapshot first: the map is mutated as chains resolve.
    const pending = [...this.locks.values()];
    await Promise.allSettled(pending);
  }

  /** A resolver bound to this store, for injection into the JobManager. */
  createResolver(): WorkspaceResolver {
    // owner is intentionally ignored: the worker cache is not per-owner.
    return (ref: WorkspaceRef) => this.resolve(ref);
  }

  /**
   * The live write-job worktree registered for `jobId`, or `undefined` if
   * there is none (never resolved, resolve failed, or already released).
   *
   * This is the jobId -> workspace bridge the daemon's write-job finalize
   * step (Task 6) depends on: at finalize time only the jobId is in hand, and
   * artifact-bundle creation needs the worktree dir (where the job's commit
   * lives), the repoKey (whose cache repo to bundle from), and `baseCommit` —
   * the `ref.headCommit` the worktree was materialized at, i.e. the bundle's
   * `--not` prerequisite.
   *
   * Two caveats for consumers: an entry exists from RESERVATION time, so the
   * dir is only guaranteed to be on disk once the resolve that reserved it
   * has returned. And any git op touching the returned worktree or its repo
   * MUST go through this store (under its per-repo lock) — this accessor
   * reads the mapping, it is not a license for out-of-band git: a concurrent
   * sync's `gc --prune=now` would race it.
   */
  writeJobWorkspace(
    jobId: JobId,
  ): { dir: string; repoKey: string; baseCommit: string } | undefined {
    const entry = this.writeWorkspaces.get(jobId);
    return entry === undefined ? undefined : { ...entry };
  }

  /**
   * Turns a finished write job's worktree into its deliverable artifact:
   * commit everything, mint the result branch ref in the bare repo, measure
   * the diffstat, bundle `branch --not base` to
   * `<repoRoot>/jobs/<jobId12>.bundle`, delete the ref again (the bundle is
   * self-contained; a lingering ref would leak into future have/gc
   * decisions), and return the wire-schema-shaped artifact together with
   * the bundle's path and byte length (measured under the lock, right after
   * creation) so the assembly's finalize closure can register into the
   * ArtifactStore without re-deriving paths or racing a stat — it forwards
   * `.artifact` to the executor and the rest to `ArtifactStore.register`.
   * Returns `null` on a clean tree — the model declared done without
   * changing anything — with no commit, no ref, and no bundle.
   *
   * Runs post-executor, so the job's worktree is materialized; the registry
   * entry (which exists from reservation time) is the jobId -> workspace
   * bridge. ALL git here runs inside ONE per-repo locked callback
   * ({@link withRepoLock} is non-reentrant), so a finalize can never
   * interleave with a sync, gc, or checkout on the same repo.
   *
   * The bundle DELIBERATELY outlives the handle's `release()` (which
   * removes only the worktree dir): as a `jobs/` SIBLING of the worktree it
   * survives until job eviction (ArtifactStore.remove, Task 7) or the next
   * {@link init}'s wholesale jobs purge deletes it.
   *
   * Cancellation: `input.signal` (the JOB's) is composed with the store's
   * own stop signal into every git op here. A job abort surfaces as a
   * rejection whose `name` is `"AbortError"` — the WriteExecutor maps that
   * to a canceled result — while a store stop keeps the usual
   * stopped/GIT_FAILED shape.
   */
  async finalizeWriteJob(input: {
    jobId: JobId;
    /** Already capped by the executor to WriteArtifactSchema's max length. */
    commitMessage: string;
    /** Short device id for the author email: `worker@<deviceId8>.invalid`. */
    deviceId8: string;
    /** The job's cancellation; the store's stop signal is composed in. */
    signal?: AbortSignal;
  }): Promise<FinalizedWriteJob | null> {
    this.requireNotStopped();
    const { jobId, commitMessage, deviceId8, signal } = input;
    throwIfJobAborted(signal);
    const entry = this.writeWorkspaces.get(jobId);
    if (entry === undefined) {
      throw new WorkspaceError(
        "NO_WRITE_WORKSPACE",
        "no live write worktree for this job (never resolved, or already released)",
        { jobId },
      );
    }
    // Compose job + store cancellation for this finalize's git ops. By hand
    // rather than AbortSignal.any, mirroring loop.ts: the listeners are
    // deterministically removed when the finalize settles.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (this.abort.signal.aborted || signal?.aborted === true) {
      controller.abort();
    }
    try {
      return await this.withRepoLock(entry.repoKey, () =>
        this.finalizeWriteJobLocked(entry, {
          jobId,
          commitMessage,
          deviceId8,
          jobSignal: signal,
          opSignal: controller.signal,
        }),
      );
    } finally {
      this.abort.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // --- internals -----------------------------------------------------------

  /**
   * The locked body of {@link finalizeWriteJob}. MUST be called under the
   * repo's lock and must never re-acquire it (non-reentrancy). `opSignal`
   * (job + store, composed) cancels the git ops; `jobSignal` alone decides
   * whether a failure surfaces as the job's AbortError or as GIT_FAILED.
   */
  private async finalizeWriteJobLocked(
    entry: WriteWorkspaceEntry,
    input: {
      jobId: JobId;
      commitMessage: string;
      deviceId8: string;
      jobSignal: AbortSignal | undefined;
      opSignal: AbortSignal;
    },
  ): Promise<FinalizedWriteJob | null> {
    // Queued behind the lock: a stop() or job abort may have landed since
    // the public entry point's checks (the op-granularity discipline).
    this.requireNotStopped();
    const { jobId, jobSignal } = input;
    throwIfJobAborted(jobSignal);
    if (this.writeWorkspaces.get(jobId) !== entry) {
      // A release queued ahead of this finalize deregistered the worktree
      // (a lifecycle misuse — finalize runs before release): surface the
      // typed error rather than letting the commit fail on a missing dir.
      throw new WorkspaceError(
        "NO_WRITE_WORKSPACE",
        "the write worktree for this job was released before finalize ran",
        { jobId },
      );
    }
    const worker: WorkerGit = {
      ...this.worker(entry.repoKey),
      signal: input.opSignal,
    };
    const base = entry.baseCommit;

    let head: string | null;
    try {
      head = await commitAllInWorktree(worker, entry.dir, {
        message: input.commitMessage,
        authorName: WRITE_AUTHOR_NAME,
        authorEmail: `worker@${input.deviceId8}.invalid`,
      });
    } catch (error) {
      throw this.finalizeFailure(
        jobSignal,
        jobId,
        `could not commit write-job changes: ${describeError(error)}`,
      );
    }
    if (head === null) {
      return null; // clean tree: no commit, no ref, no bundle
    }

    const branchName = writeBranchName(jobId);
    const branchRef = `refs/heads/${branchName}`;
    // The worktree shares the bare repo's object store, so the new commit
    // is already visible there; the ref exists only for `bundle create`.
    const updated = await updateRef(worker, branchRef, head);
    if (!ok(updated)) {
      throw this.finalizeFailure(
        jobSignal,
        jobId,
        `could not create the artifact branch ref: ${describeGitFailure(updated)}`,
      );
    }
    try {
      let diffCounts: DiffStatCounts;
      try {
        diffCounts = await diffStat(worker, worker.repoDir, base, head);
      } catch (error) {
        throw this.finalizeFailure(
          jobSignal,
          jobId,
          `could not measure the artifact diffstat: ${describeError(error)}`,
        );
      }
      const bundlePath = this.writeBundlePath(entry.repoKey, jobId);
      const bundled = await createWorkerBundle(worker, {
        bundlePath,
        ref: branchRef,
        base,
      });
      if (!ok(bundled)) {
        // A failed `bundle create` can leave a partial file behind.
        try {
          await rm(bundlePath, { force: true });
        } catch {
          // Best effort; the next init()'s jobs purge is the backstop.
        }
        throw this.finalizeFailure(
          jobSignal,
          jobId,
          `could not bundle the artifact: ${describeGitFailure(bundled)}`,
        );
      }
      // Measured here, under the lock, so the registered byte length can
      // never race a concurrent mutation of the file.
      let byteLength: number;
      try {
        byteLength = (await stat(bundlePath)).size;
      } catch (error) {
        throw this.finalizeFailure(
          jobSignal,
          jobId,
          `could not stat the artifact bundle: ${describeError(error)}`,
        );
      }
      return {
        artifact: {
          branchName,
          baseCommit: base,
          headCommit: head,
          diffStat: diffCounts,
          commitMessage: input.commitMessage,
        },
        bundlePath,
        byteLength,
      };
    } finally {
      // The bundle is self-contained (its one prerequisite is baseCommit,
      // which the delegator holds by construction); a lingering branch ref
      // would anchor the job's objects into future gc and have/incremental
      // decisions. Deleted via the STORE's own worker — no job signal — so
      // a job abort cannot also kill the cleanup. Best effort by contract.
      await deleteRef(this.worker(entry.repoKey), branchRef);
    }
  }

  /**
   * Failure shaping for the finalize path: a JOB abort surfaces as the
   * AbortError the WriteExecutor maps to a canceled result (the failed git
   * op was collateral of the kill, not a git problem); anything else is the
   * usual typed GIT_FAILED.
   */
  private finalizeFailure(
    jobSignal: AbortSignal | undefined,
    jobId: JobId,
    message: string,
  ): Error {
    if (jobSignal?.aborted === true) {
      return writeAbortError();
    }
    return new WorkspaceError("GIT_FAILED", message, { jobId });
  }

  /**
   * The write job's artifact bundle: `<repoRoot>/jobs/<jobId12>.bundle` — a
   * SIBLING of the job's worktree dir, so the handle's `release()` (which
   * removes only the worktree dir) never deletes a delivered artifact.
   * Reaped by job eviction (Task 7) or {@link init}'s wholesale jobs purge.
   */
  private writeBundlePath(rKey: string, jobId: JobId): string {
    return `${this.writeWorktreeDir(rKey, jobId)}.bundle`;
  }

  /**
   * Fails closed once {@link stop} has run. Reuses the `GIT_FAILED` code (no new
   * wire mapping) — the route maps it to a clear INTERNAL error; the message
   * says the store is stopped. Checked at the top of every public entry point
   * (before any disk access) and again inside lock-queued mutating callbacks
   * that must not issue git/disk ops once stop() has landed mid-queue.
   */
  private requireNotStopped(): void {
    if (this.stopped) {
      throw new WorkspaceError(
        "GIT_FAILED",
        "workspace store is stopped (daemon shutting down)",
      );
    }
  }

  private requireAllowed(repoId: string): void {
    if (!this.allowed.has(repoId)) {
      throw new WorkspaceError(
        "REPO_NOT_ALLOWED",
        "repo is not on this worker's allowlist",
        { repoId },
      );
    }
  }

  /**
   * Throws `NOT_SYNCED` unless the repo's cache exists and holds
   * `ref.headCommit`; returns the repo's {@link WorkerGit} otherwise. Shared
   * by the read and write resolve paths; MUST be called under the repo lock.
   */
  private async requireSyncedCommit(
    rKey: string,
    ref: WorkspaceRef,
  ): Promise<WorkerGit> {
    if (!(await pathExists(this.repoDir(rKey)))) {
      throw new WorkspaceError(
        "NOT_SYNCED",
        "repo has not been synced to this worker yet",
        { repoId: ref.repoId },
      );
    }
    const worker = this.worker(rKey);
    if (!(await commitPresent(worker, ref.headCommit))) {
      throw new WorkspaceError(
        "NOT_SYNCED",
        "requested commit is not present in the worker cache; sync first",
        { repoId: ref.repoId, headCommit: ref.headCommit },
      );
    }
    return worker;
  }

  /**
   * Write-mode resolve: materializes a DEDICATED ephemeral worktree for one
   * write job at `<repoRoot>/jobs/<jobId12>`, detached at `ref.headCommit`,
   * under the same per-repo lock as every other git op on that repo.
   *
   * Write worktrees are INVISIBLE to the checkout cache by construction: they
   * are never entered into {@link checkouts} (so they neither count against
   * `maxCachedCheckouts` nor can be picked as eviction victims), and
   * {@link registerExistingCheckouts} never registers them (its scan reads
   * only `<repoRoot>/co`). The read path's documented invariants — pinning,
   * LRU accounting, re-mint back-off — are untouched.
   *
   * The jobId is reserved in {@link writeWorkspaces} SYNCHRONOUSLY (no await
   * between the duplicate check and the set), so two same-jobId resolves in
   * one tick cannot both pass the gate; a failed materialization drops the
   * reservation on its way out.
   */
  private async resolveForWrite(
    ref: WorkspaceRef,
    jobId: JobId,
  ): Promise<{ dir: string; release: () => void }> {
    const rKey = repoKey(ref.repoId);
    const { headCommit } = ref;
    const dir = this.writeWorktreeDir(rKey, jobId);
    if (this.writeWorkspaces.has(jobId)) {
      throw new WorkspaceError(
        "WRITE_IN_PROGRESS",
        "a write worktree for this job is already live (not yet released)",
        { repoId: ref.repoId, jobId },
      );
    }
    this.writeWorkspaces.set(jobId, {
      repoKey: rKey,
      dir,
      baseCommit: headCommit,
    });
    try {
      await this.withRepoLock(rKey, async () => {
        // Post-stop the no-mutation rule holds at OP granularity, not just at
        // the public entry point (the same discipline as the eviction pass —
        // commit 473850d): this callback may have queued behind the lock
        // BEFORE stop() landed, and materializing a worktree now would issue
        // new git/disk ops during shutdown. Back off instead.
        this.requireNotStopped();
        const worker = await this.requireSyncedCommit(rKey, ref);
        // A failed/aborted earlier attempt for this jobId can leave a partial
        // dir at this deterministic path (init() purges only on startup):
        // clear it before adding, like the read path does.
        await this.removeCheckoutDir(dir, ref.repoId, headCommit);
        try {
          await mkdir(this.jobsRoot(rKey), { recursive: true });
        } catch (error) {
          throw new WorkspaceError(
            "GIT_FAILED",
            `could not create write-job dir: ${describeError(error)}`,
            { repoId: ref.repoId, headCommit },
          );
        }
        const added = await addWorktree(worker, dir, headCommit);
        if (!ok(added)) {
          throw new WorkspaceError(
            "GIT_FAILED",
            `could not materialize write worktree: ${describeGitFailure(added)}`,
            { repoId: ref.repoId, headCommit },
          );
        }
      });
    } catch (error) {
      // The reservation is only as live as the resolve that made it.
      this.writeWorkspaces.delete(jobId);
      throw error;
    }
    // NOTE: unlike the read-mode handle's synchronous unpin, this release
    // actually returns a Promise that settles when the teardown has run (or
    // been skipped post-stop). The declared `() => void` keeps the handle
    // shape identical for callers; a caller that needs the completion point
    // (tests, the job finalize path) may await the returned promise.
    let cleanup: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (cleanup === undefined) {
        cleanup = this.releaseWriteWorktree(jobId, rKey, dir);
      }
      return cleanup;
    };
    return { dir, release };
  }

  /**
   * Tears down a write-job worktree when its handle is released: under the
   * repo lock, `git worktree remove` (+prune), `rm` the dir, deregister the
   * jobId. A teardown failure is logged, never thrown (like eviction); the
   * next {@link init}'s purge is the backstop. The handle's caching of the
   * returned promise makes a double-release a no-op.
   *
   * Post-stop this runs NO git/disk ops — the op-granularity discipline of
   * the eviction pass (commit 473850d), checked both before queueing (a
   * post-stop release must not register a new lock chain past stop()'s
   * Promise.allSettled snapshot) and inside the locked callback (a release
   * that queued pre-stop may reach its callback post-stop, and its aborted
   * `git worktree remove` could leave a stale admin entry while the rm still
   * deleted the dir). The worktree then simply persists on disk until the
   * next init() purges `<repoRoot>/jobs` — a consistent, expected state.
   */
  private async releaseWriteWorktree(
    jobId: JobId,
    rKey: string,
    dir: string,
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.withRepoLock(rKey, async () => {
      if (this.stopped) {
        return;
      }
      try {
        await removeWorktree(this.worker(rKey), dir);
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        this.log(
          `failed to remove write-job worktree ${dir}: ${describeError(error)}`,
        );
      }
      this.writeWorkspaces.delete(jobId);
    });
  }

  private hooksPath(): string {
    return path.join(this.cacheDir, ".no-hooks");
  }

  private repoRoot(rKey: string): string {
    return path.join(this.cacheDir, rKey);
  }

  private repoDir(rKey: string): string {
    return path.join(this.repoRoot(rKey), "repo.git");
  }

  /** `co`, not `checkouts`: every char here recurs in every checkout file path. */
  private checkoutsRoot(rKey: string): string {
    return path.join(this.repoRoot(rKey), "co");
  }

  private checkoutDir(rKey: string, cKey: string): string {
    return path.join(this.checkoutsRoot(rKey), cKey);
  }

  /** The narrow seam the init-time purge/scan helpers see of this store. */
  private initContext(): WorkspaceInitContext {
    return {
      cacheDir: this.cacheDir,
      jobsRoot: (rKey) => this.jobsRoot(rKey),
      checkoutsRoot: (rKey) => this.checkoutsRoot(rKey),
      log: this.log,
    };
  }

  /**
   * Ephemeral write-job worktrees live under `<repoRoot>/jobs`, a SIBLING of
   * `co` — the checkout scan ({@link registerExistingCheckouts}) reads only
   * `co`, so a write worktree can structurally never be registered against
   * the retention cap. Purged wholesale by {@link init}.
   */
  private jobsRoot(rKey: string): string {
    return path.join(this.repoRoot(rKey), "jobs");
  }

  /**
   * One dir per write job, named by the job UUID's last 12 hex (jobId12).
   * Note the registry ({@link writeWorkspaces}) keys by the FULL jobId while
   * dirs use only the 12-hex tail: a tail collision between two live
   * daemon-generated v4 ids (~2^-48) is documented, not defended.
   */
  private writeWorktreeDir(rKey: string, jobId: JobId): string {
    return path.join(this.jobsRoot(rKey), jobId12(jobId));
  }

  private worker(rKey: string): WorkerGit {
    return {
      repoDir: this.repoDir(rKey),
      hooksPath: this.hooksPath(),
      timeoutMs: this.gitTimeoutMs,
      // Threads the store's cancellation into every worker-side git call, so a
      // stop() aborts an in-flight op instead of waiting out gitTimeoutMs.
      signal: this.abort.signal,
    };
  }

  /** Creates the per-repo bare cache repo on first use. */
  private async ensureRepo(rKey: string): Promise<void> {
    const repoDir = this.repoDir(rKey);
    if (await pathExists(repoDir)) {
      return;
    }
    await mkdir(this.repoRoot(rKey), { recursive: true });
    await initBareRepo(repoDir, this.gitTimeoutMs, this.abort.signal);
  }

  /**
   * Counts one fetch for `rKey` and, every `gcAfterFetches`, reclaims
   * unreachable objects. MUST be called under the repo's lock (it is, from
   * `applyBundle`), so gc never races a fetch/checkout. A gc failure is logged,
   * not thrown — it must never fail an otherwise-successful sync.
   */
  private async maybeGc(rKey: string, worker: WorkerGit): Promise<void> {
    const count = (this.fetchesSinceGc.get(rKey) ?? 0) + 1;
    if (count < this.gcAfterFetches) {
      this.fetchesSinceGc.set(rKey, count);
      return;
    }
    this.fetchesSinceGc.set(rKey, 0);
    const result = await gc(worker);
    if (ok(result)) {
      this.log(`gc'd workspace cache ${rKey} after ${count} fetches`);
    } else {
      this.log(
        `gc of workspace cache ${rKey} failed: ${describeGitFailure(result)}`,
      );
    }
  }

  /**
   * Serializes work for one repoKey onto a single promise chain. NON-
   * REENTRANT: an inner acquisition awaited inside an outer callback for the
   * same repoKey queues behind that outer callback and deadlocks.
   */
  private withRepoLock<T>(rKey: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(rKey) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    // Keep the chain alive but swallow rejections so one failure does not
    // poison the next caller (each caller sees its own result/throw).
    this.locks.set(
      rKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Marks a checkout most-recently-used. Updates an EXISTING entry in place
   * (preserving its refcount — a pinned checkout must stay pinned across a
   * re-resolve) and only mints a fresh entry (refcount 0) when none exists.
   * The pin for a resolve is applied by {@link resolve} via {@link pin} after
   * this call, so a plain last-use bump never changes the reference count.
   */
  private touch(
    key: string,
    repoKeyValue: string,
    commitKeyValue: string,
    dir: string,
  ): void {
    this.useTick += 1;
    const existing = this.checkouts.get(key);
    if (existing !== undefined) {
      existing.usedAt = this.useTick;
      return;
    }
    this.checkouts.set(key, {
      repoKey: repoKeyValue,
      commitKey: commitKeyValue,
      dir,
      usedAt: this.useTick,
      refcount: 0,
    });
  }

  /** Pins a checkout (increments its refcount) so eviction will skip it. */
  private pin(key: string): void {
    const entry = this.checkouts.get(key);
    if (entry !== undefined) {
      entry.refcount += 1;
    }
  }

  /** Unpins a checkout (decrements its refcount, floored at 0). */
  private unpin(key: string): void {
    const entry = this.checkouts.get(key);
    if (entry !== undefined && entry.refcount > 0) {
      entry.refcount -= 1;
    }
  }

  /**
   * Removes a checkout dir on resolve()'s behalf, normalizing raw fs errors
   * (Windows EPERM/EBUSY on in-use files) to resolve()'s typed contract of
   * throwing {@link WorkspaceError} on any failure.
   */
  private async removeCheckoutDir(
    dir: string,
    repoId: string,
    headCommit: string,
  ): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      throw new WorkspaceError(
        "GIT_FAILED",
        `could not remove checkout dir: ${describeError(error)}`,
        { repoId, headCommit },
      );
    }
  }

  /** Evicts least-recently-used checkouts until within the retention cap. */
  private async evictToCapacity(): Promise<void> {
    // Once stopped, run no worktree removal/prune: resolve() calls this in a
    // microtask AFTER its repo lock resolved, so an eviction here could register
    // a new lock chain past stop()'s Promise.allSettled snapshot and escape the
    // shutdown await. Short-circuiting keeps that `git worktree` op class from
    // ever starting post-stop (the EBUSY-avoidance target). Re-checked EVERY
    // iteration, not just on entry: each iteration awaits the repo lock, so
    // stop() can land mid-pass and the remaining removals must not be issued.
    while (this.checkouts.size > this.maxCachedCheckouts) {
      if (this.stopped) {
        return;
      }
      // Pick the LRU victim among UNPINNED checkouts only: a pinned checkout
      // (refcount > 0) is being read by a running job and must never be
      // `git worktree remove`d out from under it.
      let victimKey: string | undefined;
      let victim: CheckoutEntry | undefined;
      for (const [key, entry] of this.checkouts) {
        if (entry.refcount > 0) {
          continue;
        }
        if (victim === undefined || entry.usedAt < victim.usedAt) {
          victimKey = key;
          victim = entry;
        }
      }
      if (victimKey === undefined || victim === undefined) {
        // Every over-cap checkout is pinned; evicting any would yank a
        // running job's checkout. Stop rather than spin forever — the cap is
        // temporarily exceeded and shrinks as jobs finish and release.
        this.log(
          `workspace checkout eviction blocked: all ${this.checkouts.size} ` +
            `checkout(s) pinned by running jobs (cap ${this.maxCachedCheckouts})`,
        );
        return;
      }
      // Drop from the map first so the cap accounting shrinks now and another
      // eviction pass cannot double-pick this victim. That does NOT stop reuse:
      // resolve() targets checkouts by what is on DISK (isPopulatedCheckout),
      // so a resolve for this same checkout that queued on the repo lock ahead
      // of our removal can still find the dir, verify it, re-mint a map entry,
      // and PIN it — the locked callback below re-checks for that and backs
      // off rather than delete a dir a job now holds.
      this.checkouts.delete(victimKey);
      const evicted = victim;
      let reused = false;
      let halted = false;
      await this.withRepoLock(evicted.repoKey, async () => {
        if (this.stopped) {
          // stop() landed while this removal waited on the lock. Post-stop the
          // no-mutation rule holds at OP granularity, not just per iteration:
          // the aborted worktree remove/prune could leave a stale admin entry
          // and the rm would still delete the dir. Back off; the dir stays on
          // disk unregistered — the same state as any on-disk checkout after a
          // restart, which the next init() re-registers.
          halted = true;
          return;
        }
        if (this.checkouts.has(victimKey)) {
          // Re-minted while our removal waited on the lock: a queued-ahead
          // resolve reused the dir. It is live (and pinned) again; leave it.
          reused = true;
          return;
        }
        try {
          await removeWorktree(this.worker(evicted.repoKey), evicted.dir);
          await rm(evicted.dir, { recursive: true, force: true });
        } catch (error) {
          this.log(
            `failed to evict checkout ${evicted.dir}: ${describeError(error)}`,
          );
        }
      });
      if (halted) {
        return;
      }
      if (reused) {
        // Re-scan: the survivor is back in the map (pinned, so not a victim).
        continue;
      }
      this.log(
        `evicted workspace checkout ${evicted.dir} ` +
          `(retention cap ${this.maxCachedCheckouts} reached)`,
      );
    }
  }

  /** Registers checkouts present on disk (from a prior run) for the LRU cap. */
  private async registerExistingCheckouts(): Promise<void> {
    // The scan (in workspace-init.ts) only reads disk and returns oldest-first
    // entries; minting map entries and enforcing the cap stay the store's own.
    for (const found of await scanExistingCheckouts(this.initContext())) {
      this.useTick += 1;
      this.checkouts.set(checkoutKey(found.repoKey, found.commitKey), {
        repoKey: found.repoKey,
        commitKey: found.commitKey,
        dir: found.dir,
        usedAt: this.useTick,
        refcount: 0,
      });
    }
    await this.evictToCapacity();
  }
}

/** repoKey/commitKey length. 16 hex chars = 64 bits; see {@link repoKey}. */
const KEY_HEX_CHARS = 16;

/**
 * The per-repo cache key: the first 16 hex chars of SHA-256(repoId). One
 * function produces the ONE identity used everywhere — the cache dir name,
 * the per-repo lock key, and the checkout-map key prefix — so even a
 * hypothetical prefix collision between two allowlisted repoIds shares a
 * single lock (git ops on the shared dir never interleave). 16 hex chars
 * (2^64) are enough because repoIds are operator-configured allowlist
 * entries, not attacker-chosen names; kept short so checkout file paths stay
 * well under Windows MAX_PATH (see the file doc).
 */
export function repoKey(repoId: string): string {
  return createHash("sha256")
    .update(repoId, "utf8")
    .digest("hex")
    .slice(0, KEY_HEX_CHARS);
}

/**
 * The checkout dir name: the first 16 hex chars of the full 40-hex commit.
 * Truncation is safe ONLY because the resolver verifies an existing dir's
 * worktree HEAD against the requested full commit before reuse (invariant 4).
 */
function commitKey(headCommit: string): string {
  return headCommit.slice(0, KEY_HEX_CHARS);
}

/** Checkout-map key: dir-derived identity, so one directory = one LRU entry. */
function checkoutKey(rKey: string, cKey: string): string {
  return `${rKey}:${cKey}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The rejection a JOB abort surfaces as from {@link
 * WorkspaceStore.finalizeWriteJob}: `name === "AbortError"` is the contract
 * the WriteExecutor keys its canceled-not-INTERNAL mapping on.
 */
function writeAbortError(): Error {
  const error = new Error("write-job finalize aborted");
  error.name = "AbortError";
  return error;
}

/** Throws the {@link writeAbortError} iff the job's signal has fired. */
function throwIfJobAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw writeAbortError();
  }
}
