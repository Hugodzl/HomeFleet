/**
 * The daemon's {@link RolloutPeers}: the node directory for who to push to,
 * the pinned HFP client for the push and the restart polls.
 *
 * A pushed peer restarts, and may come back on a different address (a new
 * DHCP lease, a re-announce on another port), so every poll re-resolves the
 * endpoint from the directory and only falls back to the one listed when
 * the rollout started.
 */
import { type NodeInfo, UpgradeAcceptedSchema } from "@homefleet/protocol";
import type {
  NodeDirectoryEntry,
  ResolvedNode,
} from "../mcp/node-directory.js";
import type { HfpClient } from "../transport/client.js";
import type { RolloutPeers } from "./rollout.js";

const HELLO_TIMEOUT_MS = 2000;

export interface RolloutPeersDeps {
  nodeDirectory: {
    list(): Promise<NodeDirectoryEntry[]>;
    resolve(deviceId: string): ResolvedNode | undefined;
  };
  client: Pick<HfpClient, "request" | "hello">;
  ourNodeInfo: () => NodeInfo;
}

export function createRolloutPeers(deps: RolloutPeersDeps): RolloutPeers {
  const { nodeDirectory, client, ourNodeInfo } = deps;
  return {
    list: () => nodeDirectory.list(),
    push: async (entry, request) => {
      if (entry.host === undefined || entry.port === undefined) {
        throw new Error("no known address for this node");
      }
      await client.request({
        host: entry.host,
        port: entry.port,
        expectedDeviceId: entry.deviceId,
        method: "POST",
        path: "/upgrade",
        body: request,
        responseSchema: UpgradeAcceptedSchema,
      });
    },
    hello: async (entry) => {
      const now = nodeDirectory.resolve(entry.deviceId);
      const endpoint =
        now?.host !== undefined && now.port !== undefined ? now : entry;
      if (endpoint.host === undefined || endpoint.port === undefined) {
        return undefined;
      }
      try {
        const { nodeInfo } = await client.hello(
          {
            host: endpoint.host,
            port: endpoint.port,
            expectedDeviceId: entry.deviceId,
            timeoutMs: HELLO_TIMEOUT_MS,
          },
          ourNodeInfo(),
        );
        return nodeInfo;
      } catch {
        return undefined;
      }
    },
  };
}
