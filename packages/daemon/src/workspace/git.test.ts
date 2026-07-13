/**
 * Unit tests for the safe git wrapper (M7). Uses REAL git against REAL repos
 * created in temp dirs — no faking of git. The timeout/kill path is exercised
 * via the `binary` test seam (a long-lived `node` child).
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import {
  addWorktree,
  COMMIT_HASH_RE,
  commitAllInWorktree,
  commitPresent,
  createBundle,
  createWorkerBundle,
  diffStat,
  fetchBundleHead,
  initBareRepo,
  isAncestor,
  listBundleHeads,
  ok,
  removeWorktree,
  resolveHeadCommit,
  revParse,
  runGit,
  updateRef,
  verifyBundle,
  type WorkerGit,
} from "./git.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDataDir(prefix);
  cleanups.push(() => removeTempDataDir(dir));
  return dir;
}

/** A real repo we can commit into step by step. */
interface TestRepo {
  repoPath: string;
  /** Appends a line, commits, and returns the new HEAD commit hash. */
  commit(message: string): Promise<string>;
}

async function makeRepo(): Promise<TestRepo> {
  const repoPath = await tempDir("homefleet-git-src-");
  const run = async (args: string[]): Promise<void> => {
    const result = await runGit(args, { cwd: repoPath, timeoutMs: 30_000 });
    if (!ok(result)) {
      throw new Error(`setup git ${args.join(" ")} failed: ${result.stderr}`);
    }
  };
  await run(["init", "--quiet"]);
  await run(["config", "user.email", "t@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  let n = 0;
  return {
    repoPath,
    async commit(message: string): Promise<string> {
      await writeFile(path.join(repoPath, "file.txt"), `line ${n}\n`, {
        flag: n === 0 ? "w" : "a",
      });
      n += 1;
      await run(["add", "-A"]);
      await run(["commit", "--quiet", "-m", message]);
      return resolveHeadCommit(repoPath, 30_000);
    },
  };
}

async function makeWorker(): Promise<WorkerGit> {
  const root = await tempDir("homefleet-git-cache-");
  const repoDir = path.join(root, "repo.git");
  const hooksPath = path.join(root, "no-hooks");
  await mkdir(hooksPath, { recursive: true });
  await initBareRepo(repoDir, 30_000);
  return { repoDir, hooksPath, timeoutMs: 30_000 };
}

test("resolveHeadCommit returns the 40-hex HEAD of a real repo", async () => {
  const repo = await makeRepo();
  const c1 = await repo.commit("c1");
  const head = await resolveHeadCommit(repo.repoPath, 30_000);
  expect(head).toMatch(COMMIT_HASH_RE);
  expect(head).toBe(c1);
});

test("resolveHeadCommit throws on a directory that is not a git repo", async () => {
  const dir = await tempDir("homefleet-not-a-repo-");
  await expect(resolveHeadCommit(dir, 30_000)).rejects.toThrow();
});

test("isAncestor reflects the real commit graph", async () => {
  const repo = await makeRepo();
  const c1 = await repo.commit("c1");
  const c2 = await repo.commit("c2");
  expect(await isAncestor(repo.repoPath, c1, c2, 30_000)).toBe(true);
  expect(await isAncestor(repo.repoPath, c2, c1, 30_000)).toBe(false);
  // An unknown commit is 'not an ancestor', not an error.
  expect(await isAncestor(repo.repoPath, "a".repeat(40), c2, 30_000)).toBe(
    false,
  );
});

test("full bundle: create, verify in a fresh cache, fetch, checkout", async () => {
  const repo = await makeRepo();
  const head = await repo.commit("c1");
  const bundleDir = await tempDir("homefleet-bundle-");
  const bundlePath = path.join(bundleDir, "full.bundle");
  await createBundle({ repoPath: repo.repoPath, bundlePath, headCommit: head });
  expect((await stat(bundlePath)).size).toBeGreaterThan(0);

  const worker = await makeWorker();
  expect(await verifyBundle(worker, bundlePath)).toBe(true);
  const fetched = await fetchBundleHead(worker, bundlePath, "refs/hf/incoming");
  expect(ok(fetched)).toBe(true);
  expect(await revParse(worker, "refs/hf/incoming")).toBe(head);
  expect(await commitPresent(worker, head)).toBe(true);

  const checkoutDir = path.join(await tempDir("homefleet-co-"), "wt");
  const added = await addWorktree(worker, checkoutDir, head);
  expect(ok(added)).toBe(true);
  expect(await readFile(path.join(checkoutDir, "file.txt"), "utf8")).toContain(
    "line 0",
  );
  // Eviction removes the working directory.
  await removeWorktree(worker, checkoutDir);
  await expect(stat(checkoutDir)).rejects.toThrow();
});

test("incremental bundle: verify fails without the prerequisite, succeeds with it", async () => {
  const repo = await makeRepo();
  const c1 = await repo.commit("c1");
  const bundleDir = await tempDir("homefleet-bundle-");
  // Full bundle captured while HEAD === c1.
  const fullPath = path.join(bundleDir, "full.bundle");
  await createBundle({
    repoPath: repo.repoPath,
    bundlePath: fullPath,
    headCommit: c1,
  });
  // Advance HEAD to c2 and make an incremental c1..c2 bundle.
  const c2 = await repo.commit("c2");
  const incrPath = path.join(bundleDir, "incr.bundle");
  await createBundle({
    repoPath: repo.repoPath,
    bundlePath: incrPath,
    headCommit: c2,
    have: c1,
  });

  // A fresh cache lacking c1 (the prerequisite) must reject the incremental.
  const fresh = await makeWorker();
  expect(await verifyBundle(fresh, incrPath)).toBe(false);

  // A cache that received c1 already has the prerequisite: incremental applies.
  const worker = await makeWorker();
  expect(await verifyBundle(worker, fullPath)).toBe(true);
  await fetchBundleHead(worker, fullPath, "refs/homefleet/tip");
  expect(await commitPresent(worker, c1)).toBe(true);
  expect(await verifyBundle(worker, incrPath)).toBe(true);
  const fetched = await fetchBundleHead(worker, incrPath, "refs/hf/incoming");
  expect(ok(fetched)).toBe(true);
  expect(await revParse(worker, "refs/hf/incoming")).toBe(c2);
  expect(await commitPresent(worker, c2)).toBe(true);
});

test("verifyBundle returns false for a garbage (non-bundle) file", async () => {
  const worker = await makeWorker();
  const dir = await tempDir("homefleet-garbage-");
  const garbage = path.join(dir, "garbage.bundle");
  await writeFile(garbage, "this is definitely not a git bundle\n");
  expect(await verifyBundle(worker, garbage)).toBe(false);
});

test("addWorktree checks out a file whose absolute path exceeds Windows MAX_PATH (260)", async () => {
  // MAX_PATH only bites on Windows; POSIX handles long paths natively, so this
  // regression is win32-only. The M8 two-machine rig surfaced it: the worker
  // git checkout fails with exit 128 "Filename too long" on deep repo files
  // (e.g. docs/adr/*.md) once the checkout-base + relative path crosses 260.
  // The daemon isolates git from ambient config (runGit points
  // GIT_CONFIG_GLOBAL/SYSTEM at a nonexistent path), so a user/registry-level
  // long-path setting can't reach the worker — the flag must come from
  // workerConfig(). NB: this is the *file-too-long* mode, distinct from the
  // separate "$GIT_DIR too big" limit that a >260 *checkout dir itself* hits;
  // core.longpaths fixes this mode, which is the one real repos actually hit.
  if (process.platform !== "win32") return;

  // Source repo with a deep file. Keep the SOURCE absolute path < 255 so it can
  // be created/committed without long-path support; the WORKER checkout base is
  // deeper, tipping the same file past 260 on checkout.
  const repoPath = await tempDir("homefleet-git-longsrc-");
  const run = async (args: string[]): Promise<void> => {
    const r = await runGit(args, { cwd: repoPath, timeoutMs: 30_000 });
    if (!ok(r)) throw new Error(`setup git ${args.join(" ")}: ${r.stderr}`);
  };
  await run(["init", "--quiet"]);
  await run(["config", "user.email", "t@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  const seg = "d".repeat(40);
  const rel = path.join("deep", seg, seg, seg, "leaf.txt");
  const srcAbs = path.join(repoPath, rel);
  expect(srcAbs.length).toBeLessThan(255); // source creation stays under the limit
  await mkdir(path.dirname(srcAbs), { recursive: true });
  await writeFile(srcAbs, "hello from a very long path\n");
  await run(["add", "-A"]);
  await run(["commit", "--quiet", "-m", "deep file"]);
  const head = await resolveHeadCommit(repoPath, 30_000);

  const bundleDir = await tempDir("homefleet-bundle-long-");
  const bundlePath = path.join(bundleDir, "full.bundle");
  await createBundle({ repoPath, bundlePath, headCommit: head });
  const worker = await makeWorker();
  const fetched = await fetchBundleHead(worker, bundlePath, "refs/hf/incoming");
  expect(ok(fetched)).toBe(true);

  // Moderate checkout DIR (avoids the separate "$GIT_DIR too big" limit) whose
  // materialized file path nonetheless exceeds 260.
  const coRoot = await tempDir("homefleet-co-");
  const checkoutDir = path.join(coRoot, "e".repeat(70), "wt");
  expect(checkoutDir.length).toBeLessThan(250);
  expect(path.join(checkoutDir, rel).length).toBeGreaterThan(260);

  // Without core.longpaths this fails with git exit 128 "Filename too long";
  // a clean exit means git materialized the >260-char file. (We assert on git's
  // exit rather than reading the file back, to avoid depending on Node's own
  // long-path support on machines without the OS LongPathsEnabled key.)
  const added = await addWorktree(worker, checkoutDir, head);
  expect(ok(added)).toBe(true);
});

test("createBundle refuses an empty range (have === head)", async () => {
  const repo = await makeRepo();
  const head = await repo.commit("c1");
  const bundleDir = await tempDir("homefleet-bundle-");
  await expect(
    createBundle({
      repoPath: repo.repoPath,
      bundlePath: path.join(bundleDir, "empty.bundle"),
      headCommit: head,
      have: head,
    }),
  ).rejects.toThrow();
});

test("runGit encodes a nonzero exit as data, not a throw", async () => {
  const dir = await tempDir("homefleet-notrepo-");
  const result = await runGit(["rev-parse", "HEAD"], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  expect(result.spawnError).toBeUndefined();
  expect(result.code).not.toBe(0);
  expect(result.timedOut).toBe(false);
});

test("runGit times out and kills a wedged process (via the binary seam)", async () => {
  const result = await runGit(["-e", "setTimeout(() => {}, 30000)"], {
    binary: process.execPath,
    timeoutMs: 250,
    killGraceMs: 500,
  });
  expect(result.timedOut).toBe(true);
  expect(result.code).toBeNull();
});

test("runGit honors an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runGit(["-e", "setTimeout(() => {}, 30000)"], {
    binary: process.execPath,
    timeoutMs: 30_000,
    killGraceMs: 500,
    signal: controller.signal,
  });
  expect(result.code).toBeNull();
  expect(result.timedOut).toBe(false);
});

test("updateRef advances a tip that revParse reads back", async () => {
  const repo = await makeRepo();
  const head = await repo.commit("c1");
  const bundleDir = await tempDir("homefleet-bundle-");
  const bundlePath = path.join(bundleDir, "full.bundle");
  await createBundle({ repoPath: repo.repoPath, bundlePath, headCommit: head });
  const worker = await makeWorker();
  await fetchBundleHead(worker, bundlePath, "refs/hf/incoming");
  await updateRef(worker, "refs/homefleet/tip", head);
  expect(await revParse(worker, "refs/homefleet/tip")).toBe(head);
  expect(await revParse(worker, "refs/homefleet/missing")).toBeNull();
});

// --- write-job finalize helpers (v0.2) --------------------------------------

/**
 * Source commit -> worker cache -> detached worktree: the shape a write job's
 * ephemeral worktree has when finalize runs. The base commit carries TWO
 * files (`file.txt` = "line 0\n", `extra.txt`) so a deletion can be staged.
 */
async function makeWorkerWorktree(): Promise<{
  worker: WorkerGit;
  worktreeDir: string;
  base: string;
}> {
  const repo = await makeRepo();
  await writeFile(path.join(repo.repoPath, "extra.txt"), "delete me\n");
  const base = await repo.commit("c1"); // commit() stages -A: both files
  const bundlePath = path.join(await tempDir("homefleet-bundle-"), "b.bundle");
  await createBundle({ repoPath: repo.repoPath, bundlePath, headCommit: base });
  const worker = await makeWorker();
  const fetched = await fetchBundleHead(
    worker,
    bundlePath,
    "refs/homefleet/tip",
  );
  if (!ok(fetched)) {
    throw new Error(`fixture fetch failed: ${fetched.stderr}`);
  }
  const worktreeDir = path.join(await tempDir("homefleet-wt-"), "wt");
  const added = await addWorktree(worker, worktreeDir, base);
  if (!ok(added)) {
    throw new Error(`fixture worktree failed: ${added.stderr}`);
  }
  return { worker, worktreeDir, base };
}

const JOB_IDENTITY = {
  authorName: "HomeFleet Worker",
  authorEmail: "worker@abcd1234.invalid",
};
const JOB_SIGNATURE =
  "HomeFleet Worker <worker@abcd1234.invalid> " +
  "HomeFleet Worker <worker@abcd1234.invalid>";

test("commitAllInWorktree stages new/modified/deleted files in ONE commit with author AND committer identity", async () => {
  const { worker, worktreeDir, base } = await makeWorkerWorktree();
  await writeFile(path.join(worktreeDir, "new.txt"), "brand new\n");
  await writeFile(path.join(worktreeDir, "file.txt"), "line 0\nmodified\n");
  await rm(path.join(worktreeDir, "extra.txt"));

  const head = await commitAllInWorktree(worker, worktreeDir, {
    message: "job: apply the requested change",
    ...JOB_IDENTITY,
  });

  if (head === null) {
    throw new Error("expected a commit on a dirtied tree");
  }
  expect(head).toMatch(COMMIT_HASH_RE);
  expect(head).not.toBe(base);
  // Author AND committer are the passed identity (design doc §2, "Commit").
  const identity = await runGit(
    ["log", "-1", "--format=%an <%ae> %cn <%ce>", head],
    { cwd: worktreeDir, timeoutMs: 30_000 },
  );
  expect(identity.stdout.trim()).toBe(JOB_SIGNATURE);
  const subject = await runGit(["log", "-1", "--format=%s", head], {
    cwd: worktreeDir,
    timeoutMs: 30_000,
  });
  expect(subject.stdout.trim()).toBe("job: apply the requested change");
  // All three change kinds landed in the one commit (`git add -A` semantics).
  const status = await runGit(
    ["diff", "--name-status", "--no-renames", base, head],
    { cwd: worktreeDir, timeoutMs: 30_000 },
  );
  const lines = status.stdout
    .trim()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " "))
    .sort();
  expect(lines).toEqual(["A new.txt", "D extra.txt", "M file.txt"]);
}, 30_000);

