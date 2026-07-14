/**
 * Shared fixtures and helpers for the daemon test suite. Not exported from
 * the package.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockOpenAiEndpoint, type MockScriptEntry } from "@homefleet/executors";
import { HFP_PROTOCOL_VERSION, type NodeInfo } from "@homefleet/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect } from "vitest";
import { type DaemonConfig, DaemonConfigSchema } from "./config/config.js";
import { resolveDataDir } from "./config/paths.js";
import { Daemon } from "./daemon.js";
import type {
  MdnsBackend,
  MdnsFoundService,
  MdnsPublishRequest,
} from "./discovery/mdns.js";
import { ok, resolveHeadCommit, runGit } from "./workspace/git.js";

/** Builds a minimal valid NodeInfo for a device under test. */
export function makeNodeInfo(deviceId: string, name: string): NodeInfo {
  return {
    deviceId,
    name,
    daemonVersion: "0.1.0",
    protocolVersion: HFP_PROTOCOL_VERSION,
    platform: "win32",
    roles: ["execution"],
    executors: ["command"],
    models: [],
    hardware: { cpu: "test-cpu", ramBytes: 0, gpus: [] },
    maxConcurrentJobs: 1,
    activeJobs: 0,
  };
}

/** Creates a fresh temp data dir (HOMEFLEET_DATA_DIR-style, per test). */
export async function makeTempDataDir(
  prefix = "homefleet-test-",
): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temp dir, retrying to ride out transient Windows file locking.
 */
export async function removeTempDataDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export interface FakePublication {
  request: MdnsPublishRequest;
  stopped: boolean;
  stop(): Promise<void>;
}

export interface FakeBrowser {
  type: string;
  onUp: (service: MdnsFoundService) => void;
  stopped: boolean;
  stop(): void;
}

/**
 * The one sanctioned fake: stands in for bonjour-service, which cannot be
 * exercised deterministically in CI. Publications are delivered to browsers
 * (existing and late-registered) like an mDNS cache would; the TXT
 * encode/decode under test is the real code in discovery/mdns.ts.
 */
export class FakeMdnsBackend implements MdnsBackend {
  publications: FakePublication[] = [];
  browsers: FakeBrowser[] = [];
  destroyed = false;
  /** Addresses attached to delivered services. */
  addresses: string[] = ["192.168.1.20"];
  /**
   * Opt-in probe-death modeling: a publication matching this predicate is
   * never delivered to any browser — like a bonjour-service publication
   * that silently lost its probe race (no announce, no error event).
   * Defaults to delivering everything.
   */
  suppressDelivery: (request: MdnsPublishRequest) => boolean = () => false;

  publish(request: MdnsPublishRequest): FakePublication {
    const publication: FakePublication = {
      request,
      stopped: false,
      stop: async () => {
        publication.stopped = true;
      },
    };
    this.publications.push(publication);
    for (const browser of this.browsers) {
      this.deliverTo(browser, publication);
    }
    return publication;
  }

