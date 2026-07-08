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
 *    fetches it into a scratch ref, and refuses to advance the repo's tip
 *    unless the fetched commit equals the claimed `headCommit`. The resolver
 *    refuses to materialize a commit the cache does not actually contain.
 *
 * Git is not concurrency-safe on one repository, so every operation for a given
 * repoId is serialized through a per-repo promise chain: two syncs, or a sync
 * racing a job's checkout, for the same repo can never interleave.
 *
 * Cache growth is bounded: materialized checkouts are capped
 * (`maxCachedCheckouts`, oldest evicted, evictions logged), so a peer syncing
 * many commits cannot fill the disk without limit.
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
  initBareRepo,
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
}

export class WorkspaceStore {
  private readonly cacheDir: string;
  private readonly allowed: ReadonlySet<string>;
  private readonly maxBundleBytesValue: number;
  private readonly maxCachedCheckouts: number;
  private readonly gitTimeoutMs: number;
  private readonly log: (message: string) => void;

  /** Per-repo (by hash) promise chain: serializes all git ops for that repo. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Live checkouts, keyed `${repoHash}:${headCommit}`, for LRU eviction. */
  private readonly checkouts = new Map<string, CheckoutEntry>();
  private useTick = 0;
  private initialized = false;

  constructor(options: WorkspaceStoreOptions) {
    this.cacheDir = path.resolve(options.cacheDir);
    this.allowed = new Set(options.allowedRepoIds);
    this.maxBundleBytesValue = options.maxBundleBytes;
    this.maxCachedCheckouts = options.maxCachedCheckouts;
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
   * allowlist check -> verify -> fetch into a scratch ref -> confirm the
   * fetched commit equals `headCommit` -> advance the tip. Serialized per repo.
   *
   * Throws {@link WorkspaceError} on any failure; on rejection the tip is never
   * advanced and no checkout is produced (the cache is left as it was).
   */
  async applyBundle(
    repoId: string,
    bundlePath: string,
    headCommit: string,
  ): Promise<void> {
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
      await this.ensureRepo(hash);
      const worker = this.worker(hash);

      if (!(await verifyBundle(worker, bundlePath))) {
        throw new WorkspaceError(
          "BUNDLE_INVALID",
          "received bundle failed `git bundle verify` " +
            "(malformed, or its prerequisites are not present)",
          { repoId },
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
    });
  }

  /**
   * The {@link WorkspaceResolver} implementation: resolves a `WorkspaceRef` to
   * an absolute, materialized checkout directory. Fails (throws
   * {@link WorkspaceError}, which the JobManager turns into a terminal
   * `WORKSPACE_UNAVAILABLE`) if the repo is not allowlisted or the commit has
   * not been synced into the cache.
   */
  async resolve(ref: WorkspaceRef): Promise<string> {
    this.requireAllowed(ref.repoId);
    const hash = repoHash(ref.repoId);
    const { headCommit } = ref;
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
      const key = checkoutKey(hash, headCommit);
      if (await isPopulatedCheckout(checkoutDir)) {
        this.touch(key, hash, headCommit, checkoutDir);
        return checkoutDir;
      }
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
      this.touch(key, hash, headCommit, checkoutDir);
      return checkoutDir;
    });
    // Evict AFTER releasing this repo's lock, and take only the victim's lock,
    // so eviction never holds two repo locks at once (no deadlock).
    await this.evictToCapacity();
    return dir;
  }

  /** A resolver bound to this store, for injection into the JobManager. */
  createResolver(): WorkspaceResolver {
    return (ref: WorkspaceRef) => this.resolve(ref);
  }

  // --- internals -----------------------------------------------------------

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
    };
  }

  /** Creates the per-repo bare cache repo on first use. */
  private async ensureRepo(hash: string): Promise<void> {
    const repoDir = this.repoDir(hash);
    if (await pathExists(repoDir)) {
      return;
    }
    await mkdir(this.repoRoot(hash), { recursive: true });
    await initBareRepo(repoDir, this.gitTimeoutMs);
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

  private touch(
    key: string,
    repoHashValue: string,
    headCommit: string,
    dir: string,
  ): void {
    this.useTick += 1;
    this.checkouts.set(key, {
      repoHash: repoHashValue,
      headCommit,
      dir,
      usedAt: this.useTick,
    });
  }

  /** Evicts least-recently-used checkouts until within the retention cap. */
  private async evictToCapacity(): Promise<void> {
    while (this.checkouts.size > this.maxCachedCheckouts) {
      let victimKey: string | undefined;
      let victim: CheckoutEntry | undefined;
      for (const [key, entry] of this.checkouts) {
        if (victim === undefined || entry.usedAt < victim.usedAt) {
          victimKey = key;
          victim = entry;
        }
      }
      if (victimKey === undefined || victim === undefined) {
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
