/**
 * Worker-side workspace store + resolver (M7, ADR-0005).
 *
 * Turns received git bundles into materialized checkouts a job executor can
 * read, under three security invariants:
 *
 * 1. **Allowlist, fail-closed.** Only repoIds in `allowedRepoIds` are accepted.
 *    An empty allowlist accepts nothing. A non-allowlisted repoId is rejected
 *    BEFORE any directory is created, so a probe leaves no trace on disk.
 * 2. **repoId never forms a path.** The per-repo cache directory is named by
 *    the SHA-256 of the repoId (hex only), so a repoId like `../../x`,
 *    `C:\evil`, or `..\\..` cannot escape the cache root — traversal is
 *    structurally impossible, not filtered.
 * 3. **Only check out what was delivered.** `applyBundle` verifies the bundle,
 *    rejects (before importing any object) a bundle whose advertised `HEAD`
 *    ref does not match the claimed `headCommit`, fetches into a scratch ref,
 *    and refuses to advance the repo's tip unless the fetched commit equals the
 *    claimed `headCommit`. The resolver refuses to materialize a commit the
 *    cache does not actually contain.
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
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { HfpError, WorkspaceRef } from "@homefleet/protocol";
import type { WorkspaceResolver } from "../jobs/job-manager.js";
import {
  addWorktree,
  COMMIT_HASH_RE,
  commitPresent,
  deleteRef,
  describeGitFailure,
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
} from "./git.js";

/** The single ref the worker maintains per repo: its current known head. */
const TIP_REF = "refs/homefleet/tip";
/** Scratch ref a bundle fetch lands in before it is validated and promoted. */
const INCOMING_REF = "refs/homefleet/incoming";
/** The ref name our bundles advertise their head under (`git bundle create HEAD`). */
const BUNDLE_HEAD_REF = "HEAD";

export type WorkspaceErrorCode =
  | "REPO_NOT_ALLOWED"
  | "BUNDLE_INVALID"
  | "COMMIT_NOT_DELIVERED"
  | "NOT_SYNCED"
  | "GIT_FAILED";

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
  /** Absolute cache root; per-repo dirs live under it, named by repoId hash. */
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
  repoHash: string;
  headCommit: string;
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

export class WorkspaceStore {
  private readonly cacheDir: string;
  private readonly allowed: ReadonlySet<string>;
  private readonly maxBundleBytesValue: number;
  private readonly maxCachedCheckouts: number;
  private readonly gcAfterFetches: number;
  private readonly gitTimeoutMs: number;
  private readonly log: (message: string) => void;

