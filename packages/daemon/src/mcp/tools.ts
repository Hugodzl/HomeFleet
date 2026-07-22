/**
 * The HomeFleet MCP tools — the local agent's API surface. Five tools, each
 * with a zod input AND output schema, returning results as `structuredContent`
 * plus a short human-readable text block (per SDK norms).
 *
 * Where a tool's output IS a protocol type (JobStatus, JobResult) the protocol
 * schema is reused verbatim so the local API cannot drift from the wire
 * contract. The tool INPUT schemas are new and local to the daemon: they are
 * the agent-facing API, not the HFP wire protocol. `delegate_task` presents a
 * slightly friendlier input (budgets flattened, workspace is repoId-only) and
 * translates it to a `JobParams`, re-validated with `JobParamsSchema` before
 * it ever leaves.
 *
 * `delegate_task` ALWAYS syncs the named repo to the worker before delegating
 * (M9 Unit 6): the agent supplies only a `repoId`, this daemon resolves it to
 * its OWN local repo path (`config.repos`), syncs that repo's current HEAD to
 * the worker, and uses the SYNCED commit as the job's `WorkspaceRef` — the
 * agent never supplies (and cannot lie about) a headCommit.
 *
 * Errors follow the MCP tool-error convention: a handler NEVER throws into the
 * transport. A bad request (unknown/unpaired node, unmapped repo, unknown job)
 * and a remote failure (BUSY, timeout, sync failure, ...) are both returned as
 * `{ isError: true }` with a clear message, phrased so the agent can tell
 * "my local repo is broken" from "the worker rejected it" from "the node is
 * unreachable". Raw stacks are never surfaced.
 */
import {
  type CancelResponse,
  type DelegateResponse,
  DeviceIdSchema,
  ExecutorKindSchema,
  JobIdSchema,
  type JobParams,
  JobParamsSchema,
  type JobResult,
  JobResultSchema,
  type JobSnapshot,
  JobStatusSchema,
  ModelInfoSchema,
  NodeRoleSchema,
  RepoIdSchema,
  type WriteArtifact,
} from "@homefleet/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  FingerprintMismatchError,
  HfpRequestError,
  type HfpTarget,
  HfpTimeoutError,
  MissingServerCertificateError,
} from "../transport/client.js";
import { ApplyError } from "../workspace/artifact-apply.js";
import { GitError } from "../workspace/git.js";
import type { ApplyDelegatedArtifactFn } from "./artifact-applier.js";
import type {
  DelegationRegistry,
  DelegationRoute,
} from "./delegation-registry.js";
import type { NodeDirectory } from "./node-directory.js";

/** The delegating-side HFP surface the tools call (HfpClient satisfies it). */
export interface DelegationClient {
  delegate(target: HfpTarget, params: JobParams): Promise<DelegateResponse>;
  jobSnapshot(target: HfpTarget, jobId: string): Promise<JobSnapshot>;
  cancelJob(target: HfpTarget, jobId: string): Promise<CancelResponse>;
}

/**
 * The delegating-side workspace-sync surface `delegate_task` calls before
 * dispatching (HfpClient.syncWorkspace satisfies it structurally). Kept
 * separate from {@link DelegationClient}: sync is a workspace concern, not a
 * job-lifecycle one, and a test fake for one need not fake the other.
 */
export interface WorkspaceSyncClient {
  syncWorkspace(
    target: HfpTarget,
    repo: { repoPath: string; repoId: string },
  ): Promise<{ headCommit: string }>;
}

/**
 * Resolves a repoId to this daemon's OWN local repo path (`config.repos`).
 * `undefined` means this daemon has no repo mapped to that repoId — the repo
 * cannot be synced from here, so `delegate_task` fails closed.
 */
export interface RepoResolver {
  resolveRepoPath(repoId: string): string | undefined;
}