test("commitAllInWorktree returns null on a clean tree and does not move HEAD", async () => {
  const { worker, worktreeDir, base } = await makeWorkerWorktree();

  const head = await commitAllInWorktree(worker, worktreeDir, {
    message: "nothing to commit",
    ...JOB_IDENTITY,
  });

  expect(head).toBeNull();
  const current = await runGit(["rev-parse", "HEAD"], {
    cwd: worktreeDir,
    timeoutMs: 30_000,
  });
  expect(current.stdout.trim()).toBe(base);
}, 30_000);

test("ambient GIT_AUTHOR_*/GIT_COMMITTER_* env cannot override the passed commit identity", async () => {
  // Git resolves identity from GIT_AUTHOR_*/GIT_COMMITTER_* env vars ABOVE
  // `-c user.*` config, so runGit must strip them from the child env the
  // same way it neutralizes ambient config files.
  const { worker, worktreeDir } = await makeWorkerWorktree();
  await writeFile(path.join(worktreeDir, "new.txt"), "x\n");
  const keys = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_AUTHOR_NAME = "Ambient Author";
  process.env.GIT_AUTHOR_EMAIL = "ambient-author@example.com";
  process.env.GIT_COMMITTER_NAME = "Ambient Committer";
  process.env.GIT_COMMITTER_EMAIL = "ambient-committer@example.com";
  try {
    const head = await commitAllInWorktree(worker, worktreeDir, {
      message: "identity pin",
      ...JOB_IDENTITY,
    });
    if (head === null) {
      throw new Error("expected a commit on a dirtied tree");
    }
    const identity = await runGit(
      ["log", "-1", "--format=%an <%ae> %cn <%ce>", head],
      { cwd: worktreeDir, timeoutMs: 30_000 },
    );
    expect(identity.stdout.trim()).toBe(JOB_SIGNATURE);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}, 30_000);

test("diffStat parses zero-change, insertions-only, deletions-only, and mixed ranges", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo.repoPath, "extra.txt"), "one\ntwo\n");
  const c1 = await repo.commit("c1"); // file.txt (1 line) + extra.txt (2 lines)
  const c2 = await repo.commit("c2"); // appends one line to file.txt
  const runIn = async (args: string[]): Promise<void> => {
    const result = await runGit(args, {
      cwd: repo.repoPath,
      timeoutMs: 30_000,
    });
    if (!ok(result)) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
  };
  await rm(path.join(repo.repoPath, "extra.txt"));
  await runIn(["add", "-A"]);
  await runIn(["commit", "--quiet", "-m", "c3: delete extra.txt"]);
  const c3 = await resolveHeadCommit(repo.repoPath, 30_000);

  const worker = await makeWorker(); // supplies timeout/config; cwd names the repo
  expect(await diffStat(worker, repo.repoPath, c1, c1)).toEqual({
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  });
  expect(await diffStat(worker, repo.repoPath, c1, c2)).toEqual({
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  expect(await diffStat(worker, repo.repoPath, c2, c3)).toEqual({
    filesChanged: 1,
    insertions: 0,
    deletions: 2,
  });
  expect(await diffStat(worker, repo.repoPath, c1, c3)).toEqual({
    filesChanged: 2,
    insertions: 1,
    deletions: 2,
  });
}, 30_000);

