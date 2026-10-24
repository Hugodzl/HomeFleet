/**
 * Types for view-model.js (plain JS so the browser loads it unmodified).
 * Keep in sync with view-model.js; view-model.test.ts exercises both.
 */

import type { ModelInfo } from "@homefleet/protocol";
import type {
  ControlStatus,
  DelegatedJobSummary,
  WorkerJobSummary,
} from "../../control/control-server.js";
import type { NodeDirectoryEntry } from "../../mcp/node-directory.js";
import type { RolloutStatus } from "../../upgrade/rollout.js";

export function shortId(id: string): string;
export function relativeTime(
  epochMs: number | undefined,
  nowMs: number,
): string;
export function selfRows(status: ControlStatus): Array<[string, string]>;
export function modelRows(
  models: ModelInfo[],
): Array<{ id: string; label: string; status: string }>;
export interface NodeRow {
  name: string;
  deviceId: string;
  endpoint: string;
  reachable: "yes" | "no";
  version: string;
  skew: boolean;
  executors: string;
  models: string;
  load: string;
  fullId: string;
  allowRemote: boolean;
  activeJobs: number;
  upgrade: UpgradeBadge;
}
export interface UpgradeBadge {
  eligible: boolean;
  label: string;
  why: string;
}
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function nodeRows(
  nodes: NodeDirectoryEntry[],
  ourVersion: string,
  target?: string,
): NodeRow[];
export function selfUpgrade(status: {
  daemonVersion: string;
  availableUpgrade?: string;
}): UpgradeBadge;
export interface ConfirmPeer {
  name: string;
  activeJobs: number;
  upgrade: { eligible: boolean; why: string };
}
export function confirmSummary(input: {
  prepared?: { target: string };
  error?: string;
  peers: ConfirmPeer[];
  self: { included: boolean; version: string; activeJobs: number };
  forceSelf: boolean;
}): { title: string; lines: string[]; canConfirm: boolean };
export function progressRows(
  rollout: RolloutStatus | null,
): Array<{ name: string; state: string; reason: string }>;
export function startOutcome(error: {
  status?: number;
  code?: string;
  message: string;
}): { kind: "already-running" } | { kind: "error"; message: string };
export function reloadDecision(input: {
  loadedVersion: string;
  statusVersion: string;
  badToken: boolean;
  lastReloadAt: number;
  now: number;
}): boolean;
export function workerJobRows(
  jobs: WorkerJobSummary[],
  nowMs: number,
): Array<Record<string, string>>;
export function delegatedJobRows(
  jobs: DelegatedJobSummary[],
  nowMs: number,
): Array<Record<string, string>>;
export function versionCell(row: {
  version: string;
  skew: boolean;
  upgrade: { eligible: boolean; label: string };
}): { text: string; className: string | undefined };
export function restartBannerState(input: {
  confirmedSelfOrFleet: boolean;
  rollout: RolloutStatus | null;
  pollFailed: boolean;
}): boolean;
