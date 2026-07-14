/**
 * Daemon-assembly integration (M9): two REAL `Daemon` instances on 127.0.0.1
 * with temp data dirs, built exactly the way `homefleetd` builds them (config
 * object -> Daemon.start()). Discovery runs with mDNS/UDP disabled and a
 * static-node entry pointing at the worker — deterministic, no LAN
 * cross-talk — so the delegator's node directory resolves the worker through
 * the SAME aggregator path production uses. The delegator is driven through
 * its full MCP HTTP front with the real SDK client (the transport a local
 * agent would use). Real git, mTLS, sockets, executors; no fakes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import path from "node:path";
import { MockOpenAiEndpoint, type MockScriptEntry } from "@homefleet/executors";
import { JobResultSchema, writeBranchName } from "@homefleet/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { DaemonConfigSchema } from "./config/config.js";
import { resolveDataDir } from "./config/paths.js";
import { Daemon } from "./daemon.js";
import { JobResultOutputSchema, ListNodesOutputSchema } from "./mcp/tools.js";
import { makeTempDataDir, removeTempDataDir } from "./test-fixtures.js";
import { ok, resolveHeadCommit, runGit } from "./workspace/git.js";

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

/**
 * Raw config input for a test daemon: loopback HFP + MCP + control on
 * ephemeral ports (two daemons run side by side in this suite; the config
 * schema's default control port is a single fixed value, so leaving it
 * unset would collide the moment a second daemon tried to bind it), live
 * discovery channels OFF (no real mDNS/UDP in tests — Windows CI and
 * parallel suites would cross-talk), everything else from `overrides`.
 */
function testConfig(name: string, overrides: Record<string, unknown> = {}) {
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
): Promise<Daemon> {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await tempDir(`homefleet-daemon-${name}-`),
  });
  const daemon = new Daemon({ dataDir, config: testConfig(name, overrides) });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

/** Pairs `a` -> `b`: afterwards `b` trusts `a` and `a` trusts (pins) `b`. */
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

/** Connects a real MCP client to a daemon's HTTP front. */
async function connectMcp(daemon: Daemon): Promise<Client> {
  const client = new Client({ name: "daemon-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${HOST}:${daemon.mcpPort}/mcp`),
  );
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
    await transport.close();
  });
  return client;
}

/** A tiny source repo with one file, committed; returns path + head commit. */
async function makeSrcRepo(
  contents: string,
): Promise<{ repoPath: string; head: string }> {
  const repoPath = await tempDir("homefleet-daemon-src-");
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
  await writeFile(path.join(repoPath, "data.txt"), contents);
  await run(["add", "-A"]);
  await run(["commit", "--quiet", "-m", "c1"]);
  return { repoPath, head: await resolveHeadCommit(repoPath, 30_000) };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitUntil timed out");
}

/** Reserves an ephemeral port by binding and releasing it (test-only race). */
async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("non-TCP address"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** True when a TCP connect to 127.0.0.1:port succeeds (something listens). */
function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test("two assembled daemons: pair, delegate_task auto-syncs the workspace through the MCP HTTP front, clean stop", async () => {
  // The source repo exists BEFORE either daemon starts, since it is now the
  // delegator's config (not a manual pre-sync) that makes it available.
  const src = await makeSrcRepo("hello from the assembled daemon");

  // Worker: offers a command executor (node) and allows repo-x syncs.
  const worker = await startDaemon("worker", {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
    workspace: { allowedRepoIds: ["repo-x"] },
  });
  // Delegator: no executors; discovers the worker via a static config entry
  // (the deterministic stand-in for mDNS/UDP on a test box); maps "repo-x" to
  // the source repo's local path so delegate_task can sync it on its own
  // (M9 Unit 6 — no manual pre-sync from the test).
  const delegator = await startDaemon("delegator", {
    discovery: {
      mdnsEnabled: false,
      udpEnabled: false,
      staticNodes: [
        { host: HOST, port: worker.hfpPort, expectedDeviceId: worker.deviceId },
      ],
    },
    repos: [{ repoId: "repo-x", path: src.repoPath }],
  });
  await pair(delegator, worker);

  const mcp = await connectMcp(delegator);

  // list_nodes: the worker is reachable with its REAL config-driven NodeInfo.
  const listed = await mcp.callTool({ name: "list_nodes", arguments: {} });
  expect(listed.isError).toBeFalsy();
  const { nodes } = ListNodesOutputSchema.parse(listed.structuredContent);
  const peer = nodes.find((n) => n.deviceId === worker.deviceId);
  expect(peer?.reachable).toBe(true);
  expect(peer?.name).toBe("worker");
  expect(peer?.executors).toEqual(["command"]);
  expect(peer?.roles).toEqual(["execution"]);
  expect(peer?.maxConcurrentJobs).toBeGreaterThanOrEqual(1);

  // delegate_task -> the daemon syncs "repo-x" (from its config mapping) to
  // the worker BEFORE dispatching, then the job runs IN that synced
  // workspace. The agent supplies only the repoId; no headCommit.
  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "command",
        workspace: { repoId: "repo-x" },
        command: "node",
        args: [
          "-e",
          "process.stdout.write(require('fs').readFileSync('data.txt','utf8'))",
        ],
      },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

  // Poll job_result through the MCP front until the job is terminal.
  let structured: unknown;
  await waitUntil(async () => {
    const r = await mcp.callTool({ name: "job_result", arguments: { jobId } });
    structured = r.structuredContent;
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  });
  const jobResult = JobResultSchema.parse(
    JobResultOutputSchema.parse(structured).result,
  );
  expect(jobResult.status).toBe("succeeded");
  expect(jobResult.output?.stdout).toBe("hello from the assembled daemon");

  // Explicit ordered stop; second stop is an idempotent no-op. (The afterEach
  // cleanups call stop() again — the test passing without a hang IS the
  // teardown assertion: no leaked sockets, jobs, or git children.)
  await delegator.stop();
  await delegator.stop();
  await worker.stop();
}, 90_000);

