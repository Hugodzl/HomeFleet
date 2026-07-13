/**
 * Safe `git` wrapper for workspace sync (M7, ADR-0005).
 *
 * Every git invocation goes through {@link runGit}: `shell: false`, arguments
 * as an array (never interpolated into a shell), a hardened environment, and a
 * bounded timeout that kills the process (tree) so a wedged git can never hang
 * the daemon. Results are typed — a nonzero exit is data, not a throw.
 *
 * Two sides use these helpers:
 * - The DELEGATING side runs against the user's OWN repository (trusted):
 *   {@link resolveHeadCommit}, {@link isAncestor}, {@link createBundle}. These
 *   subcommands never execute repository hooks.
 * - The WORKER side runs against a daemon-owned cache repo, fed content from a
 *   PAIRED-BUT-UNTRUSTED peer (M8 threat model: a compromised paired device).
 *   Those calls additionally point `core.hooksPath` at an empty directory so
 *   received content can never trigger a hook, and only ever check out a commit
 *   the received bundle actually delivered ({@link verifyBundle} +
 *   {@link fetchBundleHead} + an explicit tip/commit re-check in the store).
 *
 * The environment is hardened on BOTH sides: `GIT_CONFIG_GLOBAL` /
 * `GIT_CONFIG_SYSTEM` are pointed at a path that does not exist (git treats an
 * unreadable config file as empty), so ambient user/system git config cannot
 * change behavior; `GIT_TERMINAL_PROMPT=0` guarantees git never blocks on a
 * prompt; the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` identity vars are stripped
 * so commit identity comes only from what a caller passes (they outrank `-c`
 * config). Repo-LOCAL config is always the daemon's or the user's own and is
 * trusted; bundles carry only objects and refs, never config or hooks.
 */
import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Default per-invocation git timeout. Generous; bundle ops on a big repo. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** A 40-char lowercase hex commit hash (git's SHA-1 object name). */
export const COMMIT_HASH_RE = /^[0-9a-f]{40}$/;

/**
 * How long {@link runGit} waits for `close` after issuing the kill before it
 * force-settles anyway (mirrors safeSpawn's watchdog): a killer that exits
 * without reaping a stuck child must not wedge the daemon on the child's pipes.
 */
export const GIT_KILL_GRACE_MS = 2000;

/**
 * Per-stream capture cap for git stdout/stderr. Our commands emit small output
 * (a hash, a verify report); this only guards against a pathological flood.
 */
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

/**
 * A path that intentionally does not exist. Used for `GIT_CONFIG_GLOBAL` /
 * `GIT_CONFIG_SYSTEM`: git treats an unreadable config file as empty, which is
 * the documented way to ignore ambient config. (`os.devNull` is NOT usable —
 * git on Windows rejects the `\\.\NUL` device path.)
 */
const NONEXISTENT_CONFIG_PATH = path.join(
  os.tmpdir(),
  "homefleet-nonexistent-gitconfig-do-not-create",
);

/**
 * Commit identity/date env vars stripped from every spawned git. Git resolves
 * author/committer identity from these ABOVE any `-c user.*` config, so an
 * ambient `GIT_AUTHOR_NAME` in the daemon's environment would silently
 * override the deterministic identity {@link commitAllInWorktree} passes.
 * Config files are already neutralized via `GIT_CONFIG_GLOBAL`/`_SYSTEM`;
 * this closes the env-var channel of the same "ambient state changes git
 * behavior" class.
 */
const STRIPPED_GIT_ENV_VARS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
] as const;

/**
 * The hardened environment every spawned git runs with. Exported so tests
 * can pin its guarantees directly — some of the regressions it prevents are
 * otherwise invisible on an English-locale box (a localized `--shortstat`
 * would make {@link diffStat}'s regex miss and silently report all-zero
 * diffstats, indistinguishable from the legitimate empty-range case).
 */
export function gitChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Ignore ambient user/system git config (see file doc).
    GIT_CONFIG_GLOBAL: NONEXISTENT_CONFIG_PATH,
    GIT_CONFIG_SYSTEM: NONEXISTENT_CONFIG_PATH,
    // Never block on a credential/other prompt.
    GIT_TERMINAL_PROMPT: "0",
    // Pin git's message locale: {@link diffStat} (and failure logging)
    // parse human-readable output that git localizes, so an ambient
    // French/German locale would silently change what git prints.
    LC_ALL: "C",
  };
  // Ambient identity env vars outrank `-c user.*` config; strip them so the
  // identity a caller passes is authoritative (see STRIPPED_GIT_ENV_VARS).
  for (const name of STRIPPED_GIT_ENV_VARS) {
    delete env[name];
  }
  return env;
}

