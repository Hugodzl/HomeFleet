import type { HelloResponse, NodeInfo } from "@homefleet/protocol";
import { describe, expect, test } from "vitest";
import { makeNodeInfo } from "../test-fixtures.js";
import type { HfpTarget } from "../transport/client.js";
import {
  NodeDirectory,
  type NodeEndpoint,
  type NodeEndpointSource,
} from "./node-directory.js";

const DEV_A = "a".repeat(64);
const DEV_B = "b".repeat(64);
const DEV_C = "c".repeat(64);

/** A trust store stand-in exposing only what the directory reads. */
function fakeTrust(devices: Array<{ deviceId: string; name: string }>) {
  return { list: () => devices.map((d) => ({ ...d })) };
}

/** An endpoint source backed by a plain map. */
function fakeSource(map: Record<string, NodeEndpoint>): NodeEndpointSource {
  return { endpointFor: (deviceId) => map[deviceId] };
}

const ourInfo = (): NodeInfo => makeNodeInfo(DEV_A, "delegator");

describe("NodeDirectory.list", () => {
  test("a paired, discovered, reachable node carries its hello nodeInfo", async () => {
    const targets: HfpTarget[] = [];
    const directory = new NodeDirectory({
      trustStore: fakeTrust([{ deviceId: DEV_B, name: "worker" }]),
      source: fakeSource({ [DEV_B]: { host: "127.0.0.1", port: 5000 } }),
      hfpClient: {
        hello: async (target): Promise<HelloResponse> => {
          targets.push(target);
          return { nodeInfo: makeNodeInfo(DEV_B, "worker") };
        },
      },
      ourNodeInfo: ourInfo,
    });

    const entries = await directory.list();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.deviceId).toBe(DEV_B);
    expect(entry?.reachable).toBe(true);
    expect(entry?.host).toBe("127.0.0.1");
    expect(entry?.port).toBe(5000);
    expect(entry?.nodeInfo?.deviceId).toBe(DEV_B);
    // hello was pinned to the paired device id.
    expect(targets[0]?.expectedDeviceId).toBe(DEV_B);
  });

  test("a paired but never-discovered node is reachable:false with no endpoint", async () => {
    const directory = new NodeDirectory({
      trustStore: fakeTrust([{ deviceId: DEV_C, name: "asleep" }]),
      source: fakeSource({}),
      hfpClient: {
        hello: async () => {
          throw new Error("should not be called for an undiscovered node");
        },
      },
      ourNodeInfo: ourInfo,
    });

    const [entry] = await directory.list();
    expect(entry?.reachable).toBe(false);
    expect(entry?.host).toBeUndefined();
    expect(entry?.port).toBeUndefined();
    expect(entry?.nodeInfo).toBeUndefined();
  });

  test("one down node does not fail the whole listing", async () => {
    const directory = new NodeDirectory({
      trustStore: fakeTrust([
        { deviceId: DEV_B, name: "up" },
        { deviceId: DEV_C, name: "down" },
      ]),
      source: fakeSource({
        [DEV_B]: { host: "127.0.0.1", port: 5000 },
        [DEV_C]: { host: "127.0.0.1", port: 5001 },
      }),
      hfpClient: {
        hello: async (target): Promise<HelloResponse> => {
          if (target.port === 5001) {
            throw new Error("ECONNREFUSED");
          }
          return { nodeInfo: makeNodeInfo(DEV_B, "up") };
        },
      },
      ourNodeInfo: ourInfo,
    });

    const entries = await directory.list();
    expect(entries).toHaveLength(2);
    const up = entries.find((e) => e.deviceId === DEV_B);
    const down = entries.find((e) => e.deviceId === DEV_C);
    expect(up?.reachable).toBe(true);
    expect(up?.nodeInfo).toBeDefined();
    // The down node still appears — discovered endpoint, but hello failed.
    expect(down?.reachable).toBe(false);
    expect(down?.host).toBe("127.0.0.1");
    expect(down?.nodeInfo).toBeUndefined();
  });
});

describe("NodeDirectory.resolve", () => {
  const directory = new NodeDirectory({
    trustStore: fakeTrust([
      { deviceId: DEV_B, name: "worker" },
      { deviceId: DEV_C, name: "asleep" },
    ]),
    source: fakeSource({ [DEV_B]: { host: "127.0.0.1", port: 5000 } }),
    hfpClient: { hello: async () => ({ nodeInfo: makeNodeInfo(DEV_B, "x") }) },
    ourNodeInfo: ourInfo,
  });

  test("resolves a paired, discovered node to its endpoint (no hello)", () => {
    expect(directory.resolve(DEV_B)).toEqual({
      deviceId: DEV_B,
      name: "worker",
      host: "127.0.0.1",
      port: 5000,
    });
  });

  test("a paired but undiscovered node resolves with no host/port", () => {
    expect(directory.resolve(DEV_C)).toEqual({
      deviceId: DEV_C,
      name: "asleep",
    });
  });

  test("an unpaired node resolves to undefined", () => {
    expect(directory.resolve("f".repeat(64))).toBeUndefined();
  });
});
