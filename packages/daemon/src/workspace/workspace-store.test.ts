/**
 * Unit tests for the worker-side workspace store (M7). Real git, real repos,
 * real bundles created via the git core; no faking. Covers the allowlist
 * (fail-closed), repoId path-traversal neutralization, full+incremental sync,
 * malformed / undelivered-commit rejection, per-repo serialization, the
 * checkout retention cap, and ephemeral write-job worktrees (v0.2: dedicated
 * per-job dirs outside the checkout cache, purged on init).
 */
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { WriteArtifactSchema } from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import {
  addWorktree,
  commitPresent,
  countObjects,
  createBundle,
  listBundleHeads,
  ok,
  removeWorktree,
  resolveHeadCommit,
  runGit,
  verifyBundle,
  type WorkerGit,
} from "./git.js";
import {
  repoKey,
  WorkspaceError,
  WorkspaceStore,
  type WorkspaceStoreOptions,
} from "./workspace-store.js";

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

interface Src {
  repoPath: string;
  commit(message: string): Promise<string>;
}

async function makeSrc(): Promise<Src> {
  const repoPath = await tempDir("homefleet-src-");
  const run = async (args: string[]): Promise<void> => {
    const r = await runGit(args, { cwd: repoPath, timeoutMs: 30_000 });
    if (!ok(r)) {
      throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
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
      await writeFile(path.join(repoPath, "file.txt"), `content ${n}\n`, {
        flag: n === 0 ? "w" : "a",
      });
      n += 1;
      await run(["add", "-A"]);
      await run(["commit", "--quiet", "-m", message]);
      return resolveHeadCommit(repoPath, 30_000);
    },
  };
}

async function makeStore(
  overrides: Partial<WorkspaceStoreOptions> = {},
): Promise<WorkspaceStore> {
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const store = new WorkspaceStore({
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 32,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
    ...overrides,
  });
  await store.init();
  return store;
}

/** Full bundle of the repo's current HEAD to a fresh temp path. */
async function fullBundle(src: Src, headCommit: string): Promise<string> {
  const dir = await tempDir("homefleet-bundle-");
  const bundlePath = path.join(dir, "full.bundle");
  await createBundle({ repoPath: src.repoPath, bundlePath, headCommit });
  return bundlePath;
}

/** A WorkerGit pointing at the store's on-disk bare cache repo for `repoId`. */
function workerFor(cacheDir: string, repoId: string): WorkerGit {
  return {
    repoDir: path.join(cacheDir, repoKey(repoId), "repo.git"),
    hooksPath: path.join(cacheDir, ".no-hooks"),
    timeoutMs: 30_000,
  };
}

/** A fresh repo with UNIQUE content (unrelated history, no object dedup). */
async function makeUniqueRepo(
  tag: string,
): Promise<{ repoPath: string; head: string }> {
  const repoPath = await tempDir("homefleet-uniq-");
  const run = async (args: string[]): Promise<void> => {
    const r = await runGit(args, { cwd: repoPath, timeoutMs: 30_000 });
    if (!ok(r)) {
      throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }
  };
  await run(["init", "--quiet"]);
  await run(["config", "user.email", "t@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  await writeFile(
    path.join(repoPath, "data.txt"),
    `unique-history-${tag}-${Math.random()}\n`,
  );
  await run(["add", "-A"]);
  await run(["commit", "--quiet", "-m", `commit ${tag}`]);
  return { repoPath, head: await resolveHeadCommit(repoPath, 30_000) };
}

async function fullBundleOf(repoPath: string, head: string): Promise<string> {
  const dir = await tempDir("homefleet-bundle-");
  const bundlePath = path.join(dir, "full.bundle");
  await createBundle({ repoPath, bundlePath, headCommit: head });
  return bundlePath;
}

test("empty allowlist accepts nothing (fail closed)", async () => {
  const store = await makeStore({ allowedRepoIds: [] });
  expect(store.isAllowed("repo-a")).toBe(false);
  await expect(store.haveTip("repo-a")).rejects.toMatchObject({
    code: "REPO_NOT_ALLOWED",
  });
});

test("non-allowlisted repo is rejected and nothing is written to the cache", async () => {
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;

  await expect(store.haveTip("evil")).rejects.toBeInstanceOf(WorkspaceError);
  await expect(
    store.applyBundle(
      "evil",
      path.join(cacheDir, "nope.bundle"),
      "a".repeat(40),
    ),
  ).rejects.toMatchObject({ code: "REPO_NOT_ALLOWED" });

  // Only the init-created `.no-hooks` dir exists; no per-repo dir was created.
  const entries = await readdir(cacheDir);
  expect(entries).toEqual([".no-hooks"]);
});

test("haveTip is null before first sync, the head after", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  expect(await store.haveTip("repo-a")).toBeNull();

  await store.applyBundle("repo-a", await fullBundle(src, head), head);
  expect(await store.haveTip("repo-a")).toBe(head);
}, 30_000);

test("full then incremental sync; the resolver materializes the right content", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });

  // Full sync to c1, resolve, read the committed file.
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const { dir: dir1 } = await store.resolve({
    repoId: "repo-a",
    headCommit: c1,
  });
  expect(await readFile(path.join(dir1, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );

  // Add a commit; incremental sync; resolve at the new head sees new content.
  const c2 = await src.commit("c2");
  const incrDir = await tempDir("homefleet-bundle-");
  const incrPath = path.join(incrDir, "incr.bundle");
  await createBundle({
    repoPath: src.repoPath,
    bundlePath: incrPath,
    headCommit: c2,
    have: c1,
  });
  await store.applyBundle("repo-a", incrPath, c2);
  expect(await store.haveTip("repo-a")).toBe(c2);

  const { dir: dir2 } = await store.resolve({
    repoId: "repo-a",
    headCommit: c2,
  });
  expect(await readFile(path.join(dir2, "file.txt"), "utf8")).toBe(
    "content 0\ncontent 1\n",
  );
}, 30_000);

test("resolve before any sync fails NOT_SYNCED", async () => {
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await expect(
    store.resolve({ repoId: "repo-a", headCommit: "a".repeat(40) }),
  ).rejects.toMatchObject({ code: "NOT_SYNCED" });
});