test("diffStat pins a rename-only commit as changed-with-zero-churn", async () => {
  const repo = await makeRepo();
  const c1 = await repo.commit("c1");
  const runIn = async (args: string[]): Promise<void> => {
    const result = await runGit(args, {
      cwd: repo.repoPath,
      timeoutMs: 30_000,
    });
    if (!ok(result)) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
  };
  await runIn(["mv", "file.txt", "renamed.txt"]);
  await runIn(["commit", "--quiet", "-m", "rename only"]);
  const c2 = await resolveHeadCommit(repo.repoPath, 30_000);

  const worker = await makeWorker();
  const stat = await diffStat(worker, repo.repoPath, c1, c2);
  expect(stat.filesChanged).toBeGreaterThanOrEqual(1);
  expect(stat.insertions).toBe(0);
  expect(stat.deletions).toBe(0);
}, 30_000);

test("createWorkerBundle bundles ref --not base from the bare repo; heads and verify line up", async () => {
  const { worker, worktreeDir, base } = await makeWorkerWorktree();
  await writeFile(path.join(worktreeDir, "new.txt"), "artifact content\n");
  const head = await commitAllInWorktree(worker, worktreeDir, {
    message: "artifact commit",
    ...JOB_IDENTITY,
  });
  if (head === null) {
    throw new Error("expected a commit on a dirtied tree");
  }
  // The worktree shares the bare repo's object store: the new commit is
  // already visible there, so the result ref can be minted in the bare repo.
  const ref = "refs/heads/homefleet/aaaaaaaaaaaa";
  expect(ok(await updateRef(worker, ref, head))).toBe(true);

  const bundlePath = path.join(
    await tempDir("homefleet-bundle-"),
    "artifact.bundle",
  );
  const created = await createWorkerBundle(worker, { bundlePath, ref, base });
  expect(ok(created)).toBe(true);
  expect((await stat(bundlePath)).size).toBeGreaterThan(0);

  // Exactly one advertised ref: the result branch at the new head.
  const heads = await listBundleHeads(worker, bundlePath);
  expect([...heads.entries()]).toEqual([[ref, head]]);
  // The bare repo holds the prerequisite (base), so verify accepts it...
  expect(await verifyBundle(worker, bundlePath)).toBe(true);
  // ...while a fresh cache without base rejects it (a real incremental).
  const fresh = await makeWorker();
  expect(await verifyBundle(fresh, bundlePath)).toBe(false);
}, 30_000);

test("createWorkerBundle refuses a malformed base commit", async () => {
  const worker = await makeWorker();
  await expect(
    createWorkerBundle(worker, {
      bundlePath: path.join(await tempDir("homefleet-bundle-"), "x.bundle"),
      ref: "refs/heads/homefleet/aaaaaaaaaaaa",
      base: "not-a-commit",
    }),
  ).rejects.toThrow(/invalid/);
});
