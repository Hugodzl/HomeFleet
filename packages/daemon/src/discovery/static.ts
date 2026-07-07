/**
 * Static discovery entries: config-provided nodes (config.json,
 * `discovery.staticNodes`) surfaced as candidates at startup — the escape
 * hatch for networks where neither mDNS nor UDP multicast can see a peer.
 */
import type { StaticNode } from "../config/config.js";
import type { DiscoveryCandidate } from "./candidate.js";

/** Maps config entries to candidates, stamped with `now` (ms since epoch). */
export function staticNodeCandidates(
  nodes: StaticNode[],
  now: number,
): DiscoveryCandidate[] {
  return nodes.map((node) => {
    const candidate: DiscoveryCandidate = {
      host: node.host,
      port: node.port,
      source: "static",
      lastSeenAt: now,
    };
    if (node.expectedDeviceId !== undefined) {
      candidate.deviceId = node.expectedDeviceId;
    }
    return candidate;
  });
}