/** Collaborators shared by every tool (injected; nothing global). */
export interface McpToolCollaborators {
  hfpClient: DelegationClient;
  workspaceSync: WorkspaceSyncClient;
  repoResolver: RepoResolver;
  nodeDirectory: Pick<NodeDirectory, "list" | "resolve">;
  delegations: DelegationRegistry;
  /**
   * The write-artifact fetch-and-apply plumbing `job_result` drives lazily
   * on a succeeded write job (production: `createArtifactApplier` over the
   * HfpClient + `config.workspace.maxBundleBytes`). Required, mirroring
   * `registerJobRoutes`' artifact-store posture: an assembly must decide,
   * never silently forget.
   */
  applyArtifact: ApplyDelegatedArtifactFn;
  /**
   * Per-request HFP timeout applied to delegate/status/result/cancel calls.
   * Omitted → the HfpClient default. (The directory's `hello` uses its own,
   * shorter, timeout.)
   */
  requestTimeoutMs?: number;
}

// --- Output schemas (exported for tests; protocol types reused verbatim) ---

/** One node as `list_nodes` surfaces it: identity + reachability + live caps. */
export const NodeSummarySchema = z.object({
  deviceId: DeviceIdSchema,
  name: z.string(),
  reachable: z.boolean(),
  roles: z.array(NodeRoleSchema).optional(),
  executors: z.array(ExecutorKindSchema).optional(),
  models: z.array(ModelInfoSchema).optional(),
  activeJobs: z.int().min(0).optional(),
  maxConcurrentJobs: z.int().min(1).optional(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

export const ListNodesOutputSchema = z.object({
  nodes: z.array(NodeSummarySchema),
});

export const DelegateTaskOutputSchema = z.object({
  jobId: JobIdSchema,
  node: DeviceIdSchema,
});

/** job_status / cancel_job: reuse the protocol JobStatus enum. */
export const JobStatusOutputSchema = z.object({
  jobId: JobIdSchema,
  status: JobStatusSchema,
});

/**
 * Whether a terminal write job's artifact has been applied into this
 * daemon's local repo: `applied` (branch created/verified — review it),
 * `failed` (fetch or apply refused; `applyError` says why and the next
 * `job_result` call retries), or `none` (the job produced no artifact —
 * clean tree, or a failed/canceled job).
 */
export const ArtifactStatusSchema = z.enum(["applied", "failed", "none"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

/**
 * job_result: the terminal JobResult (protocol schema) or null when
 * unfinished. Write jobs additionally surface the lazy-apply outcome —
 * `artifactStatus` (always, once terminal), `reviewCommand` (only when
 * applied), and `applyError` (only when the apply failed). The artifact and
 * verify report themselves ride inside `result` (protocol fields).
 */
export const JobResultOutputSchema = z.object({
  jobId: JobIdSchema,
  status: JobStatusSchema,
  result: JobResultSchema.nullable(),
  artifactStatus: ArtifactStatusSchema.optional(),
  /** `git diff <base>...<branch>` — how to review the applied change. */
  reviewCommand: z.string().optional(),
  applyError: z.string().optional(),
});

// --- Input schemas (new, local to the daemon: the agent-facing API) ---

const ListNodesInputShape = {
  /** When true, omit paired nodes that did not answer `hello`. */
  reachableOnly: z.boolean().optional(),
} as const;

/**
 * The agent supplies ONLY a repoId, never a commit: the daemon derives the
 * headCommit by syncing its own mapped local repo's current HEAD.
 */
const TaskWorkspaceInputSchema = z.object({ repoId: RepoIdSchema });

const ReconTaskInputSchema = z.object({
  type: z.literal("recon"),
  workspace: TaskWorkspaceInputSchema,
  prompt: z.string().min(1).max(16384),
  model: z.string().optional(),
  /** Flattened budgets (default applied by the protocol schema when omitted). */
  maxToolCalls: z.int().min(1).max(200).optional(),
  maxWallMs: z.int().min(1000).max(3_600_000).optional(),
});

const CommandTaskInputSchema = z.object({
  type: z.literal("command"),
  workspace: TaskWorkspaceInputSchema,
  command: z.string(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.int().min(1000).max(3_600_000).optional(),
});

/**
 * Code-writing delegation. `pathHints` and `verifyCommand` pass through to the
 * protocol fields UNTOUCHED — the worker's write executor incorporates
 * pathHints into the model prompt; this layer never rewrites task content.
 */
const WriteTaskInputSchema = z.object({
  type: z.literal("write"),
  workspace: TaskWorkspaceInputSchema,
  /** Optional catalog model id to target on the worker; its default if absent. */
  model: z.string().optional(),
  instructions: z.string().min(1).max(16384),
  pathHints: z.array(z.string().min(1).max(1024)).max(32).optional(),
  verifyCommand: z
    .object({ name: z.string().min(1), args: z.array(z.string()).optional() })
    .optional(),
  maxToolCalls: z.int().min(1).max(200).optional(),
  maxWallMs: z.int().min(1000).max(3_600_000).optional(),
});

const TaskInputSchema = z.discriminatedUnion("type", [
  ReconTaskInputSchema,
  CommandTaskInputSchema,
  WriteTaskInputSchema,
]);
type TaskInput = z.infer<typeof TaskInputSchema>;

const DelegateTaskInputShape = {
  /** The target worker's paired device ID (from `list_nodes`). */
  node: DeviceIdSchema,
  task: TaskInputSchema,
} as const;

const JobIdInputShape = { jobId: JobIdSchema } as const;

// --- Result builders (SDK CallToolResult) ---

function ok(
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// --- Translation & error mapping ---

/**
 * Friendly task input + the SYNCED headCommit → validated protocol JobParams
 * (the wire contract). `headCommit` comes from `workspaceSync.syncWorkspace`,
 * never from the agent — see the file doc.
 */
function toJobParams(task: TaskInput, headCommit: string): JobParams {
  const workspace = { repoId: task.workspace.repoId, headCommit };
  if (task.type === "recon") {
    const budgets: Record<string, number> = {};
    if (task.maxToolCalls !== undefined)
      budgets.maxToolCalls = task.maxToolCalls;
    if (task.maxWallMs !== undefined) budgets.maxWallMs = task.maxWallMs;
    return JobParamsSchema.parse({
      type: "recon",
      workspace,
      prompt: task.prompt,
      ...(task.model !== undefined ? { model: task.model } : {}),
      budgets,
    });
  }
  if (task.type === "write") {
    const budgets: Record<string, number> = {};
    if (task.maxToolCalls !== undefined)
      budgets.maxToolCalls = task.maxToolCalls;
    if (task.maxWallMs !== undefined) budgets.maxWallMs = task.maxWallMs;
    return JobParamsSchema.parse({
      type: "write",
      workspace,
      ...(task.model !== undefined ? { model: task.model } : {}),
      instructions: task.instructions,
      // Pass-through, untouched: this layer never rewrites task content.
      ...(task.pathHints !== undefined ? { pathHints: task.pathHints } : {}),
      ...(task.verifyCommand !== undefined
        ? { verifyCommand: task.verifyCommand }
        : {}),
      budgets,
    });
  }
  return JobParamsSchema.parse({
    type: "command",
    workspace,
    command: task.command,
    ...(task.args !== undefined ? { args: task.args } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
  });
}

/** A clean, non-leaking message for an HFP failure (never a stack). */
function describeHfpFailure(error: unknown): string {
  if (error instanceof HfpRequestError) {
    const code = error.hfpError?.code;
    const detail = error.hfpError?.message ?? "";
    switch (code) {
      case "BUSY":
        return `The worker is at capacity and rejected the job (BUSY)${suffix(detail)}`;
      case "UNSUPPORTED_JOB_TYPE":
        return `The worker has no executor for this job type (UNSUPPORTED_JOB_TYPE)${suffix(detail)}`;
      case "WORKSPACE_UNAVAILABLE":
        return `The worker could not make the requested workspace available (WORKSPACE_UNAVAILABLE)${suffix(detail)}`;
      case "UNAUTHORIZED":
        return `The worker rejected this node as not paired (UNAUTHORIZED)${suffix(detail)}`;
      case "INVALID_REQUEST":
        return `The worker rejected the request as invalid (INVALID_REQUEST)${suffix(detail)}`;
      case "UNKNOWN_JOB":
        return `The worker does not recognize that job (UNKNOWN_JOB)${suffix(detail)}`;
      default:
        return `The worker returned an error (${code ?? `HTTP ${error.status}`})${suffix(detail)}`;
    }
  }
  if (error instanceof HfpTimeoutError) {
    return `The worker did not respond within ${error.timeoutMs}ms; it may be offline or unreachable.`;
  }
  if (error instanceof FingerprintMismatchError) {
    return "The node's TLS certificate did not match its paired identity (possible impersonation); the connection was refused.";
  }
  if (error instanceof MissingServerCertificateError) {
    return "The node presented no TLS certificate, so its identity could not be verified; the connection was refused.";
  }
  return `Could not complete the request against the worker: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

function suffix(detail: string): string {
  return detail === "" ? "." : `: ${detail}`;
}

/**
 * A clean, non-leaking message for a failed `syncWorkspace` call, phrased so
 * the agent can tell WHO failed. Only the enumerated worker/network error
 * types are blamed on the worker (via {@link describeHfpFailure}); a local
 * {@link GitError} names the local repo; and EVERYTHING else is treated as a
 * local fault too — `syncWorkspace`/`uploadBundle` can reject with a RAW,
 * untyped local error (a `createReadStream` fs error on an AV-locked/EBUSY
 * bundle, or an ENOSPC/EACCES from the temp-bundle `mkdtemp`/`rm`), none of
 * which are the worker's doing, so the message must NOT claim it was. Fail
 * closed on classification: an unrecognized error is local, not remote.
 */
function describeSyncFailure(
  error: unknown,
  repoPath: string,
  repoId: string,
): string {
  if (
    error instanceof HfpRequestError ||
    error instanceof HfpTimeoutError ||
    error instanceof FingerprintMismatchError ||
    error instanceof MissingServerCertificateError
  ) {
    return describeHfpFailure(error);
  }
  if (error instanceof GitError) {
    return (
      `Could not read or bundle the local repo at "${repoPath}" for ` +
      `"${repoId}": ${error.message}`
    );
  }
  // Neither a typed worker/network error nor a GitError: a raw LOCAL fault
  // (fs error streaming the bundle, temp-dir failure). Do NOT blame the worker.
  return (
    `Could not sync the local repo at "${repoPath}" for "${repoId}": ` +
    `${error instanceof Error ? error.message : String(error)}`
  );
}

/** The reviewer's command for an applied artifact (three-dot: base to branch). */
function reviewCommandFor(applied: {
  branchName: string;
  baseCommit: string;
}): string {
  return `git diff ${applied.baseCommit}...${applied.branchName}`;
}

/**
 * A clean, non-leaking reason for a failed artifact apply. An
 * {@link ApplyError} keeps its typed code + message — the REF_MISMATCH
 * backstop's message already spells out that the reserved ref may now exist
 * at an UNVERIFIED tip and should be inspected or deleted (never auto-
 * deleted here: deleting refs in the user's repo on an error path is riskier
 * than reporting). Worker/network failures reuse {@link describeHfpFailure}.
 */
function describeApplyFailure(error: unknown): string {
  if (error instanceof ApplyError) {
    return `${error.code}: ${error.message}`;
  }
  if (
    error instanceof HfpRequestError ||
    error instanceof HfpTimeoutError ||
    error instanceof FingerprintMismatchError ||
    error instanceof MissingServerCertificateError
  ) {
    return describeHfpFailure(error);
  }
  return error instanceof Error ? error.message : String(error);
}

function unknownJob(jobId: string): CallToolResult {
  return fail(
    `Unknown job "${jobId}". It was not delegated through this MCP server ` +
      "(or its record has been evicted), so there is no node to query. " +
      "Delegate with delegate_task, then use the returned jobId.",
  );
}

/** Summarizes a directory entry for `list_nodes` output (omits absent caps). */
function toNodeSummary(entry: {
  deviceId: string;
  name: string;
  reachable: boolean;
  nodeInfo?: {
    roles: readonly string[];
    executors: readonly string[];
    models: readonly {
      id: string;
      label?: string;
      contextWindow?: number;
      status?: "ok" | "not_served" | "unreachable";
    }[];
    activeJobs: number;
    maxConcurrentJobs: number;
  };
}): NodeSummary {
  const base = {
    deviceId: entry.deviceId,
    name: entry.name,
    reachable: entry.reachable,
  };
  if (entry.nodeInfo === undefined) {
    return base;
  }
  const { roles, executors, models, activeJobs, maxConcurrentJobs } =
    entry.nodeInfo;
  return {
    ...base,
    roles: [...roles] as NodeSummary["roles"],
    executors: [...executors] as NodeSummary["executors"],
    models: models.map((m) => ({ ...m })),
    activeJobs,
    maxConcurrentJobs,
  };
}

/**
 * Registers all five HomeFleet tools on `server`. Factored out so the HTTP
 * server and the stdio shim share the exact same registration (no duplicated
 * tool logic).
 */
export function registerHomeFleetTools(
  server: McpServer,
  collaborators: McpToolCollaborators,
): void {
  const {
    hfpClient,
    workspaceSync,
    repoResolver,
    nodeDirectory,
    delegations,
    applyArtifact,
    requestTimeoutMs,
  } = collaborators;

  const targetFor = (route: DelegationRoute): HfpTarget => ({
    host: route.host,
    port: route.port,
    expectedDeviceId: route.deviceId,
    ...(requestTimeoutMs !== undefined ? { timeoutMs: requestTimeoutMs } : {}),
  });

  /**
   * The lazy apply `job_result` drives on a terminal WRITE result: fetch
   * the job's bundle from the worker and land it as a local
   * `refs/heads/homefleet/<jobId12>` branch. Idempotent bookkeeping — a
   * remembered apply (delegation registry) answers WITHOUT re-downloading;
   * a FAILED apply is reported (never a tool error — the job result itself
   * is valid) and simply retried on the next call.
   *
   * CONCURRENCY: MCP clients may legally parallelize calls, and two
   * overlapping `job_result`s racing git's ref lock could otherwise report
   * contradictory surfaces (one "failed", its sibling "applied"). The whole
   * computation therefore runs single-flight per jobId — overlapping
   * callers share ONE fetch+apply and report the same outcome. The gate
   * lives on the delegation registry, the cross-request state (the MCP
   * HTTP front builds a fresh server per request).
   */
  const writeArtifactSurface = (
    jobId: string,
    route: DelegationRoute,
    result: JobResult,
  ): Promise<{
    artifactStatus: ArtifactStatus;
    reviewCommand?: string;
    applyError?: string;
  }> =>
    delegations.singleFlightApply(jobId, async () => {
      const remembered = delegations.appliedArtifact(jobId);
      if (remembered !== undefined) {
        return {
          artifactStatus: "applied" as const,
          reviewCommand: reviewCommandFor(remembered),
        };
      }
      const artifact: WriteArtifact | null | undefined = result.artifact;
      if (
        result.status !== "succeeded" ||
        artifact === null ||
        artifact === undefined
      ) {
        // Clean tree (artifact: null) or a failed/canceled job: nothing to
        // fetch or apply — by the result schema's rules, committed work is
        // never delivered from a non-succeeded job.
        return { artifactStatus: "none" as const };
      }
      // Fail closed, like delegate_task's sync gate: the artifact only ever
      // lands in a repo THIS daemon has mapped for the job's repoId.
      const repoPath = repoResolver.resolveRepoPath(route.repoId);
      if (repoPath === undefined) {
        return {
          artifactStatus: "failed" as const,
          applyError:
            `this daemon has no local repo mapped to "${route.repoId}"; ` +
            "restore the entry in this daemon's config repos list, then call " +
            "job_result again to retry the apply",
        };
      }
      try {
        const { branchName } = await applyArtifact({
          target: targetFor(route),
          jobId,
          artifact,
          repoPath,
        });
        const applied = { branchName, baseCommit: artifact.baseCommit };
        delegations.recordApplied(jobId, applied);
        return {
          artifactStatus: "applied" as const,
          reviewCommand: reviewCommandFor(applied),
        };
      } catch (error) {
        return {
          artifactStatus: "failed" as const,
          applyError: describeApplyFailure(error),
        };
      }
    });

  server.registerTool(
    "list_nodes",
    {
      title: "List HomeFleet nodes",
      description:
        "List paired HomeFleet worker nodes. For nodes that are currently " +
        "reachable, includes live capabilities (roles, executors, models, load). " +
        "Unreachable paired nodes are still listed with reachable: false. " +
        "Each model carries a startup-probe status (ok | not_served | unreachable); " +
        "prefer models reported ok.",
      inputSchema: ListNodesInputShape,
      outputSchema: ListNodesOutputSchema.shape,
    },
    async ({ reachableOnly }): Promise<CallToolResult> => {
      try {
        const entries = await nodeDirectory.list();
        const selected = reachableOnly
          ? entries.filter((e) => e.reachable)
          : entries;
        const nodes = selected.map(toNodeSummary);
        const reachableCount = nodes.filter((n) => n.reachable).length;
        return ok(
          `${nodes.length} paired node(s), ${reachableCount} reachable.`,
          { nodes },
        );
      } catch (error) {
        return fail(
          `Could not list nodes: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate a task to a node",
      description:
        "Delegate a job to a paired worker node: a read-only repo 'recon' " +
        "analysis by the worker's local model, an allowlisted 'command' " +
        "execution, or a code-'write' task that produces a reviewable " +
        "branch. The named repo (workspace.repoId) is synced from this " +
        "daemon's local mapping to the worker before the job is delegated. " +
        "Returns a jobId; poll it with job_status / job_result. For recon " +
        "and write tasks you may set task.model to a specific model id from " +
        "the target's catalog; omit it to use the node's default. An " +
        "un-offered model is rejected.",
      inputSchema: DelegateTaskInputShape,
      outputSchema: DelegateTaskOutputSchema.shape,
    },
    async ({ node, task }): Promise<CallToolResult> => {
      const resolved = nodeDirectory.resolve(node);
      if (resolved === undefined) {
        return fail(
          `Unknown or unpaired node "${node}". Only paired nodes can be ` +
            "delegated to; use list_nodes to see them.",
        );
      }
      if (resolved.host === undefined || resolved.port === undefined) {
        return fail(
          `Node "${resolved.name}" (${node}) is paired but has not been ` +
            "discovered on the network, so there is no address to reach it. " +
            "Make sure its daemon is running and discoverable, then retry.",
        );
      }

      // Fail closed: this daemon can only sync a repo it has a local mapping
      // for (config.repos). No mapping -> no attempt to sync or delegate.
      const { repoId } = task.workspace;
      const repoPath = repoResolver.resolveRepoPath(repoId);
      if (repoPath === undefined) {
        return fail(
          `This daemon has no local repo mapped to "${repoId}"; add it to ` +
            "this daemon's config repos list before delegating a task " +
            "against it.",
        );
      }

      const target: HfpTarget = {
        host: resolved.host,
        port: resolved.port,
        expectedDeviceId: node,
        ...(requestTimeoutMs !== undefined
          ? { timeoutMs: requestTimeoutMs }
          : {}),
      };

      // Sync BEFORE delegating, always (M9 Unit 6): the worker must hold the
      // repo at this commit before the job that reads it is dispatched.
      let headCommit: string;
      try {
        const synced = await workspaceSync.syncWorkspace(target, {
          repoPath,
          repoId,
        });
        headCommit = synced.headCommit;
      } catch (error) {
        return fail(describeSyncFailure(error, repoPath, repoId));
      }

      let params: JobParams;
      try {
        params = toJobParams(task, headCommit);
      } catch (error) {
        return fail(
          `The task parameters are invalid: ${
            error instanceof z.ZodError
              ? error.issues.map((i) => i.message).join("; ")
              : String(error)
          }`,
        );
      }
      try {
        const { jobId } = await hfpClient.delegate(target, params);
        // Record ONLY on success, so a failed delegation leaves no phantom
        // route and the registry stays bounded to real jobs. repoId rides
        // along for job_result's write-artifact apply (local repo lookup).
        delegations.record(jobId, {
          deviceId: node,
          host: resolved.host,
          port: resolved.port,
          repoId,
        });
        return ok(
          `Delegated ${task.type} job ${jobId} to "${resolved.name}".`,
          { jobId, node },
        );
      } catch (error) {
        return fail(describeHfpFailure(error));
      }
    },
  );

  server.registerTool(
    "job_status",
    {
      title: "Check a delegated job's status",
      description:
        "Return the current status (queued | running | succeeded | failed | " +
        "canceled) of a job previously delegated with delegate_task.",
      inputSchema: JobIdInputShape,
      outputSchema: JobStatusOutputSchema.shape,
    },
    async ({ jobId }): Promise<CallToolResult> => {
      const route = delegations.lookup(jobId);
      if (route === undefined) {
        return unknownJob(jobId);
      }
      try {
        const snapshot = await hfpClient.jobSnapshot(targetFor(route), jobId);
        return ok(`Job ${jobId} is ${snapshot.status}.`, {
          jobId,
          status: snapshot.status,
        });
      } catch (error) {
        return fail(describeHfpFailure(error));
      }
    },
  );

  server.registerTool(
    "job_result",
    {
      title: "Fetch a delegated job's result",
      description:
        "Return the full result of a delegated job when it has finished. " +
        "If the job is still queued or running, result is null. For a " +
        "succeeded write job this also fetches the artifact and applies it " +
        "into the local repo as a refs/heads/homefleet/ branch, reporting " +
        "artifactStatus and (when applied) the git diff reviewCommand. A " +
        "successful apply is remembered and never re-runs, so 'applied' can " +
        "be stale if the branch was deleted afterwards.",
      inputSchema: JobIdInputShape,
      outputSchema: JobResultOutputSchema.shape,
    },
    async ({ jobId }): Promise<CallToolResult> => {
      const route = delegations.lookup(jobId);
      if (route === undefined) {
        return unknownJob(jobId);
      }
      try {
        const snapshot = await hfpClient.jobSnapshot(targetFor(route), jobId);
        const result = snapshot.result ?? null;
        if (result === null) {
          return ok(`Job ${jobId} is ${snapshot.status}; no result yet.`, {
            jobId,
            status: snapshot.status,
            result,
          });
        }
        let text = `Job ${jobId} finished with status ${snapshot.status}.`;
        if (result.type !== "write") {
          return ok(text, { jobId, status: snapshot.status, result });
        }
        const surface = await writeArtifactSurface(jobId, route, result);
        switch (surface.artifactStatus) {
          case "applied":
            text += ` Artifact applied; review with: ${surface.reviewCommand}`;
            break;
          case "failed":
            text += ` Artifact apply FAILED (call job_result again to retry): ${surface.applyError}`;
            break;
          case "none":
            text += " No artifact to apply.";
            break;
        }
        return ok(text, { jobId, status: snapshot.status, result, ...surface });
      } catch (error) {
        return fail(describeHfpFailure(error));
      }
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a delegated job",
      description:
        "Request cancellation of a delegated job. Returns the job's status " +
        "after the cancellation request.",
      inputSchema: JobIdInputShape,
      outputSchema: JobStatusOutputSchema.shape,
    },
    async ({ jobId }): Promise<CallToolResult> => {
      const route = delegations.lookup(jobId);
      if (route === undefined) {
        return unknownJob(jobId);
      }
      try {
        const response = await hfpClient.cancelJob(targetFor(route), jobId);
        return ok(
          `Cancellation requested for job ${jobId}; status is now ${response.status}.`,
          { jobId, status: response.status },
        );
      } catch (error) {
        return fail(describeHfpFailure(error));
      }
    },
  );
}
