/**
 * Shared fixtures for the protocol test suite. Not exported from the package.
 */
import type { JobResult, WorkspaceRef } from "./job.js";
import type { NodeInfo } from "./node.js";

/** 64-char lowercase hex — a syntactically valid device ID. */
export const validDeviceId = "0123456789abcdef".repeat(4);

/** A syntactically valid job ID (UUID v4). */
export const validJobId = "0b294587-2342-4718-b6bb-2b3c837e2a9c";

/** 40-char lowercase hex — a syntactically valid commit hash. */
export const validHeadCommit = "0123456789abcdef0123456789abcdef01234567";

export const validWorkspace: WorkspaceRef = {
  repoId: "homefleet",
  headCommit: validHeadCommit,
};

export const validNodeInfo: NodeInfo = {
  deviceId: validDeviceId,
  name: "tower",
  daemonVersion: "0.1.0",
  protocolVersion: "0.1.0",
  platform: "win32",
  roles: ["inference", "execution"],
  executors: ["command", "agent"],
  models: [{ id: "qwen3.5-9b", contextWindow: 32768 }],
  hardware: {
    cpu: "AMD Ryzen 5 5600X",
    ramBytes: 34359738368,
    gpus: [{ name: "RX 6700 XT", vramBytes: 12884901888 }],
  },
  maxConcurrentJobs: 2,
  activeJobs: 0,
};

export const validJobResult: JobResult = {
  jobId: validJobId,
  type: "recon",
  status: "succeeded",
  summary: "Repo uses pnpm workspaces with three packages.",
  stats: {
    toolCalls: 7,
    wallMs: 42137,
    promptTokens: 1500,
    completionTokens: 300,
  },
};