test("a malformed bundle is rejected and the tip is untouched", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  const garbageDir = await tempDir("homefleet-garbage-");
  const garbage = path.join(garbageDir, "garbage.bundle");
  await writeFile(garbage, "not a bundle at all\n");
  await expect(
    store.applyBundle("repo-a", garbage, "b".repeat(40)),
  ).rejects.toMatchObject({ code: "BUNDLE_INVALID" });

  // The previously synced tip is intact.
  expect(await store.haveTip("repo-a")).toBe(c1);
}, 30_000);

test("a bundle that does not deliver the claimed headCommit is rejected (never checked out)", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });

  // A valid full bundle of c1, but we lie and claim it delivers a different sha.
  const bundlePath = await fullBundle(src, c1);
  const lie = "0".repeat(40);
  await expect(
    store.applyBundle("repo-a", bundlePath, lie),
  ).rejects.toMatchObject({ code: "COMMIT_NOT_DELIVERED" });

  // Nothing was synced: no tip, and resolving the lied commit is NOT_SYNCED.
  expect(await store.haveTip("repo-a")).toBeNull();
  await expect(
    store.resolve({ repoId: "repo-a", headCommit: lie }),
  ).rejects.toMatchObject({ code: "NOT_SYNCED" });
}, 30_000);

test("repoId path-traversal attempts are neutralized by hashing", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const traversals = ["../../x", "..\\..\\x", "/etc/passwd", "C:\\Windows\\x"];
  const store = await makeStore({ allowedRepoIds: traversals });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  const parentOfCache = path.dirname(cacheDir);

  for (const repoId of traversals) {
    await store.applyBundle(repoId, await fullBundle(src, head), head);
    const { dir } = await store.resolve({ repoId, headCommit: head });
    // The materialized dir is inside the cache root, under the hashed name.
    const resolved = path.resolve(dir);
    expect(resolved.startsWith(path.resolve(cacheDir) + path.sep)).toBe(true);
    expect(resolved).toContain(repoKey(repoId));
  }

  // Every top-level cache entry is either `.no-hooks` or a 16-hex repoKey dir
  // — no traversal produced a path segment outside the cache root.
  const entries = await readdir(cacheDir);
  for (const entry of entries) {
    expect(entry === ".no-hooks" || /^[0-9a-f]{16}$/.test(entry)).toBe(true);
  }
  // And no stray "x" leaked next to the cache root.
  await expect(stat(path.join(parentOfCache, "x"))).rejects.toThrow();
}, 60_000);

test("per-repo operations serialize: concurrent syncs + a resolve do not corrupt the repo", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const bundle = await fullBundle(src, c1);

  // Fire two applyBundle and a resolve for the SAME repo concurrently. The
  // per-repo lock serializes them; none may corrupt the repo. (resolve may
  // land before the sync -> NOT_SYNCED, which is a clean typed error.)
  const results = await Promise.allSettled([
    store.applyBundle("repo-a", bundle, c1),
    store.applyBundle("repo-a", bundle, c1),
    store.resolve({ repoId: "repo-a", headCommit: c1 }),
  ]);
  // Both syncs must succeed (idempotent re-apply of the same head).
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("fulfilled");

  // Final state is consistent and the checkout is valid.
  expect(await store.haveTip("repo-a")).toBe(c1);
  const { dir } = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  expect(await readFile(path.join(dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );
}, 30_000);

test("checkout retention cap evicts the least-recently-used checkout", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const c3 = await src.commit("c3");
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    maxCachedCheckouts: 2,
  });
  // A full bundle of c3 contains c1, c2, c3.
  await store.applyBundle("repo-a", await fullBundle(src, c3), c3);

  // Release each handle right after resolving so it is unpinned and thus a
  // valid eviction victim (a pinned checkout is never evicted).
  const { dir: d1, release: r1 } = await store.resolve({
    repoId: "repo-a",
    headCommit: c1,
  });
  r1();
  const { dir: d2, release: r2 } = await store.resolve({
    repoId: "repo-a",
    headCommit: c2,
  });
  r2();
  const { dir: d3, release: r3 } = await store.resolve({
    repoId: "repo-a",
    headCommit: c3,
  });
  r3();

  // Cap is 2: the oldest (c1) checkout was evicted; c2 and c3 remain on disk.
  await expect(stat(path.join(d1, ".git"))).rejects.toThrow();
  expect((await stat(path.join(d2, ".git"))).isFile()).toBe(true);
  expect((await stat(path.join(d3, ".git"))).isFile()).toBe(true);
}, 45_000);

test("a pinned checkout is not evicted while its handle is held, and is after release", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    maxCachedCheckouts: 1,
  });
  // A full bundle of c2 contains c1 and c2.
  await store.applyBundle("repo-a", await fullBundle(src, c2), c2);

  // Hold BOTH handles. With cap 1 the second resolve's eviction pass runs while
  // both checkouts are pinned, so it cannot evict either — both survive on disk
  // despite the cap being exceeded.
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  const h2 = await store.resolve({ repoId: "repo-a", headCommit: c2 });
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  expect((await stat(path.join(h2.dir, ".git"))).isFile()).toBe(true);

  // Release c1's handle, then trigger another eviction pass (via a resolve):
  // c1 is now unpinned and becomes the victim; c2 stays pinned and survives.
  h1.release();
  await store.resolve({ repoId: "repo-a", headCommit: c2 });
  await expect(stat(path.join(h1.dir, ".git"))).rejects.toThrow();
  expect((await stat(path.join(h2.dir, ".git"))).isFile()).toBe(true);

  h2.release();
}, 45_000);

test("the store's release handle is idempotent: a double-release neither throws nor sticks the pin", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    maxCachedCheckouts: 1,
  });
  // A full bundle of c2 contains c1 and c2.
  await store.applyBundle("repo-a", await fullBundle(src, c2), c2);

  // Resolve c1 with the store's OWN release closure, then call it TWICE. The
  // `released` guard must make the second call a no-op and the `unpin` floor
  // must keep the refcount at 0 (never negative) — so c1 ends up genuinely
  // unpinned, not stuck pinned by a double-decrement gone wrong.
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();
  h1.release();

  // Cap is 1: resolving a DIFFERENT commit runs an eviction pass. c1 must now
  // be evicted — proving the double-release left it unpinned. Had it thrown or
  // driven the refcount negative/stuck-pinned, c1 would have survived.
  const h2 = await store.resolve({ repoId: "repo-a", headCommit: c2 });
  await expect(stat(path.join(h1.dir, ".git"))).rejects.toThrow();
  expect((await stat(path.join(h2.dir, ".git"))).isFile()).toBe(true);

  h2.release();
}, 45_000);