/** Every possible ending of a git invocation, as data (never thrown). */
export interface GitCommandResult {
  /** Process exit code, or `null` when our kill path terminated it. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The timeout fired and the process was killed. */
  timedOut: boolean;
  /** The process could not be spawned at all (e.g. git not on PATH). */
  spawnError?: string;
}

export interface RunGitOptions {
  cwd?: string;
  /** Defaults to {@link DEFAULT_GIT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * `-c key=value` config pairs inserted before the subcommand. The worker
   * side uses this to disable hooks (`core.hooksPath=<empty dir>`).
   */
  config?: string[];
  /** Cancellation; aborting takes the same kill path as the timeout. */
  signal?: AbortSignal;
  /**
   * Test seam: the binary to spawn. Defaults to `"git"`. A test points this at
   * `process.execPath` to exercise the timeout/kill path deterministically
   * (mirrors safeSpawn's `killer`/`killGraceMs` seams).
   */
  binary?: string;
  /** Test seam: override {@link GIT_KILL_GRACE_MS}. */
  killGraceMs?: number;
}

/** `true` iff the git call exited 0. */
export function ok(result: GitCommandResult): boolean {
  return result.code === 0;
}

/** A short, log-safe description of a failed git result. */
export function describeGitFailure(result: GitCommandResult): string {
  if (result.spawnError !== undefined) {
    return `git could not be spawned: ${result.spawnError}`;
  }
  if (result.timedOut) {
    return "git timed out";
  }
  const stderr = result.stderr.trim();
  return `git exited ${result.code}${stderr === "" ? "" : `: ${stderr}`}`;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
    }).once("error", () => {
      // taskkill missing/failed: the timeout outcome is still reported.
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Collects a stream up to the byte cap; overflow is dropped (drained). */
class CappedCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    const budget = MAX_GIT_OUTPUT_BYTES - this.bytes;
    if (budget <= 0) {
      return;
    }
    const kept = chunk.length <= budget ? chunk : chunk.subarray(0, budget);
    this.chunks.push(kept);
    this.bytes += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs one git command to a typed outcome. Never rejects on git-shaped
 * failure: spawn errors, nonzero exits, and timeouts are all encoded in the
 * returned {@link GitCommandResult}. Bounded by `timeoutMs`; on overrun the
 * process (tree) is killed and, if it still does not close, force-settled.
 */
export function runGit(
  args: string[],
  options: RunGitOptions = {},
): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? GIT_KILL_GRACE_MS;
  const binary = options.binary ?? "git";
  const configArgs = (options.config ?? []).flatMap((pair) => ["-c", pair]);
  const finalArgs = [...configArgs, ...args];
  const env = gitChildEnv();

  return new Promise((resolve) => {
    const child = spawn(binary, finalArgs, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env,
    });

    const stdout = new CappedCollector();
    const stderr = new CappedCollector();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let killedByUs = false;
    let timedOut = false;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: GitCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
      if (options.signal !== undefined) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    const kill = (dueToTimeout: boolean): void => {
      if (settled || killedByUs) {
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      killedByUs = true;
      timedOut = dueToTimeout;
      killTree(child);
      watchdog = setTimeout(() => {
        settle({
          code: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
        });
      }, killGraceMs);
    };

    const timer = setTimeout(() => kill(true), timeoutMs);
    const onAbort = (): void => kill(false);
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        // Already aborted: kill as soon as the child exists.
        queueMicrotask(() => kill(false));
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.once("error", (error) => {
      settle({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error.message,
      });
    });

    child.once("close", (code) => {
      settle({
        code: killedByUs ? null : code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
      });
    });
  });
}

/** Thrown by the delegating-side helpers when git fails unexpectedly. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * DELEGATING side: the current committed head of `repoPath` as a 40-hex commit
 * hash. Throws {@link GitError} if the directory is not a git repo, has no
 * commits, or git fails.
 */
export async function resolveHeadCommit(
  repoPath: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], {
    cwd: repoPath,
    timeoutMs,
  });
  if (!ok(result)) {
    throw new GitError(
      `could not resolve HEAD of ${repoPath}: ${describeGitFailure(result)}`,
    );
  }
  const head = result.stdout.trim();
  if (!COMMIT_HASH_RE.test(head)) {
    throw new GitError(`rev-parse HEAD returned an unexpected value: ${head}`);
  }
  return head;
}