// This test owns the APPLY LIFECYCLE (sabotage -> failed apply -> retry ->
// no re-download once applied). The delivery assertions (author identity,
// diffStat fidelity, checked-out content, untouched source tree) and the
// hostile/edge set (cancel, verify failure, eviction, .git writes, restart)
// live in workspace/write-delegation.integration.test.ts — don't duplicate
// them here.
test("write delegation end to end: delegate through MCP, lazy apply on job_result, retry after a failed apply, no re-download once applied", async () => {
  const src = await makeSrcRepo("original contents\n");
  const gitIn = async (args: string[]): Promise<string> => {
    const r = await runGit(args, { cwd: src.repoPath, timeoutMs: 30_000 });
    if (!ok(r)) {
      throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }
    return r.stdout.trim();
  };

  // The worker's write model: one edit with DISTINCTIVE content, then done.
  const script: MockScriptEntry[] = [
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: {
            path: "src/added.txt",
            content: "written by the worker model\n",
          },
        },
      ],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: {
            summary: "added src/added.txt",
            commitMessage: "feat: add added.txt",
          },
        },
      ],
    },
  ];
  const mock = await MockOpenAiEndpoint.start(script);
  cleanups.push(() => mock.close());

  const worker = await startDaemon("worker", {
    executors: {
      write: {
        endpoint: {
          baseUrl: mock.baseUrl,
          model: "test-model",
          contextWindow: 32_768,
        },
        commandAllowlist: { node: { executable: process.execPath } },
      },
    },
    workspace: { allowedRepoIds: ["repo-x"] },
  });
  const delegator = await startDaemon("delegator", {
    discovery: {
      mdnsEnabled: false,
      udpEnabled: false,
      staticNodes: [
        { host: HOST, port: worker.hfpPort, expectedDeviceId: worker.deviceId },
      ],
    },
    repos: [{ repoId: "repo-x", path: src.repoPath }],
  });
  await pair(delegator, worker);
  const mcp = await connectMcp(delegator);

  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "write",
        workspace: { repoId: "repo-x" },
        instructions: "Add src/added.txt with the given content.",
        pathHints: ["src/added.txt"],
        verifyCommand: { name: "node", args: ["-e", "process.exit(0)"] },
      },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  const branchName = writeBranchName(jobId);
  const branchRef = `refs/heads/${branchName}`;

  // Sabotage the FIRST apply: plant the job's reserved ref at a DIVERGED
  // commit (a new commit on the source repo's main line, made after the
  // sync), so the non-forced fetch refuses it as non-fast-forward.
  await writeFile(path.join(src.repoPath, "diverge.txt"), "diverged\n");
  await gitIn(["add", "-A"]);
  await gitIn(["commit", "--quiet", "-m", "diverge"]);
  const divergedTip = await gitIn(["rev-parse", "HEAD"]);
  await gitIn(["update-ref", branchRef, divergedTip]);

  // Poll job_result until terminal; the terminal call attempts the apply.
  let structured: unknown;
  await waitUntil(async () => {
    const r = await mcp.callTool({ name: "job_result", arguments: { jobId } });
    structured = r.structuredContent;
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  }, 60_000);
  const firstTerminal = JobResultOutputSchema.parse(structured);
  expect(firstTerminal.status).toBe("succeeded");
  const jobResult = JobResultSchema.parse(firstTerminal.result);
  expect(jobResult.type).toBe("write");
  expect(jobResult.summary).toBe("added src/added.txt");
  const artifact = jobResult.artifact;
  if (artifact === null || artifact === undefined) {
    throw new Error("expected a write artifact");
  }
  expect(artifact.branchName).toBe(branchName);
  expect(artifact.baseCommit).toBe(src.head);
  expect(artifact.commitMessage).toBe("feat: add added.txt");
  expect(artifact.diffStat).toEqual({
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  // The verify command ran (report-only) with the configured allowlist.
  expect(jobResult.verify).toMatchObject({ name: "node", exitCode: 0 });

  // First apply FAILED (diverged ref, non-fast-forward), with the reason;
  // the diverged ref is untouched.
  expect(firstTerminal.artifactStatus).toBe("failed");
  expect(firstTerminal.applyError).toMatch(/NON_FAST_FORWARD/);
  expect(firstTerminal.reviewCommand).toBeUndefined();
  expect(await gitIn(["rev-parse", branchRef])).toBe(divergedTip);

  // Clear the saboteur ref; the NEXT job_result call retries and applies.
  await gitIn(["update-ref", "-d", branchRef]);
  const retried = await mcp.callTool({
    name: "job_result",
    arguments: { jobId },
  });
  const retriedParsed = JobResultOutputSchema.parse(retried.structuredContent);
  expect(retriedParsed.artifactStatus).toBe("applied");
  expect(retriedParsed.reviewCommand).toBe(
    `git diff ${artifact.baseCommit}...${branchName}`,
  );
  expect(retriedParsed.applyError).toBeUndefined();

  // The branch now exists at EXACTLY the artifact's head, carrying the
  // model's file with the model's content, committed under its message.
  expect(await gitIn(["rev-parse", branchRef])).toBe(artifact.headCommit);
  expect(await gitIn(["show", `${branchRef}:src/added.txt`])).toBe(
    "written by the worker model",
  );
  expect(await gitIn(["log", "-1", "--format=%s", branchRef])).toBe(
    "feat: add added.txt",
  );

  // No re-download once applied: delete the ref, ask again — the registry
  // remembers the apply, so nothing re-fetches or re-creates the ref.
  await gitIn(["update-ref", "-d", branchRef]);
  const remembered = await mcp.callTool({
    name: "job_result",
    arguments: { jobId },
  });
  const rememberedParsed = JobResultOutputSchema.parse(
    remembered.structuredContent,
  );
  expect(rememberedParsed.artifactStatus).toBe("applied");
  const refCheck = await runGit(["rev-parse", "--verify", branchRef], {
    cwd: src.repoPath,
    timeoutMs: 30_000,
  });
  expect(ok(refCheck)).toBe(false);
}, 120_000);

