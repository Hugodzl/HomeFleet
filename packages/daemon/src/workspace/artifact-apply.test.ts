/**
 * Unit tests for the delegator-side artifact apply gate (v0.2 Task 9).
 *
 * Uses REAL git against REAL temp repos: a "source" repo plays the user's
 * repository, and artifacts are produced through the actual write-job chain
 * (full bundle -> worker cache -> worktree -> commitAllInWorktree ->
 * createWorkerBundle), so every bundle under test is byte-for-byte what a
 * real worker would ship.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WriteArtifact } from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { ApplyError, applyWriteArtifact } from "./artifact-apply.js";
import {
  addWorktree,
  commitAllInWorktree,
  createBundle,
  createWorkerBundle,
  delegatorConfig,
  fetchBundleHead,
  initBareRepo,
  ok,
  resolveHeadCommit,
  runGit,
  updateRef,
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

/** A real repo we can commit into step by step (mirrors git.test.ts). */
interface TestRepo {
  repoPath: string;
  commit(message: string): Promise<string>;
}

async function makeRepo(): Promise<TestRepo> {
  const repoPath = await tempDir("hf-apply-src-");
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
  const root = await tempDir("hf-apply-cache-");
  const repoDir = path.join(root, "repo.git");
  const hooksPath = path.join(root, "no-hooks");
  await mkdir(hooksPath, { recursive: true });
  await initBareRepo(repoDir, 30_000);
  return { repoDir, hooksPath, timeoutMs: 30_000 };
}

const BRANCH = "homefleet/aaaaaaaaaaaa";
const REF = `refs/heads/${BRANCH}`;

interface ArtifactFixture {
  repo: TestRepo;
  worker: WorkerGit;
  base: string;
  head: string;
  bundlePath: string;
  hooksPathDir: string;
  artifact: WriteArtifact;
}

/**
 * The full real chain: source repo -> full bundle -> worker cache ->
 * worktree at base -> one job commit -> result ref -> incremental artifact
 * bundle (exactly what Task 6's finalize produces).
 */
async function makeArtifactFixture(): Promise<ArtifactFixture> {
  const repo = await makeRepo();
  const base = await repo.commit("c1");

  const worker = await makeWorker();
  const inBundle = path.join(await tempDir("hf-apply-in-"), "in.bundle");
  await createBundle({
    repoPath: repo.repoPath,
    bundlePath: inBundle,
    headCommit: base,
  });
  const fetched = await fetchBundleHead(worker, inBundle, "refs/homefleet/tip");
  if (!ok(fetched)) {
    throw new Error(`fixture fetch failed: ${fetched.stderr}`);
  }

  const worktreeDir = path.join(await tempDir("hf-apply-wt-"), "wt");
  const added = await addWorktree(worker, worktreeDir, base);
  if (!ok(added)) {
    throw new Error(`fixture worktree failed: ${added.stderr}`);
  }
  await writeFile(path.join(worktreeDir, "result.txt"), "job output\n");
  const head = await commitAllInWorktree(worker, worktreeDir, {
    message: "job: produce the result",
    authorName: "HomeFleet Worker",
    authorEmail: "worker@abcd1234.invalid",
  });
  if (head === null) {
    throw new Error("fixture expected a commit on a dirtied tree");
  }
  const setRef = await updateRef(worker, REF, head);
  if (!ok(setRef)) {
    throw new Error(`fixture update-ref failed: ${setRef.stderr}`);
  }

  const bundlePath = path.join(
    await tempDir("hf-apply-out-"),
    "artifact.bundle",
  );
  const created = await createWorkerBundle(worker, {
    bundlePath,
    ref: REF,
    base,
  });
  if (!ok(created)) {
    throw new Error(`fixture bundle failed: ${created.stderr}`);
  }

  const hooksPathDir = await tempDir("hf-apply-hooks-");
  const artifact: WriteArtifact = {
    branchName: BRANCH,
    baseCommit: base,
    headCommit: head,
    diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
    commitMessage: "job: produce the result",
  };
  return { repo, worker, base, head, bundlePath, hooksPathDir, artifact };
}

/** Resolves a ref in the source repo, or null when absent. */
async function sourceRef(
  repoPath: string,
  ref: string,
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", ref], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  return ok(result) ? result.stdout.trim() : null;
}