test("checkout cap survives across store instances (init re-registers on-disk checkouts)", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const c3 = await src.commit("c3");
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const opts: WorkspaceStoreOptions = {
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 3,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  };
  const store1 = new WorkspaceStore(opts);
  await store1.init();
  await store1.applyBundle("repo-a", await fullBundle(src, c3), c3);
  (await store1.resolve({ repoId: "repo-a", headCommit: c1 })).release();
  (await store1.resolve({ repoId: "repo-a", headCommit: c2 })).release();
  (await store1.resolve({ repoId: "repo-a", headCommit: c3 })).release();

  // A new store over the same cacheDir with a tighter cap must evict on init.
  const store2 = new WorkspaceStore({ ...opts, maxCachedCheckouts: 1 });
  await store2.init();
  const remaining = await readdir(path.join(cacheDir, repoKey("repo-a"), "co"));
  expect(remaining).toHaveLength(1);
}, 45_000);

test("init does not register an unpopulated checkout dir against the retention cap", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const opts: WorkspaceStoreOptions = {
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 1,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  };
  const store1 = new WorkspaceStore(opts);
  await store1.init();
  await store1.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const h1 = await store1.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();

  // An unpopulated checkout dir (no `.git` gitlink) — e.g. left by a checkout
  // creation that died partway. Forced to the newest mtime so that, were it
  // registered, the REAL checkout would be the next init's LRU victim.
  const strayDir = path.join(cacheDir, repoKey("repo-a"), "co", "0".repeat(16));
  await mkdir(strayDir, { recursive: true });
  await utimes(strayDir, new Date(), new Date(Date.now() + 60_000));

  const store2 = new WorkspaceStore(opts);
  await store2.init();

  // Cap 1: only the populated checkout counts, so it was NOT evicted; the
  // stray dir is left in place (a later resolve repairs/reuses it from disk).
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  expect((await stat(strayDir)).isDirectory()).toBe(true);
}, 45_000);

test("resolver injects into the WorkspaceResolver contract", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, head), head);
  const resolver = store.createResolver();
  const { dir } = await resolver(
    { repoId: "repo-a", headCommit: head },
    "owner-x",
  );
  expect(await readFile(path.join(dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );
}, 30_000);

test("a bundle advertising a head != the claimed headCommit imports no objects", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;

  // A valid full bundle of c1, but we claim it delivers a different commit. The
  // list-heads pre-filter rejects it from the header alone — before any fetch.
  await expect(
    store.applyBundle("repo-a", await fullBundle(src, c1), "0".repeat(40)),
  ).rejects.toMatchObject({ code: "COMMIT_NOT_DELIVERED" });

  const counts = await countObjects(workerFor(cacheDir, "repo-a"));
  expect(counts.count).toBe(0);
  expect(counts.inPack).toBe(0);
}, 30_000);

test("periodic gc reclaims superseded objects so the bare cache stays bounded", async () => {
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    gcAfterFetches: 2,
  });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  const worker = workerFor(cacheDir, "repo-a");

  const a = await makeUniqueRepo("A");
  await store.applyBundle(
    "repo-a",
    await fullBundleOf(a.repoPath, a.head),
    a.head,
  );
  expect(await commitPresent(worker, a.head)).toBe(true);

  // A rejected upload in the mix must not corrupt the cache or advance the tip.
  await expect(
    store.applyBundle(
      "repo-a",
      await fullBundleOf(a.repoPath, a.head),
      "0".repeat(40),
    ),
  ).rejects.toMatchObject({ code: "COMMIT_NOT_DELIVERED" });
  expect(await store.haveTip("repo-a")).toBe(a.head);

  // A second successful sync of an UNRELATED history moves the tip and hits the
  // gc threshold; history A is now unreachable and gc reclaims it.
  const b = await makeUniqueRepo("B");
  await store.applyBundle(
    "repo-a",
    await fullBundleOf(b.repoPath, b.head),
    b.head,
  );
  expect(await commitPresent(worker, b.head)).toBe(true);
  expect(await commitPresent(worker, a.head)).toBe(false);
}, 45_000);

test("stop() fails closed: haveTip / applyBundle / resolve reject as stopped", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  // Sync once so the repo exists on disk; stop() must still fail closed after.
  await store.applyBundle("repo-a", await fullBundle(src, head), head);

  await store.stop();

  const expected = { code: "GIT_FAILED", message: /stopped/i };
  await expect(store.haveTip("repo-a")).rejects.toMatchObject(expected);
  await expect(
    store.applyBundle("repo-a", await fullBundle(src, head), head),
  ).rejects.toMatchObject(expected);
  await expect(
    store.resolve({ repoId: "repo-a", headCommit: head }),
  ).rejects.toMatchObject(expected);
  // The rejection is the typed workspace error, not a raw throw.
  await expect(store.haveTip("repo-a")).rejects.toBeInstanceOf(WorkspaceError);
}, 30_000);

test("stop() is idempotent: calling it twice neither throws nor hangs", async () => {
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.stop();
  await expect(store.stop()).resolves.toBeUndefined();
}, 30_000);

test("stop() aborts the controller and that signal is threaded into worker git", async () => {
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  // The WorkerGit the store builds carries the store's abort signal, so every
  // worker-side helper (which passes `worker.signal`) is cancellable by stop().
  const internals = store as unknown as {
    abort: AbortController;
    worker(hash: string): WorkerGit;
  };
  const rKey = repoKey("repo-a");
  expect(internals.abort.signal.aborted).toBe(false);
  expect(internals.worker(rKey).signal).toBe(internals.abort.signal);

  await store.stop();
  expect(internals.abort.signal.aborted).toBe(true);
  // Still the same signal, now aborted — an in-flight op observing it is killed.
  expect(internals.worker(rKey).signal?.aborted).toBe(true);
}, 30_000);

