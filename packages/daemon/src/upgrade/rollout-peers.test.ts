import type { NodeInfo } from "@homefleet/protocol";
import { describe, expect, test } from "vitest";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import type { HfpTarget } from "../transport/client.js";
import { createRolloutPeers } from "./rollout-peers.js";

const ID = `a1${"0".repeat(62)}`;
const OURS = { deviceId: "ours" } as NodeInfo;

function entry(extra: Partial<NodeDirectoryEntry> = {}): NodeDirectoryEntry {
  return {
    deviceId: ID,
    name: "tower",
    host: "10.0.0.5",
    port: 7000,
    reachable: true,
    ...extra,
  };
}

function setup(resolved: { host?: string; port?: number } | undefined) {
  const helloTargets: HfpTarget[] = [];
  const peers = createRolloutPeers({
    nodeDirectory: {
      list: async () => [entry()],
      resolve: (deviceId) =>
        resolved === undefined
          ? undefined
          : { deviceId, name: "tower", ...resolved },
    },
    client: {
      request: async () => ({ accepted: true, version: "0.5.3" }) as never,
      hello: async (target) => {
        helloTargets.push(target);
        return { nodeInfo: { daemonVersion: "0.5.3" } as NodeInfo } as never;
      },
    },
    ourNodeInfo: () => OURS,
  });
  return { peers, helloTargets };
}

describe("createRolloutPeers.hello", () => {
  test("re-resolves the endpoint instead of using the one captured at list()", async () => {
    const { peers, helloTargets } = setup({ host: "10.0.0.9", port: 7001 });
    const info = await peers.hello(entry());
    expect(info?.daemonVersion).toBe("0.5.3");
    expect(helloTargets).toEqual([
      {
        host: "10.0.0.9",
        port: 7001,
        expectedDeviceId: ID,
        timeoutMs: 2000,
      },
    ]);
  });

  test("falls back to the listed endpoint when the directory has none now", async () => {
    const { peers, helloTargets } = setup({});
    await peers.hello(entry());
    expect(helloTargets[0]).toMatchObject({ host: "10.0.0.5", port: 7000 });
  });

  test("no endpoint anywhere -> undefined without a request", async () => {
    const { peers, helloTargets } = setup(undefined);
    expect(
      await peers.hello(entry({ host: undefined, port: undefined })),
    ).toBeUndefined();
    expect(helloTargets).toEqual([]);
  });
});
