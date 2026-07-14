/**
 * Write-delegation end-to-end (v0.2 Task 12): two REAL assembled `Daemon`
 * instances on 127.0.0.1, driven through the delegator's MCP HTTP front with
 * the real SDK client, against a scripted MockOpenAiEndpoint on the worker.
 * Complements daemon.integration.test.ts's write E2E (which owns the
 * sabotage/retry/no-re-download apply lifecycle): this file owns the
 * plan-specified delivery assertions — author identity, diffStat fidelity,
 * checked-out branch content, untouched source working tree — plus the
 * hostile/edge set: cancel mid-write, report-only verify failure, artifact
 * eviction, a scripted `.git` write attempt, and a restart after a mid-write
 * shutdown (jobs-dir purge + homefleet-ref sweep through the ASSEMBLED
 * daemon, not just the store).
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MockOpenAiEndpoint, type MockScriptEntry } from "@homefleet/executors";
import { JobResultSchema, jobId12, writeBranchName } from "@homefleet/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import type { z } from "zod";
import { DaemonConfigSchema } from "../config/config.js";
import { resolveDataDir } from "../config/paths.js";
import { Daemon } from "../daemon.js";
import { JobResultOutputSchema } from "../mcp/tools.js";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { HfpRequestError } from "../transport/client.js";
import { ok, resolveHeadCommit, runGit } from "./git.js";
import { pathExists } from "./workspace-init.js";
import { repoKey } from "./workspace-store.js";

const HOST = "127.0.0.1";
const REPO_ID = "repo-x";
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

/**
 * Starts an assembled daemon on ephemeral loopback ports. Returns the data
 * dir too — the hostile-set assertions look at the worker's on-disk
 * workspace cache (`<dataDir>/workspaces/...`). `dataDirOverride` lets the
 * restart test bring a SECOND daemon up over the SAME data dir.
 */