test("stop() cancels an in-flight worker git op so it settles well before the git timeout", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  // A large git timeout: were the signal NOT wired, a wedged in-flight op would
  // block up to this long. With cancellation the op settles in a fraction of it.
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    gitTimeoutMs: 60_000,
  });
  // Sync once so the bare repo already exists: the in-flight op we cancel below
  // is then a worker-git call (verify/fetch), which surfaces as a WorkspaceError
  // rather than the init path.
  await store.applyBundle("repo-a", await fullBundle(src, head), head);

  // Kick off another sync (which runs several worker-side git ops), then abort
  // it via stop() in the same tick — the stopped-guard was already passed, so
  // the op runs and is cancelled mid-flight. It must settle promptly rather than
  // wait out the 60s gitTimeoutMs.
  const started = Date.now();
  const applying = store.applyBundle(
    "repo-a",
    await fullBundle(src, head),
    head,
  );
  await store.stop();
  await expect(applying).rejects.toBeInstanceOf(WorkspaceError);
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);

test("stop() during an eviction pass halts it: no further worktree removals are issued", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const c3 = await src.commit("c3");
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    maxCachedCheckouts: 1,
  });
  // A full bundle of c3 contains c1, c2, c3.
  await store.applyBundle("repo-a", await fullBundle(src, c3), c3);

  // Hold all three handles while resolving (pinned checkouts block each
  // resolve's eviction pass), then release: three unpinned checkouts on disk,
  // two over the cap — a subsequent eviction pass has two removals to issue.
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  const h2 = await store.resolve({ repoId: "repo-a", headCommit: c2 });
  const h3 = await store.resolve({ repoId: "repo-a", headCommit: c3 });
  h1.release();
  h2.release();
  h3.release();

  const internals = store as unknown as {
    withRepoLock<T>(rKey: string, fn: () => Promise<T>): Promise<T>;
    evictToCapacity(): Promise<void>;
  };
  const rKey = repoKey("repo-a");

  // Park the repo lock so the pass's FIRST removal (LRU victim c1) queues
  // behind the gate, then start the pass: it suspends awaiting that removal.
  // stop() lands mid-pass; opening the gate lets the pass resume.
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const blocker = internals.withRepoLock(rKey, () => gate);
  const evicting = internals.evictToCapacity();
  const stopping = store.stop();
  openGate();
  await Promise.all([blocker, stopping, evicting]);

  // No post-stop disk mutation at all: the parked first removal (c1) reached
  // its locked callback only after stop(), so it must back off — and the pass
  // must not issue ANOTHER removal either. All three checkouts survive on
  // disk; c1 is merely unregistered from the LRU map, the same state as any
  // on-disk checkout after a restart (a next init() re-registers it).
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  expect((await stat(path.join(h2.dir, ".git"))).isFile()).toBe(true);
  expect((await stat(path.join(h3.dir, ".git"))).isFile()).toBe(true);
}, 45_000);

test("aborting a first-ever sync surfaces a WorkspaceError, not a raw GitError", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-b"] });

  // Abort BEFORE any sync, so the repo has never been created: applyBundle's
  // first git op is ensureRepo -> initBareRepo, which throws a raw GitError once
  // its signal is already aborted. Abort the controller directly (leaving the
  // `stopped` flag false) so the applyBundle stopped-guard is passed and the
  // ensureRepo normalization path is exercised deterministically.
  const internals = store as unknown as { abort: AbortController };
  internals.abort.abort();

  const rejection = await store
    .applyBundle("repo-b", await fullBundle(src, head), head)
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(WorkspaceError);
  expect(rejection).toMatchObject({ code: "GIT_FAILED" });
}, 30_000);

test("an in-use checkout survives a gc triggered by a later sync", async () => {
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    gcAfterFetches: 1,
  });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  const worker = workerFor(cacheDir, "repo-a");

  const a = await makeUniqueRepo("A");
  await store.applyBundle(
    "repo-a",
    await fullBundleOf(a.repoPath, a.head),
    a.head,
  );
  const { dir } = await store.resolve({ repoId: "repo-a", headCommit: a.head });
  const content = await readFile(path.join(dir, "data.txt"), "utf8");

  // Move the tip to an unrelated history B (gc runs every fetch): A is now only
  // anchored by the live worktree, which gc must NOT prune.
  const b = await makeUniqueRepo("B");
  await store.applyBundle(
    "repo-a",
    await fullBundleOf(b.repoPath, b.head),
    b.head,
  );

  expect(await readFile(path.join(dir, "data.txt"), "utf8")).toBe(content);
  expect(await commitPresent(worker, a.head)).toBe(true);
}, 45_000);

test("checkout paths are short: <cacheDir>/<16-hex>/co/<16-hex>, 37 chars past the cache root", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, head), head);

  const { dir, release } = await store.resolve({
    repoId: "repo-a",
    headCommit: head,
  });
  // Windows MAX_PATH defense-in-depth: the cache's own overhead past the cache
  // root is exactly `\<16-hex repoKey>\co\<16-hex commitKey>` = 37 chars.
  const suffix = path.resolve(dir).slice(path.resolve(cacheDir).length);
  expect(suffix).toMatch(/^[\\/][0-9a-f]{16}[\\/]co[\\/][0-9a-f]{16}$/);
  expect(suffix).toHaveLength(37);
  release();
}, 30_000);

test("verify-on-reuse: a checkout dir holding the wrong commit is re-materialized", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  // A full bundle of c2 contains c1 and c2.
  await store.applyBundle("repo-a", await fullBundle(src, c2), c2);

  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();

  // Tamper: swap the worktree under c1's dir NAME to actually hold c2 — the
  // on-disk analogue of a truncated-commit-key collision.
  const worker = workerFor(cacheDir, "repo-a");
  await removeWorktree(worker, h1.dir);
  expect(ok(await addWorktree(worker, h1.dir, c2))).toBe(true);

  // Resolving c1 again must detect the mismatch (dir names no longer encode
  // the full commit) and re-materialize c1, not hand out c2's content.
  const h2 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  expect(h2.dir).toBe(h1.dir);
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: h2.dir,
    timeoutMs: 30_000,
  });
  expect(head.stdout.trim()).toBe(c1);
  expect(await readFile(path.join(h2.dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );
  h2.release();
}, 45_000);

