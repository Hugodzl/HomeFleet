/**
 * Loopback integration tests for the HFP workspace-sync transport (M7): the
 * have-tip JSON route and the binary bundle-upload route, driven by the real
 * HfpClient over real mTLS against a real WorkspaceStore. Real git, real
 * bundles; the only thing not exercised here is the delegating-side sync
 * orchestration (covered by the sync integration suite).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveDataDir } from "../config/paths.js";
import { type Identity, loadOrCreateIdentity } from "../identity/identity.js";
import { PairingManager } from "../pairing/pairing.js";
import {
  makeNodeInfo,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import {
  HfpClient,
  type HfpRequestError,
  type HfpTarget,
} from "../transport/client.js";
import { NodeServer } from "../transport/server.js";
import { TrustStore } from "../trust/trust-store.js";
import { createBundle, ok, resolveHeadCommit, runGit } from "./git.js";
import { registerWorkspaceRoutes } from "./routes.js";
import { WorkspaceStore } from "./workspace-store.js";

const HOST = "127.0.0.1";
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

interface Node {
  identity: Identity;
  trustStore: TrustStore;
  pairing: PairingManager;
  client: HfpClient;
  port: number;
  store: WorkspaceStore;
  cacheDir: string;
  nodeInfo: () => ReturnType<typeof makeNodeInfo>;
}

async function createNode(
  name: string,
  options: { allowedRepoIds?: string[]; maxBundleBytes?: number } = {},
): Promise<Node> {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await tempDir(`homefleet-ws-${name}-`),
  });
  const identity = await loadOrCreateIdentity(dataDir);
  const trustStore = await TrustStore.load(dataDir);
  const nodeInfo = (): ReturnType<typeof makeNodeInfo> =>
    makeNodeInfo(identity.deviceId, name);
  const pairing = new PairingManager({
    trustStore,
    nodeInfoProvider: nodeInfo,
  });

  const cacheDir = path.join(await tempDir(`homefleet-cache-${name}-`), "ws");
  const store = new WorkspaceStore({
    cacheDir,
    allowedRepoIds: options.allowedRepoIds ?? [],
    maxBundleBytes: options.maxBundleBytes ?? 512 * 1024 * 1024,
    maxCachedCheckouts: 8,
    gcAfterFetches: 100,
    gitTimeoutMs: 30_000,
  });
  await store.init();

  const server = new NodeServer({
    identity,
    trustStore,
    nodeInfoProvider: nodeInfo,
    pairingManager: pairing,
    host: HOST,
    port: 0,
  });
  registerWorkspaceRoutes(server, store);
  const { port } = await server.start();
  cleanups.push(async () => {
    await server.stop();
  });

  return {
    identity,
    trustStore,
    pairing,
    client: new HfpClient(identity),
    port,
    store,
    cacheDir,
    nodeInfo,
  };
}

async function pair(a: Node, b: Node): Promise<void> {
  const { code } = b.pairing.beginPairing();
  const { response, serverDeviceId } = await a.client.pair(
    { host: HOST, port: b.port },
    code,
    a.nodeInfo(),
  );
  expect(response.accepted).toBe(true);
  await a.trustStore.add({
    deviceId: serverDeviceId,
    name: "b",
    addedAt: new Date().toISOString(),
  });
}

function target(b: Node): HfpTarget {
  return { host: HOST, port: b.port, expectedDeviceId: b.identity.deviceId };
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

async function makeFullBundle(src: Src, head: string): Promise<string> {
  const dir = await tempDir("homefleet-bundle-");
  const bundlePath = path.join(dir, "full.bundle");
  await createBundle({ repoPath: src.repoPath, bundlePath, headCommit: head });
  return bundlePath;
}

test("have-tip is null before sync and the head after uploading a bundle", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const a = await createNode("alpha");
  const b = await createNode("bravo", { allowedRepoIds: ["repo-a"] });
  await pair(a, b);

  expect(await a.client.haveTip(target(b), "repo-a")).toBeNull();

  const res = await a.client.uploadBundle(
    target(b),
    "repo-a",
    head,
    await makeFullBundle(src, head),
  );
  expect(res).toEqual({ ok: true, headCommit: head });
  expect(await a.client.haveTip(target(b), "repo-a")).toBe(head);

  // The worker can now materialize the committed file for that commit.
  const { dir } = await b.store.resolve({ repoId: "repo-a", headCommit: head });
  expect(await readFile(path.join(dir, "file.txt"), "utf8")).toBe(
    "content 0\n",
  );
}, 30_000);

test("an unpaired peer is rejected at the auth chokepoint (401)", async () => {
  const a = await createNode("alpha");
  const b = await createNode("bravo", { allowedRepoIds: ["repo-a"] });
  // No pairing.
  const error = await a.client.haveTip(target(b), "repo-a").then(
    () => null,
    (e: unknown) => e as HfpRequestError,
  );
  expect(error?.status).toBe(401);
  expect(error?.hfpError?.code).toBe("UNAUTHORIZED");
});

test("uploading a non-allowlisted repo is rejected 403 and writes nothing", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const a = await createNode("alpha");
  const b = await createNode("bravo", { allowedRepoIds: ["repo-a"] });
  await pair(a, b);

  const error = await a.client
    .uploadBundle(target(b), "evil", head, await makeFullBundle(src, head))
    .then(
      () => null,
      (e: unknown) => e as HfpRequestError,
    );
  expect(error?.status).toBe(403);
  expect(error?.hfpError?.code).toBe("WORKSPACE_UNAVAILABLE");

  // have-tip for a non-allowlisted repo is an error too — NOT a silent null.
  const tipErr = await a.client.haveTip(target(b), "evil").then(
    () => null,
    (e: unknown) => e as HfpRequestError,
  );
  expect(tipErr?.status).toBe(403);

  // Nothing was written for the rejected repo: only `.no-hooks` under the cache.
  expect(await readdir(b.cacheDir)).toEqual([".no-hooks"]);
}, 30_000);

test("an oversized bundle is rejected with 413 and the daemon survives", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const a = await createNode("alpha");
  // A tiny cap so a real bundle overflows it.
  const b = await createNode("bravo", {
    allowedRepoIds: ["repo-a"],
    maxBundleBytes: 16,
  });
  await pair(a, b);

  const error = await a.client
    .uploadBundle(target(b), "repo-a", head, await makeFullBundle(src, head))
    .then(
      () => null,
      (e: unknown) => e as HfpRequestError,
    );
  expect(error?.status).toBe(413);

  // The daemon is still alive and serving after aborting the oversized upload.
  expect(await a.client.haveTip(target(b), "repo-a")).toBeNull();
}, 30_000);

test("a malformed (non-bundle) upload is rejected without corrupting the cache", async () => {
  const a = await createNode("alpha");
  const b = await createNode("bravo", { allowedRepoIds: ["repo-a"] });
  await pair(a, b);

  const garbageDir = await tempDir("homefleet-garbage-");
  const garbage = path.join(garbageDir, "garbage.bundle");
  await writeFile(garbage, "definitely not a git bundle\n");

  const error = await a.client
    .uploadBundle(target(b), "repo-a", "a".repeat(40), garbage)
    .then(
      () => null,
      (e: unknown) => e as HfpRequestError,
    );
  expect(error?.status).toBe(400);
  expect(await a.client.haveTip(target(b), "repo-a")).toBeNull();
}, 30_000);

test("a bundle that does not deliver the claimed headCommit is rejected (400)", async () => {
  const src = await makeSrc();
  const head = await src.commit("c1");
  const a = await createNode("alpha");
  const b = await createNode("bravo", { allowedRepoIds: ["repo-a"] });
  await pair(a, b);

  // Valid bundle of `head`, but claim a different commit.
  const error = await a.client
    .uploadBundle(
      target(b),
      "repo-a",
      "0".repeat(40),
      await makeFullBundle(src, head),
    )
    .then(
      () => null,
      (e: unknown) => e as HfpRequestError,
    );
  expect(error?.status).toBe(400);
  expect(await a.client.haveTip(target(b), "repo-a")).toBeNull();
}, 30_000);