async function startDaemon(
  name: string,
  overrides: Record<string, unknown> = {},
  dataDirOverride?: string,
): Promise<{ daemon: Daemon; dataDir: string }> {
  const dataDir = resolveDataDir({
    HOMEFLEET_DATA_DIR:
      dataDirOverride ?? (await tempDir(`homefleet-wd-${name}-`)),
  });
  const daemon = new Daemon({ dataDir, config: testConfig(name, overrides) });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return { daemon, dataDir };
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
  const client = new Client({ name: "wd-test", version: "0.0.0" });
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

interface SrcRepo {
  repoPath: string;
  head: string;
  git: (args: string[]) => Promise<string>;
}

/** A tiny source repo with one committed file (`data.txt`). */
async function makeSrcRepo(contents: string): Promise<SrcRepo> {
  const repoPath = await tempDir("homefleet-wd-src-");
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

/** The worker-side write executor config against a scripted mock endpoint. */
async function startMockEndpoint(
  script: MockScriptEntry[],
): Promise<MockOpenAiEndpoint> {
  const mock = await MockOpenAiEndpoint.start(script);
  cleanups.push(() => mock.close());
  return mock;
}

function writeExecutorConfig(mock: MockOpenAiEndpoint) {
  return {
    endpoint: {
      baseUrl: mock.baseUrl,
      model: "test-model",
      contextWindow: 32_768,
    },
    commandAllowlist: { node: { executable: process.execPath } },
  };
}

function delegatorOverrides(worker: Daemon, src: SrcRepo) {
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

/** Delegates a write task through the MCP front; returns the jobId. */
async function delegateWrite(
  mcp: Client,
  workerDeviceId: string,
  task: Record<string, unknown>,
): Promise<string> {
  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: workerDeviceId,
      task: { type: "write", workspace: { repoId: REPO_ID }, ...task },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  return jobId;
}

/** Polls `job_result` until terminal; returns the parsed final output. */
async function pollResult(
  mcp: Client,
  jobId: string,
  timeoutMs = 60_000,
): Promise<z.infer<typeof JobResultOutputSchema>> {
  let structured: unknown;
  await waitUntil(
    async () => {
      const r = await mcp.callTool({
        name: "job_result",
        arguments: { jobId },
      });
      structured = r.structuredContent;
      return JobResultOutputSchema.parse(r.structuredContent).result !== null;
    },
    timeoutMs,
    `job ${jobId} terminal`,
  );
  return JobResultOutputSchema.parse(structured);
}

/** Polls `job_status` (NOT job_result — no artifact apply) until `status`. */
async function pollStatus(
  mcp: Client,
  jobId: string,
  status: string,
  timeoutMs = 60_000,
): Promise<void> {
  await waitUntil(
    async () => {
      const r = await mcp.callTool({
        name: "job_status",
        arguments: { jobId },
      });
      const s = (r.structuredContent ?? {}) as { status?: string };
      return s.status === status;
    },
    timeoutMs,
    `job ${jobId} reaches ${status}`,
  );
}

/** `<dataDir>/workspaces/<repoKey>` — the worker's cache root for REPO_ID. */
function workerRepoRoot(workerDataDir: string): string {
  return path.join(workerDataDir, "workspaces", repoKey(REPO_ID));
}

/** Names under a dir, `[]` when the dir does not exist. */
async function dirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

test("write delegation E2E: branch at headCommit with the scripted edits, matching diffStat, worker author identity, untouched source tree; failing verify is report-only", async () => {
  const src = await makeSrcRepo("original contents\n");
  const refsBefore = await src.git(["for-each-ref", "--format=%(refname)"]);

  const script: MockScriptEntry[] = [
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: {
            path: "src/added.txt",
            content: "alpha\nbeta\ngamma\n",
          },
        },
        {
          name: "edit_file",
          arguments: {
            path: "data.txt",
            oldText: "original contents\n",
            newText: "modified contents\n",
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
            summary: "added src/added.txt, edited data.txt",
            commitMessage: "feat: scripted edit",
          },
        },
      ],
    },
  ];
  const mock = await startMockEndpoint(script);

  const { daemon: worker } = await startDaemon("worker", {
    executors: { write: writeExecutorConfig(mock) },
    workspace: { allowedRepoIds: [REPO_ID] },
  });
  const { daemon: delegator } = await startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await pair(delegator, worker);
  const mcp = await connectMcp(delegator);

  const jobId = await delegateWrite(mcp, worker.deviceId, {
    instructions: "Add src/added.txt and edit data.txt.",
    pathHints: ["src/added.txt", "data.txt"],
    // A verify command that FAILS: the job must still succeed (report-only).
    verifyCommand: {
      name: "node",
      args: ["-e", "console.error('verify-failed-marker'); process.exit(3)"],
    },
  });
  const final = await pollResult(mcp, jobId);

  // The job succeeded DESPITE the failing verify; the failure is a report.
  expect(final.status).toBe("succeeded");
  const jobResult = JobResultSchema.parse(final.result);
  expect(jobResult.status).toBe("succeeded");
  expect(jobResult.verify).toMatchObject({ name: "node", exitCode: 3 });
  expect(jobResult.verify?.outputTail).toContain("verify-failed-marker");

  const artifact = jobResult.artifact;
  if (artifact === null || artifact === undefined) {
    throw new Error("expected a write artifact");
  }
  const branchName = writeBranchName(jobId);
  const branchRef = `refs/heads/${branchName}`;
  expect(artifact.branchName).toBe(branchName);
  expect(artifact.baseCommit).toBe(src.head);
  expect(artifact.commitMessage).toBe("feat: scripted edit");

  // The lazy apply ran on the terminal job_result call.
  expect(final.artifactStatus).toBe("applied");
  expect(final.reviewCommand).toBe(
    `git diff ${artifact.baseCommit}...${branchName}`,
  );

  // Source working tree untouched: clean status, HEAD where it was, the
  // original file content still on disk, and the ONLY new ref is the
  // reserved homefleet branch.
  expect(await src.git(["status", "--porcelain"])).toBe("");
  expect(await src.git(["rev-parse", "HEAD"])).toBe(src.head);
  expect(await readFile(path.join(src.repoPath, "data.txt"), "utf8")).toBe(
    "original contents\n",
  );
  const refsAfter = await src.git(["for-each-ref", "--format=%(refname)"]);
  expect(refsAfter.split("\n").sort()).toEqual(
    [...refsBefore.split("\n"), branchRef].sort(),
  );

  // The branch exists at exactly the artifact's headCommit, authored by the
  // worker identity (name + short-device-id .invalid email), under the
  // scripted commit message.
  expect(await src.git(["rev-parse", branchRef])).toBe(artifact.headCommit);
  expect(await src.git(["log", "-1", "--format=%an|%ae|%s", branchRef])).toBe(
    `HomeFleet Worker|worker@${worker.deviceId.slice(0, 8)}.invalid|feat: scripted edit`,
  );

  // diffStat matches git's own account of base..head in the SOURCE repo.
  const numstat = await src.git([
    "diff",
    "--numstat",
    `${artifact.baseCommit}..${artifact.headCommit}`,
  ]);
  const rows = numstat
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
  const measured = {
    filesChanged: rows.length,
    insertions: rows.reduce((sum, [ins]) => sum + Number(ins), 0),
    deletions: rows.reduce((sum, [, del]) => sum + Number(del), 0),
  };
  expect(artifact.diffStat).toEqual(measured);
  expect(artifact.diffStat).toEqual({
    filesChanged: 2,
    insertions: 4,
    deletions: 1,
  });

  // Checked-out content of the branch carries the scripted edits verbatim.
  const checkoutDir = path.join(await tempDir("homefleet-wd-co-"), "co");
  await src.git([
    "worktree",
    "add",
    "--detach",
    checkoutDir,
    artifact.headCommit,
  ]);
  try {
    expect(
      await readFile(path.join(checkoutDir, "src", "added.txt"), "utf8"),
    ).toBe("alpha\nbeta\ngamma\n");
    expect(await readFile(path.join(checkoutDir, "data.txt"), "utf8")).toBe(
      "modified contents\n",
    );
  } finally {
    await src.git(["worktree", "remove", "--force", checkoutDir]);
  }
}, 120_000);