test("a pinned checkout dir holding the wrong commit is never removed: resolve fails instead", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c2), c2);

  // Hold the handle: the checkout stays PINNED (a running job is reading it).
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  const worker = workerFor(cacheDir, "repo-a");
  await removeWorktree(worker, h1.dir);
  expect(ok(await addWorktree(worker, h1.dir, c2))).toBe(true);

  // A mismatching pinned dir must fail the resolve rather than yank the dir
  // out from under the job holding it.
  await expect(
    store.resolve({ repoId: "repo-a", headCommit: c1 }),
  ).rejects.toMatchObject({ code: "GIT_FAILED" });
  // The dir was NOT removed: its worktree gitlink is still on disk.
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  h1.release();
}, 45_000);

test("eviction backs off a victim that a queued-ahead resolve re-pinned", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    maxCachedCheckouts: 1,
  });
  // A full bundle of c2 contains c1 and c2.
  await store.applyBundle("repo-a", await fullBundle(src, c2), c2);

  // One unpinned checkout, exactly at the cap.
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();

  // Same tick: resolve(c2) queues on the repo lock first, then resolve(c1).
  // c2's eviction pass picks the unpinned c1 entry as victim and queues its
  // removal on the SAME lock — BEHIND the already-queued resolve(c1), which
  // finds the dir still on disk, verifies it, and PINS it. The removal must
  // then back off rather than delete a dir a job now holds.
  const p2 = store.resolve({ repoId: "repo-a", headCommit: c2 });
  const p1 = store.resolve({ repoId: "repo-a", headCommit: c1 });
  const [h2, h1again] = await Promise.all([p2, p1]);

  expect(h1again.dir).toBe(h1.dir);
  expect((await stat(path.join(h1again.dir, ".git"))).isFile()).toBe(true);
  expect(await readFile(path.join(h1again.dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );
  h2.release();
  h1again.release();
}, 45_000);

test("an unpinned checkout whose HEAD cannot be read is re-materialized (self-heal)", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();
  // Corrupt the worktree gitlink so the checkout's HEAD can no longer be
  // read. Delete-and-recreate (not overwrite): git marks the gitlink hidden
  // on Windows, and truncating writes to hidden files fail with EPERM.
  await chmod(path.join(h1.dir, ".git"), 0o666);
  await rm(path.join(h1.dir, ".git"), { force: true });
  await writeFile(path.join(h1.dir, ".git"), "not a gitlink\n");

  const h2 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  expect(h2.dir).toBe(h1.dir);
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: h2.dir,
    timeoutMs: 30_000,
  });
  expect(head.stdout.trim()).toBe(c1);
  expect(await readFile(path.join(h2.dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );
  h2.release();
}, 45_000);

test("a pinned checkout whose HEAD cannot be read fails with a read error, not a collision claim", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  // Hold the handle: the checkout stays PINNED.
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  // Corrupt the worktree gitlink so the checkout's HEAD can no longer be
  // read. Delete-and-recreate (not overwrite): git marks the gitlink hidden
  // on Windows, and truncating writes to hidden files fail with EPERM.
  await chmod(path.join(h1.dir, ".git"), 0o666);
  await rm(path.join(h1.dir, ".git"), { force: true });
  await writeFile(path.join(h1.dir, ".git"), "not a gitlink\n");

  // A HEAD-read FAILURE is not evidence of a different commit: the error must
  // say the HEAD could not be read, not allege a commit-key collision.
  // (Assert on the captured error directly — toMatchObject does not reliably
  // compare an Error's non-enumerable `message`.)
  const rejection = await store
    .resolve({ repoId: "repo-a", headCommit: c1 })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(WorkspaceError);
  expect((rejection as WorkspaceError).code).toBe("GIT_FAILED");
  expect((rejection as WorkspaceError).message).toMatch(
    /could not read checkout HEAD/,
  );
  // The pinned dir was not removed.
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  h1.release();
}, 45_000);

// --- ephemeral write-job worktrees (v0.2) ----------------------------------

/** Valid job UUIDs (v4 shape); the store keys write worktrees by the LAST 12 hex. */
const JOB_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const JOB_B = "22222222-2222-4222-9222-bbbbbbbbbbbb";

/**
 * A write handle's `release()` actually returns a promise that settles when
 * its teardown has run (or been skipped post-stop); the declared type stays
 * `() => void` to match the read-mode handle, so tests cast to await it
 * deterministically.
 */
function releaseSettled(handle: { release: () => void }): Promise<void> {
  return handle.release() as unknown as Promise<void>;
}

test("write resolve materializes a dedicated detached worktree at <repoRoot>/jobs/<jobId12>", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  // Dedicated layout: jobs/<last-12-of-jobId>, a SIBLING of co/ (so the
  // checkout-cache scan structurally never sees it).
  expect(path.resolve(handle.dir)).toBe(
    path.join(
      path.resolve(cacheDir),
      repoKey("repo-a"),
      "jobs",
      "aaaaaaaaaaaa",
    ),
  );
  // Detached at exactly ref.headCommit, with the commit's content.
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: handle.dir,
    timeoutMs: 30_000,
  });
  expect(head.stdout.trim()).toBe(c1);
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: handle.dir,
    timeoutMs: 30_000,
  });
  expect(branch.stdout.trim()).toBe("HEAD"); // detached: no branch checked out
  expect(await readFile(path.join(handle.dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );

  // The registry answers jobId -> {dir, repoKey, baseCommit}: the bridge the
  // daemon's finalize closure (Task 6) needs, since it can only see the jobId.
  expect(store.writeJobWorkspace(JOB_A)).toEqual({
    dir: handle.dir,
    repoKey: repoKey("repo-a"),
    baseCommit: c1,
  });

  await releaseSettled(handle);
  expect(store.writeJobWorkspace(JOB_A)).toBeUndefined();
}, 45_000);

test("write resolve before any sync fails NOT_SYNCED and leaves no registry entry", async () => {
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await expect(
    store.resolve(
      { repoId: "repo-a", headCommit: "a".repeat(40) },
      { write: { jobId: JOB_A } },
    ),
  ).rejects.toMatchObject({ code: "NOT_SYNCED" });
  expect(store.writeJobWorkspace(JOB_A)).toBeUndefined();
});