  /** Per-repo (by hash) promise chain: serializes all git ops for that repo. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Live checkouts, keyed `${repoHash}:${headCommit}`, for LRU eviction. */
  private readonly checkouts = new Map<string, CheckoutEntry>();
  /** Fetches applied per repo hash since its last gc (gc-gating counter). */
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
   * Prepares the cache root and the empty hooks directory, then registers any
   * checkouts left on disk by a previous daemon run (oldest first) so the
   * retention cap holds across restarts. Idempotent.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.hooksPath(), { recursive: true });
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
    const hash = repoHash(repoId);
    return this.withRepoLock(hash, async () => {
      const repoDir = this.repoDir(hash);
      if (!(await pathExists(repoDir))) {
        return null;
      }
      return revParse(this.worker(hash), TIP_REF);
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
    const hash = repoHash(repoId);
    await this.withRepoLock(hash, async () => {
      // Normalize the one raw throw on this path: initBareRepo throws GitError
      // (e.g. when a shutdown aborts a first-ever sync), but applyBundle's
      // contract is "throws WorkspaceError on any failure".
      try {
        await this.ensureRepo(hash);
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
      const worker = this.worker(hash);

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
      await this.maybeGc(hash, worker);
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
   */
  async resolve(
    ref: WorkspaceRef,
  ): Promise<{ dir: string; release: () => void }> {
    this.requireNotStopped();
    this.requireAllowed(ref.repoId);
    const hash = repoHash(ref.repoId);
    const { headCommit } = ref;
    const key = checkoutKey(hash, headCommit);
    const dir = await this.withRepoLock(hash, async () => {
      const repoDir = this.repoDir(hash);
      if (!(await pathExists(repoDir))) {
        throw new WorkspaceError(
          "NOT_SYNCED",
          "repo has not been synced to this worker yet",
          { repoId: ref.repoId },
        );
      }
      const worker = this.worker(hash);
      if (!(await commitPresent(worker, headCommit))) {
        throw new WorkspaceError(
          "NOT_SYNCED",
          "requested commit is not present in the worker cache; sync first",
          { repoId: ref.repoId, headCommit },
        );
      }
      const checkoutDir = this.checkoutDir(hash, headCommit);
      if (!(await isPopulatedCheckout(checkoutDir))) {
        // Remove any stale/partial dir before re-adding the worktree.
        await rm(checkoutDir, { recursive: true, force: true });
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
      this.touch(key, hash, headCommit, checkoutDir);
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

  // --- internals -----------------------------------------------------------

  /**
   * Fails closed once {@link stop} has run. Reuses the `GIT_FAILED` code (no new
   * wire mapping) — the route maps it to a clear INTERNAL error; the message
   * says the store is stopped. Checked at the top of every public entry point,
   * before any disk access.
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

  private hooksPath(): string {
    return path.join(this.cacheDir, ".no-hooks");
  }

  private repoRoot(hash: string): string {
    return path.join(this.cacheDir, hash);
  }

  private repoDir(hash: string): string {
    return path.join(this.repoRoot(hash), "repo.git");
  }

  private checkoutDir(hash: string, headCommit: string): string {
    return path.join(this.repoRoot(hash), "checkouts", headCommit);
  }

  private worker(hash: string): WorkerGit {
    return {
      repoDir: this.repoDir(hash),
      hooksPath: this.hooksPath(),
      timeoutMs: this.gitTimeoutMs,
      // Threads the store's cancellation into every worker-side git call, so a
      // stop() aborts an in-flight op instead of waiting out gitTimeoutMs.
      signal: this.abort.signal,
    };
  }

  /** Creates the per-repo bare cache repo on first use. */
  private async ensureRepo(hash: string): Promise<void> {
    const repoDir = this.repoDir(hash);
    if (await pathExists(repoDir)) {
      return;
    }
    await mkdir(this.repoRoot(hash), { recursive: true });
    await initBareRepo(repoDir, this.gitTimeoutMs, this.abort.signal);
  }

  /**
   * Counts one fetch for `hash` and, every `gcAfterFetches`, reclaims
   * unreachable objects. MUST be called under the repo's lock (it is, from
   * `applyBundle`), so gc never races a fetch/checkout. A gc failure is logged,
   * not thrown — it must never fail an otherwise-successful sync.
   */
  private async maybeGc(hash: string, worker: WorkerGit): Promise<void> {
    const count = (this.fetchesSinceGc.get(hash) ?? 0) + 1;
    if (count < this.gcAfterFetches) {
      this.fetchesSinceGc.set(hash, count);
      return;
    }
    this.fetchesSinceGc.set(hash, 0);
    const result = await gc(worker);
    if (ok(result)) {
      this.log(`gc'd workspace cache ${hash} after ${count} fetches`);
    } else {
      this.log(
        `gc of workspace cache ${hash} failed: ${describeGitFailure(result)}`,
      );
    }
  }

  /** Serializes work for one repo hash onto a single promise chain. */
  private withRepoLock<T>(hash: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(hash) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    // Keep the chain alive but swallow rejections so one failure does not
    // poison the next caller (each caller sees its own result/throw).
    this.locks.set(
      hash,
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
    repoHashValue: string,
    headCommit: string,
    dir: string,
  ): void {
    this.useTick += 1;
    const existing = this.checkouts.get(key);
    if (existing !== undefined) {
      existing.usedAt = this.useTick;
      return;
    }
    this.checkouts.set(key, {
      repoHash: repoHashValue,
      headCommit,
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

  /** Evicts least-recently-used checkouts until within the retention cap. */
  private async evictToCapacity(): Promise<void> {
    // Once stopped, run no worktree removal/prune: resolve() calls this in a
    // microtask AFTER its repo lock resolved, so an eviction here could register
    // a new lock chain past stop()'s Promise.allSettled snapshot and escape the
    // shutdown await. Short-circuiting keeps that `git worktree` op class from
    // ever starting post-stop (the EBUSY-avoidance target).
    if (this.stopped) {
      return;
    }
    while (this.checkouts.size > this.maxCachedCheckouts) {
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
      // Drop from the map first so a concurrent resolve does not pick it as a
      // reuse target while we are removing it.
      this.checkouts.delete(victimKey);
      const evicted = victim;
      await this.withRepoLock(evicted.repoHash, async () => {
        try {
          await removeWorktree(this.worker(evicted.repoHash), evicted.dir);
          await rm(evicted.dir, { recursive: true, force: true });
        } catch (error) {
          this.log(
            `failed to evict checkout ${evicted.dir}: ${describeError(error)}`,
          );
        }
      });
      this.log(
        `evicted workspace checkout ${evicted.dir} ` +
          `(retention cap ${this.maxCachedCheckouts} reached)`,
      );
    }
  }

  /** Registers checkouts present on disk (from a prior run) for the LRU cap. */
  private async registerExistingCheckouts(): Promise<void> {
    let repoHashes: string[];
    try {
      repoHashes = await readdir(this.cacheDir);
    } catch {
      return;
    }
    const found: Array<{ entry: CheckoutEntry; mtimeMs: number }> = [];
    for (const hash of repoHashes) {
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        continue; // skip .no-hooks and anything not a repo-hash dir
      }
      const checkoutsRoot = path.join(this.repoRoot(hash), "checkouts");
      let commits: string[];
      try {
        commits = await readdir(checkoutsRoot);
      } catch {
        continue;
      }
      for (const headCommit of commits) {
        if (!COMMIT_HASH_RE.test(headCommit)) {
          continue;
        }
        const dir = path.join(checkoutsRoot, headCommit);
        try {
          const info = await stat(dir);
          if (!info.isDirectory()) {
            continue;
          }
          found.push({
            entry: {
              repoHash: hash,
              headCommit,
              dir,
              usedAt: 0,
              refcount: 0,
            },
            mtimeMs: info.mtimeMs,
          });
        } catch {
          // Vanished between readdir and stat; ignore.
        }
      }
    }
    // Oldest first, so subsequent use ordering is preserved and eviction picks
    // the genuinely oldest survivors first.
    found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { entry } of found) {
      this.useTick += 1;
      this.checkouts.set(checkoutKey(entry.repoHash, entry.headCommit), {
        ...entry,
        usedAt: this.useTick,
      });
    }
    await this.evictToCapacity();
  }
}

/** SHA-256 hex of the repoId — the per-repo cache dir name (hex only). */
export function repoHash(repoId: string): string {
  return createHash("sha256").update(repoId, "utf8").digest("hex");
}

function checkoutKey(hash: string, headCommit: string): string {
  return `${hash}:${headCommit}`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A checkout dir is usable iff it exists and carries the worktree gitlink. */
async function isPopulatedCheckout(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".git"));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