test("cancel mid-write: canceled result with no artifact, and the worker's jobs dir is left with no worktree or bundle", async () => {
  const src = await makeSrcRepo("original contents\n");
  // The model's very first response is held back longer than the test would
  // ever wait — the job can only end via cancellation.
  const mock = await startMockEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: "never.txt", content: "never lands\n" },
        },
      ],
      delayMs: 120_000,
    },
  ]);

  const { daemon: worker, dataDir: workerDataDir } = await startDaemon(
    "worker",
    {
      executors: { write: writeExecutorConfig(mock) },
      workspace: { allowedRepoIds: [REPO_ID] },
    },
  );
  const { daemon: delegator } = await startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await pair(delegator, worker);
  const mcp = await connectMcp(delegator);

  const jobId = await delegateWrite(mcp, worker.deviceId, {
    instructions: "Stalls forever; will be canceled.",
  });

  // The job is running and its dedicated write worktree is on disk.
  const jobsRoot = path.join(workerRepoRoot(workerDataDir), "jobs");
  await pollStatus(mcp, jobId, "running");
  await waitUntil(
    async () => (await dirNames(jobsRoot)).includes(jobId12(jobId)),
    15_000,
    "write worktree materialized",
  );

  const canceled = await mcp.callTool({
    name: "cancel_job",
    arguments: { jobId },
  });
  expect(canceled.isError).toBeFalsy();

  const final = await pollResult(mcp, jobId);
  expect(final.status).toBe("canceled");
  const jobResult = JobResultSchema.parse(final.result);
  expect(jobResult.status).toBe("canceled");
  expect(jobResult.error?.code).toBe("CANCELED");
  expect(jobResult.artifact).toBeUndefined();
  // Nothing to fetch or apply from a canceled job.
  expect(final.artifactStatus).toBe("none");
  expect(final.reviewCommand).toBeUndefined();

  // The release path reclaimed the worktree, and no bundle was ever minted:
  // nothing is left under <repoRoot>/jobs.
  await waitUntil(
    async () => (await dirNames(jobsRoot)).length === 0,
    15_000,
    "jobs dir empty after release",
  );
}, 90_000);

