/**
 * Unit tests for the worker-side workspace store (M7). Real git, real repos,
 * real bundles created via the git core; no faking. Covers the allowlist
 * (fail-closed), repoId path-traversal neutralization, full+incremental sync,
 * malformed / undelivered-commit rejection, per-repo serialization, and the
 * checkout retention cap.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import {
  commitPresent,
  countObjects,
  createBundle,
  ok,
  resolveHeadCommit,
  runGit,
  type WorkerGit,
} from "./git.js";
import {
  repoHash,
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
    repoDir: path.join(cacheDir, repoHash(repoId), "repo.git"),
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
    expect(resolved).toContain(repoHash(repoId));
  }

  // Every top-level cache entry is either `.no-hooks` or a 64-hex hash dir —
  // no traversal produced a path segment outside the cache root.
  const entries = await readdir(cacheDir);
  for (const entry of entries) {
    expect(entry === ".no-hooks" || /^[0-9a-f]{64}$/.test(entry)).toBe(true);
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
  const remaining = await readdir(
    path.join(cacheDir, repoHash("repo-a"), "checkouts"),
  );
  expect(remaining).toHaveLength(1);
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
  const hash = repoHash("repo-a");
  expect(internals.abort.signal.aborted).toBe(false);
  expect(internals.worker(hash).signal).toBe(internals.abort.signal);

  await store.stop();
  expect(internals.abort.signal.aborted).toBe(true);
  // Still the same signal, now aborted — an in-flight op observing it is killed.
  expect(internals.worker(hash).signal?.aborted).toBe(true);
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