test("a legacy pre-0.1 workspace cache dir surfaces its warning through onDiagnostic", async () => {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await tempDir("homefleet-daemon-legacy-"),
  });
  // A pre-0.1 cache layout leftover: a full-64-hex-named repo dir under the
  // default cache root (<dataDir>/workspaces). The WorkspaceStore logs an
  // operator-facing warning about it at init; the assembly must route that
  // warning to the onDiagnostic sink — docs/reference/configuration.md
  // promises the daemon logs it at startup, so it cannot be dropped.
  const legacyDir = path.join(dataDir, "workspaces", "a".repeat(64));
  await mkdir(legacyDir, { recursive: true });

  const diagnostics: string[] = [];
  const daemon = new Daemon({
    dataDir,
    config: testConfig("legacy"),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());

  const legacyWarnings = diagnostics.filter((m) =>
    m.includes("legacy workspace cache layout"),
  );
  expect(legacyWarnings).toHaveLength(1);
  expect(legacyWarnings[0]).toContain(legacyDir);
  expect(legacyWarnings[0]).toContain("safe to delete");
}, 30_000);

test("partial start failure unwinds: MCP port in use rejects start() and releases the HFP port", async () => {
  // Occupy a loopback port with a dummy server: the daemon's MCP bind fails.
  const blocker: Server = createHttpServer(() => {});
  const blockedPort = await new Promise<number>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, HOST, () => {
      const address = blocker.address();
      if (address === null || typeof address === "string") {
        reject(new Error("non-TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  cleanups.push(() => new Promise((resolve) => blocker.close(() => resolve())));

  // A known HFP port (reserved then released) so we can probe it afterwards —
  // with `hfp.port: 0` the failed daemon's bound port would be unknowable.
  const hfpPort = await reserveLoopbackPort();

  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR: await tempDir("homefleet-daemon-unwind-"),
  });
  const daemon = new Daemon({
    dataDir,
    config: testConfig("unwind", {
      hfp: { host: HOST, port: hfpPort },
      mcp: { host: HOST, port: blockedPort },
    }),
  });

  await expect(daemon.start()).rejects.toThrow();

  // The unwind stopped the already-started HFP server: nothing accepts on its
  // port anymore, and getters report the not-started state.
  expect(await portAccepts(hfpPort)).toBe(false);
  expect(() => daemon.hfpPort).toThrow(/not started/i);

  // stop() after a failed start is a safe no-op.
  await daemon.stop();
}, 30_000);