test("write worktrees are invisible to the checkout cache: uncounted, unevictable, non-evicting", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const c2 = await src.commit("c2");
  const store = await makeStore({
    allowedRepoIds: ["repo-a"],
    maxCachedCheckouts: 1,
  });
  // A full bundle of c2 contains c1 and c2.
  await store.applyBundle("repo-a", await fullBundle(src, c2), c2);

  // One unpinned cached checkout, exactly at cap 1.
  const h1 = await store.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();

  // A write resolve neither counts against the cap nor evicts: were the write
  // worktree entered into the checkout map, cap 1 would evict c1 here.
  const hw = await store.resolve(
    { repoId: "repo-a", headCommit: c2 },
    { write: { jobId: JOB_A } },
  );
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  expect((await stat(path.join(hw.dir, ".git"))).isFile()).toBe(true);
  const checkouts = (
    store as unknown as { checkouts: Map<string, { dir: string }> }
  ).checkouts;
  expect([...checkouts.values()].some((e) => e.dir === hw.dir)).toBe(false);
  expect(checkouts.size).toBe(1);

  // Conversely a live write worktree is never an eviction victim: a read
  // resolve of c2 pushes the cache over cap and the eviction pass must pick
  // c1 (the LRU CACHED checkout), never the write worktree.
  const h2 = await store.resolve({ repoId: "repo-a", headCommit: c2 });
  await expect(stat(path.join(h1.dir, ".git"))).rejects.toThrow();
  expect((await stat(path.join(hw.dir, ".git"))).isFile()).toBe(true);

  h2.release();
  await releaseSettled(hw);
}, 45_000);

test("init never registers a jobs dir against the retention cap (the scan reads co/ only)", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const opts: WorkspaceStoreOptions = {
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 1,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  };
  const store1 = new WorkspaceStore(opts);
  await store1.init();
  await store1.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const h1 = await store1.resolve({ repoId: "repo-a", headCommit: c1 });
  h1.release();

  // A populated-LOOKING leftover jobs dir with the newest mtime: were it
  // registered by the checkout scan, it would out-recency the real checkout
  // and cap 1 would evict the real one on the next init.
  const jobsDir = path.join(
    cacheDir,
    repoKey("repo-a"),
    "jobs",
    "cccccccccccc",
  );
  await mkdir(jobsDir, { recursive: true });
  await writeFile(path.join(jobsDir, ".git"), "gitdir: nowhere\n");
  await utimes(jobsDir, new Date(), new Date(Date.now() + 60_000));

  const store2 = new WorkspaceStore(opts);
  await store2.init();
  // The real checkout survived (cap unaffected) and is the ONLY registration.
  expect((await stat(path.join(h1.dir, ".git"))).isFile()).toBe(true);
  const checkouts = (store2 as unknown as { checkouts: Map<string, unknown> })
    .checkouts;
  expect(checkouts.size).toBe(1);
}, 45_000);

test("one live write worktree per jobId: a duplicate resolve fails until the first is released", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  const first = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  await expect(
    store.resolve(
      { repoId: "repo-a", headCommit: c1 },
      { write: { jobId: JOB_A } },
    ),
  ).rejects.toMatchObject({ code: "WRITE_IN_PROGRESS" });
  // The rejected duplicate disturbed neither the live worktree nor its entry.
  expect((await stat(path.join(first.dir, ".git"))).isFile()).toBe(true);
  expect(store.writeJobWorkspace(JOB_A)?.dir).toBe(first.dir);

  // A DIFFERENT jobId is independent.
  const other = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_B } },
  );
  expect(other.dir).not.toBe(first.dir);

  // Once released, the same jobId resolves again (same deterministic path,
  // freshly materialized).
  await releaseSettled(first);
  const again = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  expect(again.dir).toBe(first.dir);
  expect((await stat(path.join(again.dir, ".git"))).isFile()).toBe(true);

  await releaseSettled(other);
  await releaseSettled(again);
}, 60_000);

test("releasing a write handle removes its worktree; a second release is a no-op", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  await releaseSettled(handle);

  // Dir removed from disk, its worktree registration pruned from the cache
  // repo, and the registry no longer answers for the jobId.
  await expect(stat(handle.dir)).rejects.toThrow();
  const worker = workerFor(cacheDir, "repo-a");
  const list = await runGit(["worktree", "list", "--porcelain"], {
    cwd: worker.repoDir,
    timeoutMs: 30_000,
  });
  expect(list.stdout).not.toContain("aaaaaaaaaaaa");
  expect(store.writeJobWorkspace(JOB_A)).toBeUndefined();

  // Idempotent: the second call neither throws nor re-runs teardown.
  await releaseSettled(handle);
  await expect(stat(handle.dir)).rejects.toThrow();
}, 45_000);

test("a post-stop write release runs no git/disk ops: the worktree persists until the next init purges it", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const opts: WorkspaceStoreOptions = {
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 32,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  };
  const store1 = new WorkspaceStore(opts);
  await store1.init();
  await store1.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store1.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );

  await store1.stop();
  // Post-stop the release must not touch git or disk (op-granularity
  // discipline): the worktree stays on disk, in a consistent state.
  await releaseSettled(handle);
  expect((await stat(path.join(handle.dir, ".git"))).isFile()).toBe(true);

  // The next daemon run's init purges it: an in-flight write job never
  // survives a restart.
  const store2 = new WorkspaceStore(opts);
  await store2.init();
  await expect(stat(handle.dir)).rejects.toThrow();

  // The purge deleted only the DIR, leaving a stale worktree admin entry in
  // repo.git — the purge comment claims `addWorktree --force` recovers from
  // exactly that, so pin it: the same jobId materializes again on store2.
  const again = await store2.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  expect(again.dir).toBe(handle.dir);
  expect((await stat(path.join(again.dir, ".git"))).isFile()).toBe(true);
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: again.dir,
    timeoutMs: 30_000,
  });
  expect(head.stdout.trim()).toBe(c1);
  await releaseSettled(again);
}, 45_000);

