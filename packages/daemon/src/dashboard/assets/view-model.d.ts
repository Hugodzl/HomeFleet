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
}
export function nodeRows(
  nodes: NodeDirectoryEntry[],
  ourVersion: string,
): NodeRow[];
export function workerJobRows(
  jobs: WorkerJobSummary[],
  nowMs: number,
): Array<Record<string, string>>;
export function delegatedJobRows(
  jobs: DelegatedJobSummary[],
  nowMs: number,
): Array<Record<string, string>>;