/**
 * DELEGATING side: whether `ancestor` is an ancestor of `descendant` in
 * `repoPath` (so an incremental `ancestor..descendant` bundle is possible).
 * A commit unknown to the repo yields `false` (not an error).
 */
export async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<boolean> {
  if (!COMMIT_HASH_RE.test(ancestor) || !COMMIT_HASH_RE.test(descendant)) {
    return false;
  }
  const result = await runGit(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: repoPath, timeoutMs },
  );
  // Exit 0 => ancestor; 1 => not; anything else (e.g. 128, bad object) => not.
  return result.code === 0;
}

export interface CreateBundleOptions {
  /** Repo to bundle from (the delegating side's own repo). */
  repoPath: string;
  /** Absolute path of the bundle file to create. */
  bundlePath: string;
  /** The head to deliver (must be the repo's current HEAD). */
  headCommit: string;
  /**
   * The worker's existing tip, when an incremental bundle is wanted. Must be an
   * ancestor of `headCommit` (verify with {@link isAncestor} first). Absent =>
   * a full bundle.
   */
  have?: string;
  timeoutMs?: number;
}

/**
 * DELEGATING side: writes a git bundle of `HEAD` to `bundlePath`. Full when
 * `have` is absent, otherwise incremental (`HEAD --not <have>`). The bundle
 * records the ref `HEAD` pointing at `headCommit`, which the worker fetches;
 * incremental bundles record `have` as a prerequisite so the worker's
 * `bundle verify` fails unless it already has that commit.
 *
 * The caller MUST ensure `headCommit` is the repo's current HEAD and (for the
 * incremental case) that `have` is a strict ancestor — an empty range makes
 * `git bundle create` fail ("Refusing to create empty bundle").
 */
export async function createBundle(
  options: CreateBundleOptions,
): Promise<void> {
  const { repoPath, bundlePath, have } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const args = ["bundle", "create", bundlePath, "HEAD"];
  if (have !== undefined) {
    if (!COMMIT_HASH_RE.test(have)) {
      throw new GitError(`invalid 'have' commit: ${have}`);
    }
    args.push("--not", have);
  }
  const result = await runGit(args, { cwd: repoPath, timeoutMs });
  if (!ok(result)) {
    throw new GitError(
      `git bundle create failed: ${describeGitFailure(result)}`,
    );
  }
}

/**
 * WORKER-side git context: a bare cache repo and an empty hooks directory that
 * disables hook execution on every call against received content.
 */
export interface WorkerGit {
  /** The bare cache repo (`--git-dir`). */
  repoDir: string;
  /** An existing, empty directory used as `core.hooksPath` (no hooks). */
  hooksPath: string;
  timeoutMs: number;
  /**
   * Cancellation for every call built from this context. The store owns one
   * {@link AbortController} and threads its signal here so a daemon shutdown can
   * cancel an in-flight worker-side git op (fetch/checkout/gc) immediately —
   * aborting takes the same kill path as the timeout, so git returns in ms
   * rather than running to `timeoutMs`. Optional; absent = no cancellation.
   */
  signal?: AbortSignal;
}

/**
 * Worker-side `-c` config applied to every call against received content:
 * - `core.hooksPath=<empty dir>` — received content can never trigger a hook.
 * - `protocol.ext.allow=never` — a `ext::` transport (which runs an arbitrary
 *   program) is refused, so no fetch/bundle path can execute a command even if
 *   a future change introduced one.
 * - `fetch.recurseSubmodules=false` — a submodule reference in received content
 *   never triggers a recursive fetch (another program-execution / SSRF vector).
 * The exec-from-content vector is closed today by the empty hooksPath; the last
 * two flags keep it closed by construction against future changes.
 * - `core.longpaths=true` — on Windows, `git worktree add` refuses to
 *   materialize a working tree whose absolute paths exceed MAX_PATH (260 chars)
 *   unless git is opted into long-path mode. The per-repo checkout cache lives
 *   under a deep data dir, so real repos (e.g. our own `docs/adr/*.md`) tip past
 *   260 and the checkout fails with exit 128 "Filename too long". This MUST be
 *   set here, not left to ambient config: {@link runGit} deliberately points
 *   `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at a nonexistent path, so the
 *   operator's `git config --global core.longpaths` (and the OS LongPathsEnabled
 *   registry key, which git's own path check ignores) never reach the worker.
 *   Harmless on POSIX, where the limit does not exist. (M8 two-machine rig find.)
 */