  browse(type: string, onUp: (service: MdnsFoundService) => void): FakeBrowser {
    const browser: FakeBrowser = {
      type,
      onUp,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    this.browsers.push(browser);
    for (const publication of this.publications) {
      this.deliverTo(browser, publication);
    }
    return browser;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  /** Delivers an arbitrary service to every live browser. */
  deliver(service: MdnsFoundService): void {
    for (const browser of this.browsers) {
      if (!browser.stopped && browser.type === service.type) {
        browser.onUp(service);
      }
    }
  }

  activePublications(): FakePublication[] {
    return this.publications.filter((publication) => !publication.stopped);
  }

  private deliverTo(browser: FakeBrowser, publication: FakePublication): void {
    if (browser.stopped || publication.stopped) {
      return;
    }
    if (this.suppressDelivery(publication.request)) {
      return;
    }
    if (browser.type !== publication.request.type) {
      return;
    }
    browser.onUp({
      type: publication.request.type,
      name: publication.request.name,
      port: publication.request.port,
      txt: { ...publication.request.txt },
      addresses: [...this.addresses],
    });
  }
}

/*
 * ---------------------------------------------------------------------------
 * Two-daemon integration harness
 * ---------------------------------------------------------------------------
 * Shared machinery for suites that assemble two REAL `Daemon`s on loopback
 * (daemon.integration.test.ts, daemon.control.integration.test.ts,
 * workspace/write-delegation.integration.test.ts): temp data dirs, ephemeral
 * loopback ports, in-process pairing, an MCP client, and a tiny seeded git
 * repo. `createDaemonHarness()` is a per-file FACTORY rather than free
 * functions plus a module-level `afterEach`: `afterEach` must attach to each
 * test file's own suite, and calling it here at this module's top level would
 * run once at first import and attach to whichever file happened to import
 * this module first. Calling it INSIDE the factory — which each test file
 * invokes at its own top level — makes each `afterEach` register in the
 * calling file's collection context instead.
 */

/** Loopback host every test daemon binds to. */
export const HOST = "127.0.0.1";

/** The repoId the delegator maps to the seeded source repo in write-E2E tests. */
export const REPO_ID = "repo-x";

/** A tiny seeded source repo: its path, HEAD commit, and a `git` runner. */
export interface SrcRepo {
  repoPath: string;
  head: string;
  git: (args: string[]) => Promise<string>;
}

/** What starting a test daemon hands back: the instance and its data dir. */
export interface DaemonHandle {
  daemon: Daemon;
  /**
   * The resolved data dir. Returned because `Daemon.dataDir` is private with
   * no public getter, and the write-delegation/hostile-set tests need it to
   * inspect the on-disk workspace cache (e.g. `workerRepoRoot`).
   */
  dataDir: string;
}

/** The two-daemon integration-test helpers, bound to one cleanup registry. */
export interface DaemonHarness {
  /** Registers a teardown callback; drained LIFO in this file's `afterEach`. */
  onCleanup(fn: () => Promise<void>): void;
  /** Creates a fresh temp dir under `prefix`; removal is auto-registered. */
  tempDir(prefix: string): Promise<string>;
  /**
   * Raw config input for a test daemon: loopback HFP + MCP + control on
   * ephemeral ports (two daemons run side by side in these suites; the
   * config schema's default control port is a single fixed value, so
   * leaving it unset would collide the moment a second daemon tried to bind
   * it), live discovery channels OFF (no real mDNS/UDP in tests — Windows CI
   * and parallel suites would cross-talk), everything else from `overrides`.
   */
  testConfig(name: string, overrides?: Record<string, unknown>): DaemonConfig;
  /**
   * Starts an assembled daemon on ephemeral loopback ports, exactly the way
   * `homefleetd` builds one (config object -> `Daemon.start()`); registers
   * its `stop()` as cleanup. `dataDirOverride` lets a second daemon come up
   * over the SAME data dir (a restart test).
   */
  startDaemon(
    name: string,
    overrides?: Record<string, unknown>,
    dataDirOverride?: string,
  ): Promise<DaemonHandle>;
  /** Pairs `a` -> `b`: afterwards `b` trusts `a` and `a` trusts (pins) `b`. */
  pair(a: Daemon, b: Daemon): Promise<void>;
  /** Connects a real MCP client to a daemon's HTTP front. */
  connectMcp(daemon: Daemon, clientName?: string): Promise<Client>;
  /** A tiny source repo with one committed file (`data.txt`). */
  makeSrcRepo(contents: string): Promise<SrcRepo>;
  /** Polls `predicate` every 50ms until true, or throws after `timeoutMs`. */
  waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs?: number,
    label?: string,
  ): Promise<void>;
  /** Starts a scripted mock OpenAI endpoint; registers its `close()`. */
  startMockEndpoint(script: MockScriptEntry[]): Promise<MockOpenAiEndpoint>;
}

/**
 * Builds the shared two-daemon harness. Call ONCE at a test file's top
 * level — it installs an `afterEach` (in the CALLING file's suite; see the
 * module doc above) that tears down, in reverse order, everything created
 * through the returned helpers.
 *
 * `tempPrefix` seeds the diagnostic temp-dir names `startDaemon` and
 * `makeSrcRepo` build (e.g. `<tempPrefix>-worker-`, `<tempPrefix>-src-`), so
 * each file's temp dirs keep a recognizable prefix on disk. Purely cosmetic —
 * nothing asserts it — so callers that don't care can omit it.
 */
export function createDaemonHarness(
  options: { tempPrefix?: string } = {},
): DaemonHarness {
  const tempPrefix = options.tempPrefix ?? "homefleet-daemon";
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  function onCleanup(fn: () => Promise<void>): void {
    cleanups.push(fn);
  }

  async function tempDir(prefix: string): Promise<string> {
    const dir = await makeTempDataDir(prefix);
    onCleanup(() => removeTempDataDir(dir));
    return dir;
  }

  function testConfig(
    name: string,
    overrides: Record<string, unknown> = {},
  ): DaemonConfig {
    return DaemonConfigSchema.parse({
      node: { name },
      hfp: { host: HOST, port: 0 },
      mcp: { host: HOST, port: 0 },
      control: { host: HOST, port: 0 },
      discovery: { mdnsEnabled: false, udpEnabled: false },
      ...overrides,
    });
  }

  async function startDaemon(
    name: string,
    overrides: Record<string, unknown> = {},
    dataDirOverride?: string,
  ): Promise<DaemonHandle> {
    const dataDir = resolveDataDir({
      HOMEFLEET_DATA_DIR:
        dataDirOverride ?? (await tempDir(`${tempPrefix}-${name}-`)),
    });
    const daemon = new Daemon({ dataDir, config: testConfig(name, overrides) });
    await daemon.start();
    onCleanup(() => daemon.stop());
    return { daemon, dataDir };
  }

  async function pair(a: Daemon, b: Daemon): Promise<void> {
    const { code } = b.pairingManager.beginPairing();
    const { response, serverDeviceId } = await a.hfpClient.pair(
      { host: HOST, port: b.hfpPort },
      code,
      a.nodeInfo(),
    );
    expect(response.accepted).toBe(true);
    await a.trustStore.add({
      deviceId: serverDeviceId,
      name: response.nodeInfo?.name ?? "peer",
      addedAt: new Date().toISOString(),
    });
  }

  async function connectMcp(
    daemon: Daemon,
    clientName = "daemon-test",
  ): Promise<Client> {
    const client = new Client({ name: clientName, version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${HOST}:${daemon.mcpPort}/mcp`),
    );
    await client.connect(transport);
    onCleanup(async () => {
      await client.close();
      await transport.close();
    });
    return client;
  }

  async function makeSrcRepo(contents: string): Promise<SrcRepo> {
    const repoPath = await tempDir(`${tempPrefix}-src-`);
    const git = async (args: string[]): Promise<string> => {
      const r = await runGit(args, { cwd: repoPath, timeoutMs: 30_000 });
      if (!ok(r)) {
        throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      }
      return r.stdout.trim();
    };
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repoPath, "data.txt"), contents);
    await git(["add", "-A"]);
    await git(["commit", "--quiet", "-m", "c1"]);
    return { repoPath, git, head: await resolveHeadCommit(repoPath, 30_000) };
  }

  async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 15_000,
    label = "condition",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`waitUntil timed out: ${label}`);
  }

  async function startMockEndpoint(
    script: MockScriptEntry[],
  ): Promise<MockOpenAiEndpoint> {
    const mock = await MockOpenAiEndpoint.start(script);
    onCleanup(() => mock.close());
    return mock;
  }

  return {
    onCleanup,
    tempDir,
    testConfig,
    startDaemon,
    pair,
    connectMcp,
    makeSrcRepo,
    waitUntil,
    startMockEndpoint,
  };
}

/** The worker-side write-executor config against a scripted mock endpoint. */
export function writeExecutorConfig(mock: MockOpenAiEndpoint): {
  endpoint: { baseUrl: string; model: string; contextWindow: number };
  commandAllowlist: { node: { executable: string } };
} {
  return {
    endpoint: {
      baseUrl: mock.baseUrl,
      model: "test-model",
      contextWindow: 32_768,
    },
    commandAllowlist: { node: { executable: process.execPath } },
  };
}

/**
 * Delegator config overrides that statically discover `worker` (no live
 * mDNS/UDP) and map `REPO_ID` to `src`'s local path, so `delegate_task` can
 * sync it on its own.
 */
export function delegatorOverrides(
  worker: Daemon,
  src: SrcRepo,
): {
  discovery: {
    mdnsEnabled: boolean;
    udpEnabled: boolean;
    staticNodes: Array<{
      host: string;
      port: number;
      expectedDeviceId: string;
    }>;
  };
  repos: Array<{ repoId: string; path: string }>;
} {
  return {
    discovery: {
      mdnsEnabled: false,
      udpEnabled: false,
      staticNodes: [
        { host: HOST, port: worker.hfpPort, expectedDeviceId: worker.deviceId },
      ],
    },
    repos: [{ repoId: REPO_ID, path: src.repoPath }],
  };
}
