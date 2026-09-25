/**
 * Resolves what an operator typed after `homefleet unpair` to exactly one
 * paired node (spec 2026-09-25). The argument matches a node when it is:
 *
 * - a hex string of 8–64 chars that PREFIXES the node's device ID
 *   (case-insensitive — people copy the dashboard's / `nodes`' short ids),
 * - or EXACTLY the node's name (case-sensitive).
 *
 * Every hit counts; hits are de-duplicated by device ID. Duplicate names are
 * the realistic ambiguity (the trust store is keyed by device ID, so a
 * re-installed machine can leave a stale same-named entry), and an id-prefix
 * hit on one node plus a name hit on another is ambiguous too — never guess
 * which one a revocation meant.
 *
 * Input is the `/control/nodes` listing, which holds ONLY paired devices, so
 * this can never select an unpaired one. Pure: no I/O.
 */
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";

export type UnpairTarget = Pick<NodeDirectoryEntry, "deviceId" | "name">;

export type UnpairResolution =
  | { kind: "match"; node: UnpairTarget }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: UnpairTarget[] };

/** At least 8 hex chars: the shortest id prefix we accept as an id query. */
const DEVICE_ID_QUERY = /^[0-9a-f]{8,64}$/i;

export function resolveUnpairTarget(
  arg: string,
  nodes: readonly UnpairTarget[],
): UnpairResolution {
  const idQuery = DEVICE_ID_QUERY.test(arg) ? arg.toLowerCase() : undefined;
  const hits = new Map<string, UnpairTarget>();
  for (const node of nodes) {
    const idHit =
      idQuery !== undefined && node.deviceId.toLowerCase().startsWith(idQuery);
    if (idHit || node.name === arg) {
      hits.set(node.deviceId, { deviceId: node.deviceId, name: node.name });
    }
  }
  const candidates = [...hits.values()];
  if (candidates.length === 0) {
    return { kind: "none" };
  }
  if (candidates.length === 1) {
    return { kind: "match", node: candidates[0] as UnpairTarget };
  }
  return { kind: "ambiguous", candidates };
}