function workerConfig(worker: WorkerGit): string[] {
  return [
    `core.hooksPath=${worker.hooksPath}`,
    "protocol.ext.allow=never",
    "fetch.recurseSubmodules=false",
    "core.longpaths=true",
  ];
}

/**
 * WORKER side: `git bundle verify`. Returns `true` iff the bundle is a
 * structurally valid bundle AND all of its prerequisites are already present
 * in the cache repo (so an incremental bundle from an unknown base is
 * rejected). A garbage file returns `false`.
 */
export async function verifyBundle(
  worker: WorkerGit,
  bundlePath: string,
): Promise<boolean> {
  const result = await runGit(["bundle", "verify", bundlePath], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  return ok(result);
}

/**
 * WORKER side: the refs a bundle advertises, as a `ref -> commit` map, read
 * from the bundle HEADER only (`git bundle list-heads` imports NO objects). A
 * cheap pre-fetch gate: the caller rejects a bundle whose advertised `HEAD`
 * does not match the claimed commit BEFORE fetching, so a "claims X, advertises
 * Y" bundle never imports objects into the cache. Returns an empty map on a
 * garbage/unreadable bundle.
 */
export async function listBundleHeads(
  worker: WorkerGit,
  bundlePath: string,
): Promise<Map<string, string>> {
  const result = await runGit(["bundle", "list-heads", bundlePath], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  const heads = new Map<string, string>();
  if (!ok(result)) {
    return heads;
  }
  for (const line of result.stdout.split("\n")) {
    // Each line is "<40-hex sha> <refname>".
    const match = /^([0-9a-f]{40})\s+(\S+)/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      heads.set(match[2], match[1]);
    }
  }
  return heads;
}

/**
 * WORKER side: reclaim unreachable objects in the bare cache repo with
 * `git gc --prune=now`. Safe here: the only reachability anchors are the tip
 * ref and any live worktrees' HEADs, so an in-use checkout's commits are never
 * pruned; objects left by a rejected (unbundled-then-discarded) upload are.
 * Expensive, so the caller gates how often it runs — always under the per-repo
 * lock so it cannot race a fetch or checkout.
 */
export async function gc(worker: WorkerGit): Promise<GitCommandResult> {
  return runGit(["gc", "--prune=now", "--quiet"], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
}

/** Parsed `git count-objects -v` — object-store size accounting. */
export interface ObjectCounts {
  /** Loose (unpacked) object count. */
  count: number;
  /** Loose object disk size, in KiB. */
  sizeKiB: number;
  /** Objects stored in packs. */
  inPack: number;
  /** Pack disk size, in KiB. */
  sizePackKiB: number;
}

/** WORKER side: object-store accounting via `git count-objects -v`. */
export async function countObjects(worker: WorkerGit): Promise<ObjectCounts> {
  const result = await runGit(["count-objects", "-v"], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  const fields = new Map<string, number>();
  if (ok(result)) {
    for (const line of result.stdout.split("\n")) {
      const match = /^(\S+):\s+(\d+)/.exec(line.trim());
      if (match?.[1] !== undefined && match[2] !== undefined) {
        fields.set(match[1], Number.parseInt(match[2], 10));
      }
    }
  }
  return {
    count: fields.get("count") ?? 0,
    sizeKiB: fields.get("size") ?? 0,
    inPack: fields.get("in-pack") ?? 0,
    sizePackKiB: fields.get("size-pack") ?? 0,
  };
}

/**
 * WORKER side: fetch the bundle's `HEAD` ref into `intoRef` in the cache repo,
 * bringing its objects in. `intoRef` should be a scratch ref the caller
 * validates before advancing the real tip.
 */
export async function fetchBundleHead(
  worker: WorkerGit,
  bundlePath: string,
  intoRef: string,
): Promise<GitCommandResult> {
  return runGit(["fetch", "--quiet", bundlePath, `+HEAD:${intoRef}`], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
}

/**
 * WORKER side: resolve a ref/rev to a commit hash, or `null` if it does not
 * exist. Used to read the current tip and to read a scratch ref back.
 */
export async function revParse(
  worker: WorkerGit,
  rev: string,
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", rev], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  if (!ok(result)) {
    return null;
  }
  const value = result.stdout.trim();
  return COMMIT_HASH_RE.test(value) ? value : null;
}

/**
 * WORKER side: the commit a materialized checkout worktree currently has
 * checked out, or `null` if the directory is missing or not a usable worktree.
 * Runs IN `checkoutDir` (its `.git` gitlink resolves to the cache repo's
 * per-worktree metadata) rather than against the bare `repoDir` — a bare
 * repo's own HEAD says nothing about any worktree. Used by the store to
 * verify a reused checkout dir really holds the requested commit: checkout
 * dir names carry only a truncated commit key, so reuse must be verified.
 */
export async function worktreeHead(
  worker: WorkerGit,
  checkoutDir: string,
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: checkoutDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  if (!ok(result)) {
    return null;
  }
  const value = result.stdout.trim();
  return COMMIT_HASH_RE.test(value) ? value : null;
}

/** WORKER side: whether `commit` exists as a commit object in the cache repo. */
export async function commitPresent(
  worker: WorkerGit,
  commit: string,
): Promise<boolean> {
  if (!COMMIT_HASH_RE.test(commit)) {
    return false;
  }
  const result = await runGit(["cat-file", "-e", `${commit}^{commit}`], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  return ok(result);
}

/** WORKER side: point `ref` at `commit` (creates or moves it). */
export async function updateRef(
  worker: WorkerGit,
  ref: string,
  commit: string,
): Promise<GitCommandResult> {
  return runGit(["update-ref", ref, commit], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
}

/** WORKER side: delete `ref` if it exists (best effort). */
export async function deleteRef(worker: WorkerGit, ref: string): Promise<void> {
  await runGit(["update-ref", "-d", ref], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
}

/**
 * WORKER side (write-job finalize): stages EVERY working-tree change in
 * `worktreeDir` (`git add -A` semantics — new, modified, AND deleted files)
 * and commits it in one commit. Returns the new head's 40-hex hash, or
 * `null` when the tree is clean (nothing to stage — the caller's signal that
 * the job produced no changes). Throws {@link GitError} on any failure.
 *
 * The passed identity becomes BOTH author and committer: `-c user.name` /
 * `-c user.email` feed both sides, and {@link runGit} strips the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars (which would outrank `-c`
 * config) from every spawned git, so ambient daemon environment can never
 * override it. Hooks stay neutralized via {@link workerConfig}; signing is
 * pinned off so a commit can never block on a signer.
 */
export async function commitAllInWorktree(
  worker: WorkerGit,
  worktreeDir: string,
  options: { message: string; authorName: string; authorEmail: string },
): Promise<string | null> {
  const runOptions: RunGitOptions = {
    cwd: worktreeDir,
    timeoutMs: worker.timeoutMs,
    config: [
      ...workerConfig(worker),
      `user.name=${options.authorName}`,
      `user.email=${options.authorEmail}`,
      "commit.gpgsign=false",
    ],
    signal: worker.signal,
  };
  const added = await runGit(["add", "-A"], runOptions);
  if (!ok(added)) {
    throw new GitError(`git add -A failed: ${describeGitFailure(added)}`);
  }
  // `--cached --quiet` compares the index against HEAD: exit 0 = nothing
  // staged (clean tree), exit 1 = changes staged, anything else = failure.
  const staged = await runGit(["diff", "--cached", "--quiet"], runOptions);
  if (staged.code === 0) {
    return null;
  }
  if (staged.code !== 1) {
    throw new GitError(
      `git diff --cached failed: ${describeGitFailure(staged)}`,
    );
  }
  const committed = await runGit(
    ["commit", "--quiet", "-m", options.message],
    runOptions,
  );
  if (!ok(committed)) {
    throw new GitError(`git commit failed: ${describeGitFailure(committed)}`);
  }
  const head = await runGit(
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    runOptions,
  );
  const value = head.stdout.trim();
  if (!ok(head) || !COMMIT_HASH_RE.test(value)) {
    throw new GitError(
      `could not read the committed head: ${describeGitFailure(head)}`,
    );
  }
  return value;
}

/** Parsed `git diff --shortstat` accounting for a `base..head` range. */
export interface DiffStatCounts {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * WORKER side (write-job finalize): `base..head` change accounting via
 * `git diff --shortstat`, run in `cwd` (any repo or worktree that can see
 * both commits). Rename detection is forced on (`--find-renames`) so a pure
 * rename counts as one changed file with zero line churn regardless of
 * config defaults. A zero-change range yields all zeros (shortstat prints
 * nothing for it). Throws {@link GitError} on failure.
 */
export async function diffStat(
  worker: WorkerGit,
  cwd: string,
  base: string,
  head: string,
): Promise<DiffStatCounts> {
  const result = await runGit(
    ["diff", "--shortstat", "--find-renames", base, head],
    {
      cwd,
      timeoutMs: worker.timeoutMs,
      config: workerConfig(worker),
      signal: worker.signal,
    },
  );
  if (!ok(result)) {
    throw new GitError(
      `git diff --shortstat failed: ${describeGitFailure(result)}`,
    );
  }
  const match =
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
      result.stdout,
    );
  if (match === null) {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
  return {
    filesChanged: Number.parseInt(match[1] ?? "0", 10),
    insertions: Number.parseInt(match[2] ?? "0", 10),
    deletions: Number.parseInt(match[3] ?? "0", 10),
  };
}

/**
 * WORKER side (write-job finalize): writes an incremental bundle of
 * `ref --not base` from the bare cache repo — the write job's artifact
 * bundle. The bundle advertises exactly one ref (the job's result branch)
 * and records `base` as a prerequisite, so the receiving side's
 * `git bundle verify` refuses it unless it already holds the base commit
 * (the delegator does by construction: it bundled that commit to us). The
 * caller guarantees `base` is a strict ancestor of `ref`'s tip — an empty
 * range makes `git bundle create` fail ("Refusing to create empty bundle").
 * Throws {@link GitError} only on a malformed `base`; git-level failure is
 * returned as data.
 */
export async function createWorkerBundle(
  worker: WorkerGit,
  options: { bundlePath: string; ref: string; base: string },
): Promise<GitCommandResult> {
  if (!COMMIT_HASH_RE.test(options.base)) {
    throw new GitError(`invalid bundle base commit: ${options.base}`);
  }
  return runGit(
    [
      "bundle",
      "create",
      options.bundlePath,
      options.ref,
      "--not",
      options.base,
    ],
    {
      cwd: worker.repoDir,
      timeoutMs: worker.timeoutMs,
      config: workerConfig(worker),
      signal: worker.signal,
    },
  );
}

/**
 * WORKER side: materialize a clean, detached checkout of `commit` into
 * `checkoutDir` via a git worktree (objects are shared with the cache repo; no
 * shared HEAD is touched, so concurrent checkouts do not collide). The caller
 * MUST have already confirmed `commit` is present. Hooks are disabled.
 */
export async function addWorktree(
  worker: WorkerGit,
  checkoutDir: string,
  commit: string,
): Promise<GitCommandResult> {
  return runGit(
    ["worktree", "add", "--detach", "--force", checkoutDir, commit],
    {
      cwd: worker.repoDir,
      timeoutMs: worker.timeoutMs,
      config: workerConfig(worker),
      signal: worker.signal,
    },
  );
}

/**
 * WORKER side: remove a worktree (eviction). Best effort: prunes stale
 * administrative entries afterward so a partially-removed worktree does not
 * accumulate.
 */
export async function removeWorktree(
  worker: WorkerGit,
  checkoutDir: string,
): Promise<void> {
  await runGit(["worktree", "remove", "--force", checkoutDir], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
  await runGit(["worktree", "prune"], {
    cwd: worker.repoDir,
    timeoutMs: worker.timeoutMs,
    config: workerConfig(worker),
    signal: worker.signal,
  });
}

/**
 * WORKER side: initialize a bare cache repo at `repoDir` (idempotent). Takes an
 * optional `signal` (rather than a full {@link WorkerGit}, since there is no
 * repo yet) so a shutdown can cancel even this first op.
 */
export async function initBareRepo(
  repoDir: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit(["init", "--quiet", "--bare", repoDir], {
    timeoutMs,
    signal,
  });
  if (!ok(result)) {
    throw new GitError(
      `could not init bare repo at ${repoDir}: ${describeGitFailure(result)}`,
    );
  }
}
