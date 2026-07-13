/**
 * Init-time disk reconciliation for the {@link WorkspaceStore}: the pure
 * "look at what a previous daemon run left on disk" half of `init()`,
 * extracted from the store so its lock/refcount core stays focused.
 *
 * Everything here runs BEFORE the daemon serves anything (daemon.ts awaits
 * `init()` before the JobManager exists), so no per-repo lock is needed: no
 * git op or resolve can be in flight yet. The helpers take a narrow
 * {@link WorkspaceInitContext} — the cache root, the store's path-layout
 * accessors, and its log sink — and either mutate disk (the jobs purge) or
 * return plain data (the checkout scan) for the store to register itself;
 * they never touch the store's maps, locks, or abort machinery.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { deleteRef, listRefs, type WorkerGit } from "./git.js";

/** A repoKey or commitKey directory name (16 hex chars; see the store doc). */
export const KEY_RE = /^[0-9a-f]{16}$/;
/** A pre-0.1 per-repo cache dir name (full 64-hex SHA-256 of the repoId). */
export const LEGACY_REPO_DIR_RE = /^[0-9a-f]{64}$/;

/**
 * What the init helpers need from the store: the cache root to enumerate,
 * the store's own path layout (so layout knowledge stays defined in ONE
 * place — the store's private helpers, bound into this context), and its
 * diagnostic sink.
 */
export interface WorkspaceInitContext {
  /** Absolute cache root; per-repo dirs live under it, named by repoKey. */
  cacheDir: string;
  /** `<repoRoot>/jobs` for a repoKey — where ephemeral write worktrees live. */
  jobsRoot(repoKey: string): string;
  /** `<repoRoot>/co` for a repoKey — where cached checkouts live. */
  checkoutsRoot(repoKey: string): string;
  /** The store's worker-git context for a repoKey's bare cache repo. */
  worker(repoKey: string): WorkerGit;
  /** Diagnostic sink (purge failures, legacy-layout warnings). */
  log(message: string): void;
}

/** A checkout found on disk by {@link scanExistingCheckouts}, oldest first. */
export interface ScannedCheckout {
  repoKey: string;
  commitKey: string;
  dir: string;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A checkout dir is usable iff it exists and carries the worktree gitlink. */
export async function isPopulatedCheckout(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".git"));
}

/** The per-repo cache dirs present under the cache root (16-hex names only). */
async function repoKeyDirs(ctx: WorkspaceInitContext): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(ctx.cacheDir);
  } catch {
    return [];
  }
  return names;
}

/**
 * Removes every repo's `<repoRoot>/jobs` dir wholesale at init. An in-flight
 * write job never survives a daemon restart (its executor died with the
 * process), so anything found there — half-built worktrees, stale artifact
 * `.bundle` files — is garbage by definition. Absent jobs dirs are tolerated
 * (`force: true`). Worktree ADMIN entries in `repo.git` that pointed at the
 * removed dirs go stale; that is harmless (`addWorktree` passes `--force`)
 * and the next `removeWorktree`'s `git worktree prune` reaps them.
 */
export async function purgeWriteWorktrees(
  ctx: WorkspaceInitContext,
): Promise<void> {
  for (const name of await repoKeyDirs(ctx)) {
    if (!KEY_RE.test(name)) {
      continue; // skip .no-hooks / legacy dirs, like the checkout scan does
    }
    const jobsRoot = ctx.jobsRoot(name);
    try {
      await rm(jobsRoot, { recursive: true, force: true });
    } catch (error) {
      ctx.log(
        `failed to purge write-job worktrees at ${jobsRoot}: ` +
          describeError(error),
      );
    }
  }
}

/**
 * The refs/heads namespace write-job finalize mints its transient branch
 * refs in. Deliberately the refs/heads/ FORM (writeBranchName lands under
 * it); the worker's own tip ref lives at `refs/homefleet/tip`, OUTSIDE
 * refs/heads/, so it is structurally out of this sweep's reach.
 */
const WRITE_REF_PREFIX = "refs/heads/homefleet/";

/**
 * Deletes every leaked `refs/heads/homefleet/*` ref from each repo's bare
 * cache at init. Finalize deletes its transient branch ref in a `finally`,
 * but a hard crash between `updateRef` and that `deleteRef` (or a
 * stop-killed cleanup) leaks the ref permanently — nothing else sweeps
 * refs, and each leaked ref anchors its job's objects against
 * `gc --prune=now` forever. Safe by the same argument as the jobs-dir
 * purge: init runs pre-serving, and an in-flight write job never survives
 * a restart, so ANY ref in this namespace is garbage by definition. Only
 * this exact namespace is touched: the tip ref (`refs/homefleet/tip`) and
 * user branches are structurally outside it. Best effort per repo —
 * a failed sweep is logged, never fails init.
 */
export async function sweepLeakedWriteRefs(
  ctx: WorkspaceInitContext,
): Promise<void> {
  for (const name of await repoKeyDirs(ctx)) {
    if (!KEY_RE.test(name)) {
      continue;
    }
    const worker = ctx.worker(name);
    if (!(await pathExists(worker.repoDir))) {
      continue; // a repoKey dir without a bare cache repo (never synced)
    }
    const leaked = await listRefs(worker, WRITE_REF_PREFIX);
    for (const ref of leaked) {
      await deleteRef(worker, ref);
      ctx.log(`swept leaked write-branch ref ${ref} from cache ${name}`);
    }
  }
}

/**
 * Finds checkouts left on disk by a prior daemon run so the store can
 * register them against its LRU retention cap. Returns them OLDEST first
 * (by dir mtime), so the store's subsequent use ordering is preserved and
 * eviction picks the genuinely oldest survivors first. Pure scan: registers
 * nothing itself — the store owns its checkout map.
 */
export async function scanExistingCheckouts(
  ctx: WorkspaceInitContext,
): Promise<ScannedCheckout[]> {
  const found: Array<{ entry: ScannedCheckout; mtimeMs: number }> = [];
  for (const name of await repoKeyDirs(ctx)) {
    if (LEGACY_REPO_DIR_RE.test(name)) {
      // A pre-0.1 cache dir (64-hex repo hash, `checkouts/<40-hex>` layout).
      // Neither registered nor deleted: this version never resolves into
      // it, and destroying an operator's data on startup is not this
      // store's call to make.
      ctx.log(
        `legacy workspace cache layout at ${path.join(ctx.cacheDir, name)}` +
          " (pre-0.1); not used by this version — safe to delete",
      );
      continue;
    }
    if (!KEY_RE.test(name)) {
      continue; // skip .no-hooks and anything not a repoKey dir
    }
    const checkoutsRoot = ctx.checkoutsRoot(name);
    let commitKeys: string[];
    try {
      commitKeys = await readdir(checkoutsRoot);
    } catch {
      continue;
    }
    for (const cKey of commitKeys) {
      if (!KEY_RE.test(cKey)) {
        continue;
      }
      const dir = path.join(checkoutsRoot, cKey);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) {
          continue;
        }
        if (!(await isPopulatedCheckout(dir))) {
          // No `.git` gitlink (e.g. a checkout creation that died partway):
          // not a usable checkout — the same judgment resolve() applies —
          // so it must not count against the cap and evict real checkouts.
          // Left on disk: a resolve() for this repo/commit repairs it.
          continue;
        }
        found.push({
          entry: { repoKey: name, commitKey: cKey, dir },
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
  return found.map(({ entry }) => entry);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