test("record eviction (maxRetainedJobs: 1): a second job reaps the first's artifact bundle, and both job_result and the artifact route answer UNKNOWN_JOB", async () => {
  const src = await makeSrcRepo("original contents\n");
  const mock = await startMockEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: "evictee.txt", content: "soon evicted\n" },
        },
      ],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: { summary: "wrote evictee.txt" },
        },
      ],
    },
  ]);

  const { daemon: worker, dataDir: workerDataDir } = await startDaemon(
    "worker",
    {
      executors: {
        write: writeExecutorConfig(mock),
        command: { allowlist: { node: { executable: process.execPath } } },
      },
      workspace: { allowedRepoIds: [REPO_ID] },
      jobs: { maxRetainedJobs: 1 },
    },
  );
  const { daemon: delegator } = await startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await pair(delegator, worker);
  const mcp = await connectMcp(delegator);

  // Job 1 (write) runs to success, but its artifact is NEVER applied — the
  // test polls job_status only, so the bundle just sits registered on the
  // worker, waiting for a job_result that will come too late.
  const jobId = await delegateWrite(mcp, worker.deviceId, {
    instructions: "Write evictee.txt.",
  });
  await pollStatus(mcp, jobId, "succeeded");
  const bundlePath = path.join(
    workerRepoRoot(workerDataDir),
    "jobs",
    `${jobId12(jobId)}.bundle`,
  );
  expect(await pathExists(bundlePath)).toBe(true);

  // Job 2 terminating pushes retained records past the cap of 1, evicting
  // job 1's record — and its bundle with it.
  const second = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "command",
        workspace: { repoId: REPO_ID },
        command: "node",
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(second.isError).toBeFalsy();
  const { jobId: secondJobId } = (second.structuredContent ?? {}) as {
    jobId: string;
  };
  await pollStatus(mcp, secondJobId, "succeeded");
  await waitUntil(
    async () => !(await pathExists(bundlePath)),
    15_000,
    "evicted bundle deleted",
  );

  // Eviction is indistinguishable from "never existed" (RFC): job_result
  // surfaces the worker's UNKNOWN_JOB, and the artifact download route
  // itself answers 404 UNKNOWN_JOB — no 2xx, no leak that the job was real.
  const evicted = await mcp.callTool({
    name: "job_result",
    arguments: { jobId },
  });
  expect(evicted.isError).toBe(true);
  expect(JSON.stringify(evicted.content)).toContain("UNKNOWN_JOB");

  const destPath = path.join(
    await tempDir("homefleet-wd-dl-"),
    "post-eviction.bundle",
  );
  const download = delegator.hfpClient.fetchJobArtifact(
    { host: HOST, port: worker.hfpPort, expectedDeviceId: worker.deviceId },
    jobId,
    destPath,
    { maxBytes: 1024 * 1024 },
  );
  await expect(download).rejects.toMatchObject({
    name: "HfpRequestError",
    status: 404,
    hfpError: expect.objectContaining({ code: "UNKNOWN_JOB" }),
  });
  await expect(download).rejects.toBeInstanceOf(HfpRequestError);
}, 120_000);