test("init purges leftover write-job dirs and stale files under jobs/ (and tolerates their absence)", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const opts: WorkspaceStoreOptions = {
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 32,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  };
  // First init: no jobs dirs anywhere — must simply work.
  const store1 = new WorkspaceStore(opts);
  await store1.init();
  await store1.applyBundle("repo-a", await fullBundle(src, c1), c1);

  // Fake leftovers from a crashed run: a half-built worktree dir and a stale
  // artifact bundle (the future finalize step writes these next to the
  // worktrees). Both are garbage by definition after a restart.
  const jobsRoot = path.join(cacheDir, repoKey("repo-a"), "jobs");
  await mkdir(path.join(jobsRoot, "deadbeefdead"), { recursive: true });
  await writeFile(path.join(jobsRoot, "deadbeefdead", "half.txt"), "partial\n");
  await writeFile(path.join(jobsRoot, "aaaaaaaaaaaa.bundle"), "stale\n");

  const store2 = new WorkspaceStore(opts);
  await store2.init();
  await expect(stat(jobsRoot)).rejects.toThrow(); // the whole jobs dir is gone
  // The synced cache itself is untouched.
  expect(await store2.haveTip("repo-a")).toBe(c1);
}, 45_000);

test("stop() ahead of a queued write resolve makes it back off without materializing a worktree", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);

  const internals = store as unknown as {
    withRepoLock<T>(rKey: string, fn: () => Promise<T>): Promise<T>;
  };
  const rKey = repoKey("repo-a");

  // Gated-lock pattern (same as the eviction-halt test): park the repo lock
  // so the write resolve queues behind the gate, land stop() while it waits,
  // then open the gate — its locked callback runs only AFTER the stop.
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const blocker = internals.withRepoLock(rKey, () => gate);
  const resolving = store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  const stopping = store.stop();
  openGate();

  await expect(resolving).rejects.toMatchObject({
    code: "GIT_FAILED",
    message: /stopped/i,
  });
  await Promise.all([blocker, stopping]);

  // Nothing was materialized — the repo's jobs dir was never even created —
  // and the failed resolve deregistered its reservation.
  await expect(stat(path.join(cacheDir, rKey, "jobs"))).rejects.toThrow();
  expect(store.writeJobWorkspace(JOB_A)).toBeUndefined();
}, 45_000);

test("legacy pre-0.1 cache dirs (64-hex) are warned about once and left in place", async () => {
  const cacheDir = path.join(await tempDir("homefleet-cache-"), "workspaces");
  const legacyDir = path.join(cacheDir, "f".repeat(64));
  await mkdir(path.join(legacyDir, "checkouts", "a".repeat(40)), {
    recursive: true,
  });
  const logs: string[] = [];
  const store = new WorkspaceStore({
    cacheDir,
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 512 * 1024 * 1024,
    maxCachedCheckouts: 32,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
    logger: (message) => logs.push(message),
  });
  await store.init();

  // Exactly ONE warning per legacy dir; the dir is neither registered for
  // eviction nor deleted (destroying data on startup is not the store's call).
  expect(
    logs.filter((m) => m.includes("legacy workspace cache layout")),
  ).toHaveLength(1);
  expect((await stat(legacyDir)).isDirectory()).toBe(true);
});

// --- write-job finalize: commit -> branch -> diffstat -> bundle (Task 6) ----

test("finalizeWriteJob commits, bundles, and returns a schema-valid artifact; the branch ref is transient", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  // The model's work: one new file, one modified file.
  await writeFile(path.join(handle.dir, "new.txt"), "created by the job\n");
  await writeFile(
    path.join(handle.dir, "file.txt"),
    "content 0\nplus a new line\n",
  );

  const finalized = await store.finalizeWriteJob({
    jobId: JOB_A,
    commitMessage: "Add new.txt and extend file.txt",
    deviceId8: "abcd1234",
  });

  // Shape-exact under the wire schema (the executor's JobResultSchema.parse
  // backstop makes any deviation a job-rejecting programmer error).
  if (finalized === null) {
    throw new Error("expected an artifact for a dirtied worktree");
  }
  const parsed = WriteArtifactSchema.parse(finalized.artifact);
  expect(parsed.branchName).toBe("homefleet/aaaaaaaaaaaa");
  expect(parsed.baseCommit).toBe(c1);
  expect(parsed.headCommit).not.toBe(c1);
  expect(parsed.diffStat).toEqual({
    filesChanged: 2,
    insertions: 2,
    deletions: 0,
  });
  expect(parsed.commitMessage).toBe("Add new.txt and extend file.txt");

  // Author AND committer identity (design doc §2, "Commit").
  const worker = workerFor(cacheDir, "repo-a");
  const identity = await runGit(
    ["log", "-1", "--format=%an <%ae> %cn <%ce>", parsed.headCommit],
    { cwd: worker.repoDir, timeoutMs: 30_000 },
  );
  expect(identity.stdout.trim()).toBe(
    "HomeFleet Worker <worker@abcd1234.invalid> " +
      "HomeFleet Worker <worker@abcd1234.invalid>",
  );

  // The bundle sits at <repoRoot>/jobs/<jobId12>.bundle and advertises
  // exactly the result branch at the new head; the bare repo (which holds
  // the base) verifies it.
  const bundlePath = path.join(
    cacheDir,
    repoKey("repo-a"),
    "jobs",
    "aaaaaaaaaaaa.bundle",
  );
  expect((await stat(bundlePath)).size).toBeGreaterThan(0);
  // The non-null result also carries what ArtifactStore registration needs
  // (Task 11's closure): the bundle's path and its measured size.
  expect(finalized.bundlePath).toBe(bundlePath);
  expect(finalized.byteLength).toBe((await stat(bundlePath)).size);
  expect(finalized.byteLength).toBeGreaterThan(0);
  const heads = await listBundleHeads(worker, bundlePath);
  expect([...heads.entries()]).toEqual([
    ["refs/heads/homefleet/aaaaaaaaaaaa", parsed.headCommit],
  ]);
  expect(await verifyBundle(worker, bundlePath)).toBe(true);

  // The branch ref was deleted after bundling: the bundle is self-contained,
  // and a lingering ref would leak into future have/gc decisions.
  const refs = await runGit(["show-ref", "homefleet/aaaaaaaaaaaa"], {
    cwd: worker.repoDir,
    timeoutMs: 30_000,
  });
  expect(refs.code).not.toBe(0);
  expect(refs.stdout.trim()).toBe("");

  // release() removes the worktree but NEVER the bundle (a jobs/ SIBLING of
  // the worktree dir): the artifact's lifetime is the job's, not the
  // handle's — job eviction / the next init purge reap it.
  await releaseSettled(handle);
  await expect(stat(handle.dir)).rejects.toThrow();
  expect((await stat(bundlePath)).size).toBeGreaterThan(0);
}, 60_000);