async function sourceStatus(repoPath: string): Promise<string> {
  const result = await runGit(["status", "--porcelain"], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  if (!ok(result)) {
    throw new Error(`git status failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function sourceHeadRef(repoPath: string): Promise<string> {
  const result = await runGit(["symbolic-ref", "HEAD"], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

async function expectApplyError(
  promise: Promise<unknown>,
  code: ApplyError["code"],
): Promise<void> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApplyError);
  expect((error as ApplyError).code).toBe(code);
}

test("applies a real worker artifact: creates ONLY refs/heads/<branch>, working tree and HEAD untouched", async () => {
  const fx = await makeArtifactFixture();
  const { repoPath } = fx.repo;

  // Dirty the source working tree BEFORE the apply: an uncommitted edit and
  // an untracked file must survive byte-identically.
  const dirtyContent = "line 0\nUNCOMMITTED LOCAL EDIT\n";
  await writeFile(path.join(repoPath, "file.txt"), dirtyContent);
  await writeFile(path.join(repoPath, "untracked.txt"), "not staged\n");
  const headRefBefore = await sourceHeadRef(repoPath);
  const headBefore = await sourceRef(repoPath, "HEAD");
  const statusBefore = await sourceStatus(repoPath);

  const result = await applyWriteArtifact({
    sourceRepoPath: repoPath,
    artifact: fx.artifact,
    bundlePath: fx.bundlePath,
    hooksPathDir: fx.hooksPathDir,
  });

  expect(result).toEqual({ branchName: BRANCH });
  // The ref landed at exactly the claimed head.
  expect(await sourceRef(repoPath, REF)).toBe(fx.head);
  // Refs ONLY: HEAD, current branch, index, and dirty files are untouched.
  expect(await sourceHeadRef(repoPath)).toBe(headRefBefore);
  expect(await sourceRef(repoPath, "HEAD")).toBe(headBefore);
  expect(await sourceStatus(repoPath)).toBe(statusBefore);
  expect(await readFile(path.join(repoPath, "file.txt"), "utf8")).toBe(
    dirtyContent,
  );
  expect(await readFile(path.join(repoPath, "untracked.txt"), "utf8")).toBe(
    "not staged\n",
  );
}, 30_000);

test("re-applying the same bundle is an idempotent no-op success", async () => {
  const fx = await makeArtifactFixture();
  await applyWriteArtifact({
    sourceRepoPath: fx.repo.repoPath,
    artifact: fx.artifact,
    bundlePath: fx.bundlePath,
    hooksPathDir: fx.hooksPathDir,
  });
  const again = await applyWriteArtifact({
    sourceRepoPath: fx.repo.repoPath,
    artifact: fx.artifact,
    bundlePath: fx.bundlePath,
    hooksPathDir: fx.hooksPathDir,
  });
  expect(again).toEqual({ branchName: BRANCH });
  expect(await sourceRef(fx.repo.repoPath, REF)).toBe(fx.head);
}, 30_000);

test("a malicious branchName ('main') is rejected by the schema re-parse BEFORE any git runs", async () => {
  const fx = await makeArtifactFixture();
  const headBefore = await sourceRef(fx.repo.repoPath, "HEAD");
  const statusBefore = await sourceStatus(fx.repo.repoPath);

  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      artifact: { ...fx.artifact, branchName: "main" },
      // A nonexistent bundle path: if any git had run against it, the failure
      // class would differ (BAD_BUNDLE/GIT_FAILURE), so REF_MISMATCH here also
      // proves the reject happened before git.
      bundlePath: path.join(fx.hooksPathDir, "never-created.bundle"),
      hooksPathDir: fx.hooksPathDir,
    }),
    "REF_MISMATCH",
  );

  // No side effects: no ref created or moved, tree/index untouched.
  expect(await sourceRef(fx.repo.repoPath, "refs/heads/main")).toBeNull();
  expect(await sourceRef(fx.repo.repoPath, REF)).toBeNull();
  expect(await sourceRef(fx.repo.repoPath, "HEAD")).toBe(headBefore);
  expect(await sourceStatus(fx.repo.repoPath)).toBe(statusBefore);
}, 30_000);

test("a bundle tip that differs from the claimed headCommit is refused pre-fetch (REF_MISMATCH)", async () => {
  const fx = await makeArtifactFixture();
  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      // Claim the BASE as the head: valid hash, wrong tip.
      artifact: { ...fx.artifact, headCommit: fx.base },
      bundlePath: fx.bundlePath,
      hooksPathDir: fx.hooksPathDir,
    }),
    "REF_MISMATCH",
  );
  // Nothing was fetched.
  expect(await sourceRef(fx.repo.repoPath, REF)).toBeNull();
}, 30_000);

test("a bundle advertising extra refs is refused pre-fetch (REF_MISMATCH)", async () => {
  const fx = await makeArtifactFixture();
  // Hand-build a two-ref bundle from the worker cache: the legit ref plus a
  // smuggled second one at the same tip.
  const smuggled = "refs/heads/homefleet/bbbbbbbbbbbb";
  expect(ok(await updateRef(fx.worker, smuggled, fx.head))).toBe(true);
  const twoRefPath = path.join(await tempDir("hf-apply-two-"), "two.bundle");
  const created = await runGit(
    ["bundle", "create", twoRefPath, REF, smuggled, "--not", fx.base],
    { cwd: fx.worker.repoDir, timeoutMs: 30_000 },
  );
  expect(ok(created)).toBe(true);

  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      artifact: fx.artifact,
      bundlePath: twoRefPath,
      hooksPathDir: fx.hooksPathDir,
    }),
    "REF_MISMATCH",
  );
  expect(await sourceRef(fx.repo.repoPath, REF)).toBeNull();
  expect(await sourceRef(fx.repo.repoPath, smuggled)).toBeNull();
}, 30_000);

test("a bundle whose single ref is refs/heads/main under a homefleet/ claim is refused pre-fetch", async () => {
  const fx = await makeArtifactFixture();
  // The artifact CLAIMS homefleet/aaaaaaaaaaaa (schema-clean), but the bundle
  // actually delivers refs/heads/main — the name check must refuse it before
  // any fetch could touch a user branch.
  const mainBundle = path.join(await tempDir("hf-apply-main-"), "main.bundle");
  expect(ok(await updateRef(fx.worker, "refs/heads/main", fx.head))).toBe(true);
  const created = await createWorkerBundle(fx.worker, {
    bundlePath: mainBundle,
    ref: "refs/heads/main",
    base: fx.base,
  });
  expect(ok(created)).toBe(true);
  const headBefore = await sourceRef(fx.repo.repoPath, "HEAD");

  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      artifact: fx.artifact,
      bundlePath: mainBundle,
      hooksPathDir: fx.hooksPathDir,
    }),
    "REF_MISMATCH",
  );
  expect(await sourceRef(fx.repo.repoPath, "refs/heads/main")).toBeNull();
  expect(await sourceRef(fx.repo.repoPath, REF)).toBeNull();
  expect(await sourceRef(fx.repo.repoPath, "HEAD")).toBe(headBefore);
}, 30_000);

test("a diverged existing branch is refused (NON_FAST_FORWARD) and left untouched", async () => {
  const fx = await makeArtifactFixture();
  // Advance the source repo past base on a DIFFERENT line of history, then
  // plant the target branch there: c2 is neither an ancestor nor a
  // descendant of the artifact head, so the non-forced refspec must refuse.
  const c2 = await fx.repo.commit("c2");
  const planted = await runGit(["update-ref", REF, c2], {
    cwd: fx.repo.repoPath,
    timeoutMs: 30_000,
  });
  expect(ok(planted)).toBe(true);

  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      artifact: fx.artifact,
      bundlePath: fx.bundlePath,
      hooksPathDir: fx.hooksPathDir,
    }),
    "NON_FAST_FORWARD",
  );
  expect(await sourceRef(fx.repo.repoPath, REF)).toBe(c2);
}, 30_000);

test("a garbage (non-bundle) file maps to BAD_BUNDLE", async () => {
  const fx = await makeArtifactFixture();
  const garbage = path.join(await tempDir("hf-apply-garbage-"), "g.bundle");
  await writeFile(garbage, "this is definitely not a git bundle\n");
  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      artifact: fx.artifact,
      bundlePath: garbage,
      hooksPathDir: fx.hooksPathDir,
    }),
    "BAD_BUNDLE",
  );
  expect(await sourceRef(fx.repo.repoPath, REF)).toBeNull();
}, 30_000);

test("a bundle whose prerequisite is missing from the source repo maps to BAD_BUNDLE", async () => {
  const fx = await makeArtifactFixture();
  // An UNRELATED repo: the bundle's header parses (list-heads passes the name
  // check) but its prerequisite base commit does not exist there, so
  // `bundle verify` must refuse it.
  const stranger = await makeRepo();
  await stranger.commit("unrelated");
  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: stranger.repoPath,
      artifact: fx.artifact,
      bundlePath: fx.bundlePath,
      hooksPathDir: fx.hooksPathDir,
    }),
    "BAD_BUNDLE",
  );
  expect(await sourceRef(stranger.repoPath, REF)).toBeNull();
}, 30_000);

test("an aborted signal maps to GIT_FAILURE, not a spurious BAD_BUNDLE, and imports nothing", async () => {
  const fx = await makeArtifactFixture();
  const controller = new AbortController();
  controller.abort();
  await expectApplyError(
    applyWriteArtifact({
      sourceRepoPath: fx.repo.repoPath,
      artifact: fx.artifact,
      bundlePath: fx.bundlePath,
      hooksPathDir: fx.hooksPathDir,
      signal: controller.signal,
    }),
    "GIT_FAILURE",
  );
  expect(await sourceRef(fx.repo.repoPath, REF)).toBeNull();
}, 30_000);

test("delegatorConfig carries the same four security pins as the worker lockdown", () => {
  expect(delegatorConfig("/some/empty/dir")).toEqual([
    "core.hooksPath=/some/empty/dir",
    "protocol.ext.allow=never",
    "fetch.recurseSubmodules=false",
    "core.longpaths=true",
  ]);
});