test("a scripted .git write attempt is refused as a tool error: the job still completes and the hook file is absent from the artifact branch", async () => {
  const src = await makeSrcRepo("original contents\n");
  const mock = await startMockEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: {
            path: ".git/hooks/pre-commit",
            content: "#!/bin/sh\nexit 1\n",
          },
        },
      ],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: "safe.txt", content: "legit change\n" },
        },
      ],
    },
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "finish_task",
          arguments: {
            summary: "wrote safe.txt",
            commitMessage: "add safe.txt",
          },
        },
      ],
    },
  ]);

  const { daemon: worker } = await startDaemon("worker", {
    executors: { write: writeExecutorConfig(mock) },
    workspace: { allowedRepoIds: [REPO_ID] },
  });
  const { daemon: delegator } = await startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await pair(delegator, worker);
  const mcp = await connectMcp(delegator);

  const jobId = await delegateWrite(mcp, worker.deviceId, {
    instructions: "Plant a hook, then write safe.txt.",
  });
  const final = await pollResult(mcp, jobId);

  // The refusal went back to the model as an error tool-result and the loop
  // CONTINUED — three requests reached the endpoint — ending in success.
  expect(mock.requests.length).toBe(3);
  expect(final.status).toBe("succeeded");
  const jobResult = JobResultSchema.parse(final.result);
  const artifact = jobResult.artifact;
  if (artifact === null || artifact === undefined) {
    throw new Error("expected a write artifact");
  }
  expect(final.artifactStatus).toBe("applied");

  // The artifact carries exactly the one legitimate file; nothing under
  // .git was written, committed, or delivered.
  expect(artifact.diffStat).toEqual({
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  const branchRef = `refs/heads/${writeBranchName(jobId)}`;
  expect(await src.git(["show", `${branchRef}:safe.txt`])).toBe("legit change");
  const treePaths = await src.git(["ls-tree", "-r", "--name-only", branchRef]);
  expect(treePaths.split("\n").sort()).toEqual(["data.txt", "safe.txt"]);
  // And the SOURCE repo's hooks dir never grew a pre-commit.
  expect(
    await pathExists(path.join(src.repoPath, ".git", "hooks", "pre-commit")),
  ).toBe(false);
}, 120_000);

test("restart after a mid-write shutdown: the assembled daemon's init purges the jobs dir and sweeps leaked homefleet refs", async () => {
  const src = await makeSrcRepo("original contents\n");
  const mock = await startMockEndpoint([
    {
      kind: "tool_calls",
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: "half.txt", content: "half done\n" },
        },
      ],
      delayMs: 120_000,
    },
  ]);

  const workerOverrides = {
    executors: { write: writeExecutorConfig(mock) },
    workspace: { allowedRepoIds: [REPO_ID] },
  };
  const { daemon: worker, dataDir: workerDataDir } = await startDaemon(
    "worker",
    workerOverrides,
  );
  const { daemon: delegator } = await startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await pair(delegator, worker);
  const mcp = await connectMcp(delegator);

  const workerDeviceId = worker.deviceId;
  const jobId = await delegateWrite(mcp, workerDeviceId, {
    instructions: "Stalls; the daemon stops mid-write.",
  });
  const repoRoot = workerRepoRoot(workerDataDir);
  const jobsRoot = path.join(repoRoot, "jobs");
  const bareRepo = path.join(repoRoot, "repo.git");
  await pollStatus(mcp, jobId, "running");
  await waitUntil(
    async () => (await dirNames(jobsRoot)).includes(jobId12(jobId)),
    15_000,
    "write worktree materialized",
  );

  // Stop the worker daemon while the write job is mid-flight.
  await worker.stop();

  // Simulate the crash residue a hard kill can leave (a graceful stop may
  // already have released the live worktree, so plant deterministic
  // leftovers): a half-built worktree dir under jobs/, and a leaked
  // homefleet branch ref in the bare cache (a crash between finalize's
  // updateRef and its deleteRef).
  const staleDir = path.join(jobsRoot, "deadbeefdead");
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, "leftover.txt"), "stale\n");
  const planted = await runGit(
    ["update-ref", "refs/heads/homefleet/deadbeefdead", src.head],
    { cwd: bareRepo, timeoutMs: 30_000 },
  );
  expect(ok(planted)).toBe(true);
  expect((await dirNames(jobsRoot)).length).toBeGreaterThan(0);

  // Restart: a FRESH Daemon over the SAME data dir. start() awaits the
  // workspace store's init, so once it returns, the purge + sweep have run
  // through the assembled daemon.
  const { daemon: restarted } = await startDaemon(
    "worker",
    workerOverrides,
    workerDataDir,
  );
  expect(restarted.deviceId).toBe(workerDeviceId); // same identity, same disk

  expect(await pathExists(jobsRoot)).toBe(false);
  const refs = await runGit(
    ["for-each-ref", "--format=%(refname)", "refs/heads/homefleet/"],
    { cwd: bareRepo, timeoutMs: 30_000 },
  );
  expect(ok(refs)).toBe(true);
  expect(refs.stdout.trim()).toBe("");
}, 120_000);