test("finalizeWriteJob returns null on a clean tree: no commit, no ref, no bundle", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );

  const artifact = await store.finalizeWriteJob({
    jobId: JOB_A,
    commitMessage: "would-be message",
    deviceId8: "abcd1234",
  });

  expect(artifact).toBeNull();
  // The worktree still sits at the base commit.
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: handle.dir,
    timeoutMs: 30_000,
  });
  expect(head.stdout.trim()).toBe(c1);
  // No bundle, no ref.
  const bundlePath = path.join(
    cacheDir,
    repoKey("repo-a"),
    "jobs",
    "aaaaaaaaaaaa.bundle",
  );
  await expect(stat(bundlePath)).rejects.toThrow();
  const worker = workerFor(cacheDir, "repo-a");
  const refs = await runGit(["show-ref", "homefleet/aaaaaaaaaaaa"], {
    cwd: worker.repoDir,
    timeoutMs: 30_000,
  });
  expect(refs.code).not.toBe(0);
  await releaseSettled(handle);
}, 45_000);

test("a bundle-create failure still deletes the branch ref and keeps the registry entry live", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  await writeFile(path.join(handle.dir, "new.txt"), "doomed\n");
  // Plant a DIRECTORY at the bundle path: `git bundle create` cannot rename
  // its lockfile over a directory, so bundling fails AFTER the commit and
  // the branch ref were created.
  const bundlePath = path.join(
    cacheDir,
    repoKey("repo-a"),
    "jobs",
    "aaaaaaaaaaaa.bundle",
  );
  await mkdir(bundlePath, { recursive: true });

  await expect(
    store.finalizeWriteJob({
      jobId: JOB_A,
      commitMessage: "will not bundle",
      deviceId8: "abcd1234",
    }),
  ).rejects.toMatchObject({ code: "GIT_FAILED", message: /bundle/i });

  // The finally-path deleteRef ran: no homefleet ref lingers in the bare
  // repo to leak into future have/gc decisions (the invariant Task 9's
  // delegator-side have-computation builds on).
  const worker = workerFor(cacheDir, "repo-a");
  const refs = await runGit(["show-ref", "homefleet/aaaaaaaaaaaa"], {
    cwd: worker.repoDir,
    timeoutMs: 30_000,
  });
  expect(refs.code).not.toBe(0);
  expect(refs.stdout.trim()).toBe("");
  // The entry stays live — release() still owns the worktree teardown — and
  // no partial bundle FILE appeared (the planted directory is untouched).
  expect(store.writeJobWorkspace(JOB_A)).toBeDefined();
  expect((await stat(bundlePath)).isDirectory()).toBe(true);
  await releaseSettled(handle);
}, 45_000);

test("finalizeWriteJob for a jobId without a live write worktree fails NO_WRITE_WORKSPACE", async () => {
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const rejection = await store
    .finalizeWriteJob({
      jobId: JOB_A,
      commitMessage: "m",
      deviceId8: "abcd1234",
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(WorkspaceError);
  expect((rejection as WorkspaceError).code).toBe("NO_WRITE_WORKSPACE");
});

test("a stopped store refuses finalizeWriteJob", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  await writeFile(path.join(handle.dir, "new.txt"), "too late\n");

  await store.stop();

  await expect(
    store.finalizeWriteJob({
      jobId: JOB_A,
      commitMessage: "m",
      deviceId8: "abcd1234",
    }),
  ).rejects.toMatchObject({ code: "GIT_FAILED", message: /stopped/i });
}, 45_000);

test("aborting the job signal mid-finalize rejects with an AbortError-named error and commits nothing", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  const cacheDir = (store as unknown as { cacheDir: string }).cacheDir;
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  await writeFile(path.join(handle.dir, "new.txt"), "unfinished\n");

  // Gated-lock pattern: park the repo lock so finalize queues behind the
  // gate, abort the JOB signal while it waits, then open the gate — the
  // finalize's locked callback observes the abort before any git op.
  const internals = store as unknown as {
    withRepoLock<T>(rKey: string, fn: () => Promise<T>): Promise<T>;
  };
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const blocker = internals.withRepoLock(repoKey("repo-a"), () => gate);
  const controller = new AbortController();
  const finalizing = store.finalizeWriteJob({
    jobId: JOB_A,
    commitMessage: "never lands",
    deviceId8: "abcd1234",
    signal: controller.signal,
  });
  controller.abort();
  openGate();

  const rejection = await finalizing.then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).name).toBe("AbortError");
  await blocker;

  // Nothing was committed or bundled; the entry stays live for release().
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: handle.dir,
    timeoutMs: 30_000,
  });
  expect(head.stdout.trim()).toBe(c1);
  const bundlePath = path.join(
    cacheDir,
    repoKey("repo-a"),
    "jobs",
    "aaaaaaaaaaaa.bundle",
  );
  await expect(stat(bundlePath)).rejects.toThrow();
  expect(store.writeJobWorkspace(JOB_A)).toBeDefined();
  await releaseSettled(handle);
}, 45_000);

test("an already-aborted job signal rejects finalizeWriteJob before any git op", async () => {
  const src = await makeSrc();
  const c1 = await src.commit("c1");
  const store = await makeStore({ allowedRepoIds: ["repo-a"] });
  await store.applyBundle("repo-a", await fullBundle(src, c1), c1);
  const handle = await store.resolve(
    { repoId: "repo-a", headCommit: c1 },
    { write: { jobId: JOB_A } },
  );
  const controller = new AbortController();
  controller.abort();

  const rejection = await store
    .finalizeWriteJob({
      jobId: JOB_A,
      commitMessage: "m",
      deviceId8: "abcd1234",
      signal: controller.signal,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).name).toBe("AbortError");
  await releaseSettled(handle);
}, 45_000);
