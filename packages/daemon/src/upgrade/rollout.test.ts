import type { NodeInfo, UpgradeRequest } from "@homefleet/protocol";
import { describe, expect, it } from "vitest";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import { HfpRequestError } from "../transport/client.js";
import { UpgradeError } from "./errors.js";
import type { PreparedRelease } from "./prepare.js";
import {
  FleetRollout,
  type RolloutPeers,
  type RolloutStatus,
  restoreRolloutStatus,
} from "./rollout.js";

const TARGET = "0.5.2";

function info(
  daemonVersion: string,
  lastUpgrade?: NodeInfo["lastUpgrade"],
): NodeInfo {
  return { daemonVersion, ...(lastUpgrade ? { lastUpgrade } : {}) } as NodeInfo;
}

function entry(
  id: string,
  version: string,
  extra: Partial<NodeDirectoryEntry> = {},
): NodeDirectoryEntry {
  return {
    deviceId: id,
    name: id,
    host: "127.0.0.1",
    port: 1,
    reachable: true,
    nodeInfo: info(version),
    ...extra,
  };
}

interface Harness {
  rollout: FleetRollout;
  calls: string[];
  clock: { t: number };
  versions: Map<string, NodeInfo | undefined>;
  pushErrors: Map<string, Error>;
  helloHook: Map<string, () => void>;
  requests: UpgradeRequest[];
}

function setup(
  entries: NodeDirectoryEntry[],
  opts: {
    currentVersion?: string;
    selfError?: Error;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    persist?: (status: RolloutStatus) => Promise<void>;
    previous?: () => RolloutStatus | undefined;
  } = {},
): Harness {
  const calls: string[] = [];
  const clock = { t: 1_000_000 };
  const versions = new Map<string, NodeInfo | undefined>();
  const pushErrors = new Map<string, Error>();
  const helloHook = new Map<string, () => void>();
  const requests: UpgradeRequest[] = [];
  const peers: RolloutPeers = {
    list: async () => entries,
    push: async (e, request) => {
      calls.push(`push(${e.deviceId})`);
      requests.push(request);
      const err = pushErrors.get(e.deviceId);
      if (err) throw err;
      // a successful push makes the node flip to the target on its next hello
      versions.set(e.deviceId, info(TARGET));
    },
    hello: async (e) => {
      helloHook.get(e.deviceId)?.();
      const v = versions.get(e.deviceId);
      if (v?.daemonVersion === TARGET) calls.push(`${e.deviceId} succeeded`);
      return v;
    },
  };
  return {
    calls,
    clock,
    versions,
    pushErrors,
    helloHook,
    requests,
    rollout: new FleetRollout({
      peers,
      currentVersion: opts.currentVersion ?? "0.5.0",
      upgradeSelf: async ({ version }) => {
        calls.push("upgradeSelf");
        if (opts.selfError) throw opts.selfError;
        return { from: "0.5.0", to: version ?? TARGET };
      },
      now: () => clock.t,
      sleep:
        opts.sleep ??
        (async (ms) => {
          clock.t += ms;
        }),
      pollMs: 10,
      waitMs: opts.waitMs ?? 100,
      ...(opts.persist ? { persist: opts.persist } : {}),
      ...(opts.previous ? { previous: opts.previous } : {}),
    }),
  };
}

const prepared = {
  version: TARGET,
  tarballPath: "x.tgz",
  manifest: {},
} as unknown as PreparedRelease;
const startInput = {
  prepared,
  manifestBytes: Buffer.from("manifest"),
  signature: "c2ln",
};

async function run(
  h: Harness,
  input: Partial<Parameters<FleetRollout["start"]>[0]> = {},
) {
  await h.rollout.start({ ...startInput, ...input });
  // let the background loop settle
  for (let i = 0; i < 200; i++) {
    const s = h.rollout.status();
    if (s && (s.state !== "running" || s.self.state === "restarting")) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  return h.rollout.status() as RolloutStatus;
}

describe("FleetRollout", () => {
  it("selects reachable older peers only", async () => {
    const h = setup([
      entry("p1", "0.5.0"),
      entry("current", TARGET),
      entry("down", "0.5.0", { reachable: false, nodeInfo: undefined }),
    ]);
    const initial = await h.rollout.start({ ...startInput });
    expect(initial.peers.map((p) => p.deviceId)).toEqual(["p1"]);
    expect(initial.self.state).toBe("pending");
    expect(initial.target).toBe(TARGET);
    initial.peers.length = 0;
    expect(h.rollout.status()?.peers).toHaveLength(1);
  });

  it("pushes peers one at a time, then upgrades self last", async () => {
    const h = setup([entry("p1", "0.5.0"), entry("p2", "0.5.0")]);
    const s = await run(h);
    expect(h.calls).toEqual([
      "push(p1)",
      "p1 succeeded",
      "push(p2)",
      "p2 succeeded",
      "upgradeSelf",
    ]);
    expect(s.peers.map((p) => p.state)).toEqual(["succeeded", "succeeded"]);
    expect(s.self.state).toBe("restarting");
    expect(s.state).toBe("running");
    expect(h.requests[0]).toEqual({
      version: TARGET,
      manifest: Buffer.from("manifest").toString("base64"),
      signature: "c2ln",
    });
  });

  it("continues past a refused and a too-old peer", async () => {
    const h = setup([
      entry("p1", "0.5.0"),
      entry("p2", "0.4.0"),
      entry("p3", "0.5.0"),
      entry("p4", "0.5.0"),
    ]);
    h.pushErrors.set(
      "p1",
      new HfpRequestError(
        409,
        { code: "UPGRADE_BUSY", message: "busy now" },
        "busy",
      ),
    );
    h.pushErrors.set("p2", new HfpRequestError(404, undefined, "not found"));
    h.pushErrors.set("p3", new Error("ECONNREFUSED"));
    const s = await run(h);
    expect(s.peers.map((p) => p.state)).toEqual([
      "refused",
      "too-old",
      "unreachable",
      "succeeded",
    ]);
    expect(s.peers[0]?.reason).toBe("busy now");
    expect(s.peers[1]?.reason).toBe(
      'too old for remote upgrade; run "homefleet upgrade" there (npm i -g on v0.4 or older)',
    );
    expect(h.calls.at(-1)).toBe("upgradeSelf");
  });

  it("stops the rollout when a peer rolls back", async () => {
    const h = setup([entry("p1", "0.5.0"), entry("p2", "0.5.0")]);
    h.helloHook.set("p1", () => {
      h.versions.set(
        "p1",
        info("0.5.0", {
          version: TARGET,
          outcome: "rolled-back",
          reason: "health check failed",
          at: new Date(h.clock.t).toISOString(),
        }),
      );
    });
    const s = await run(h);
    expect(s.peers[0]).toMatchObject({
      state: "rolled-back",
      reason: "health check failed",
    });
    expect(s.peers[1]?.state).toBe("pending");
    expect(s.self.state).toBe("pending");
    expect(s.state).toBe("stopped");
    expect(h.calls).not.toContain("push(p2)");
    expect(h.calls).not.toContain("upgradeSelf");
  });

  it("times out after waitMs and stops", async () => {
    const h = setup([entry("p1", "0.5.0"), entry("p2", "0.5.0")], {
      waitMs: 50,
    });
    h.helloHook.set("p1", () => h.versions.set("p1", undefined));
    const s = await run(h);
    expect(s.peers[0]).toMatchObject({
      state: "timeout",
      reason: "unknown — check the node",
    });
    expect(s.state).toBe("stopped");
    expect(s.self.state).toBe("pending");
    expect(h.calls).not.toContain("push(p2)");
  });

  it("ignores a lastUpgrade unchanged from before the push", async () => {
    const old = {
      version: TARGET,
      outcome: "failed" as const,
      reason: "old",
      at: new Date(1_000_000 - 60_000).toISOString(),
    };
    const h = setup([entry("p1", "0.5.0", { nodeInfo: info("0.5.0", old) })]);
    let polls = 0;
    h.helloHook.set("p1", () => {
      polls += 1;
      h.versions.set("p1", polls === 1 ? info("0.5.0", old) : info(TARGET));
    });
    const s = await run(h);
    expect(s.peers[0]?.state).toBe("succeeded");
    expect(s.state).toBe("running");
  });

  it("peer clock skew: a pre-existing failed record with a future `at` is still ignored", async () => {
    const old = {
      version: TARGET,
      outcome: "failed" as const,
      reason: "old",
      at: new Date(1_000_000 + 3_600_000).toISOString(), // peer clock an hour ahead
    };
    const h = setup([entry("p1", "0.5.0", { nodeInfo: info("0.5.0", old) })]);
    let polls = 0;
    h.helloHook.set("p1", () => {
      polls += 1;
      h.versions.set("p1", polls === 1 ? info("0.5.0", old) : info(TARGET));
    });
    const s = await run(h);
    expect(s.peers[0]?.state).toBe("succeeded");
    expect(s.state).toBe("running");
  });

  it("a fresh failed record with an `at` in the requester's past (peer clock behind) still stops", async () => {
    const h = setup([entry("p1", "0.5.0"), entry("p2", "0.5.0")]);
    h.helloHook.set("p1", () => {
      h.versions.set(
        "p1",
        info("0.5.0", {
          version: TARGET,
          outcome: "failed",
          reason: "disk full",
          at: new Date(h.clock.t - 3_600_000).toISOString(),
        }),
      );
    });
    const s = await run(h);
    expect(s.peers[0]).toMatchObject({ state: "failed", reason: "disk full" });
    expect(s.state).toBe("stopped");
    expect(h.calls).not.toContain("push(p2)");
  });

  it("a peer that comes back newer than the target counts as succeeded", async () => {
    const h = setup([entry("p1", "0.5.0")]);
    h.helloHook.set("p1", () => h.versions.set("p1", info("0.5.3")));
    const s = await run(h);
    expect(s.peers[0]?.state).toBe("succeeded");
    expect(h.calls.at(-1)).toBe("upgradeSelf");
  });

  it("unreachable selected peer is skipped", async () => {
    const h = setup([
      entry("p1", "0.5.0", {
        host: undefined,
        port: undefined,
        reachable: false,
        nodeInfo: undefined,
      }),
      entry("p2", "0.5.0"),
    ]);
    const s = await run(h, { nodes: ["p1"] });
    expect(s.peers).toHaveLength(1);
    expect(s.peers[0]?.state).toBe("unreachable");
    expect(h.calls).toEqual(["upgradeSelf"]);
  });

  it("self already current -> skipped, state done", async () => {
    const h = setup([entry("p1", "0.5.0")], { currentVersion: TARGET });
    const s = await run(h);
    expect(s.self.state).toBe("skipped");
    expect(s.state).toBe("done");
    expect(h.calls).not.toContain("upgradeSelf");
  });

  it("a refused self upgrade ends the rollout as done", async () => {
    const h = setup([], {
      selfError: new UpgradeError("busy", "another upgrade is running"),
    });
    const s = await run(h);
    expect(s.self).toEqual({
      state: "refused",
      reason: "another upgrade is running",
    });
    expect(s.state).toBe("done");
  });

  it("abort() stops a rollout that is still polling a peer, and never upgrades self", async () => {
    let wake: (() => void) | undefined;
    const h = setup([entry("p1", "0.5.0"), entry("p2", "0.5.0")], {
      // Each poll waits for the test to let it go.
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    // p1 never comes back on the target.
    h.helloHook.set("p1", () => h.versions.set("p1", undefined));
    await h.rollout.start({ ...startInput });
    for (let i = 0; i < 50 && wake === undefined; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.rollout.status()?.peers[0]?.state).toBe("restarting");

    const aborted = h.rollout.abort();
    wake?.();
    await aborted;

    const s = h.rollout.status() as RolloutStatus;
    expect(s.state).toBe("stopped");
    expect(s.self.reason).toBe("the daemon stopped during the rollout");
    expect(h.calls).not.toContain("push(p2)");
    expect(h.calls).not.toContain("upgradeSelf");
  });

  it("abort() with no rollout running resolves and changes nothing", async () => {
    const h = setup([entry("p1", "0.5.0")], { currentVersion: TARGET });
    const before = await run(h);
    await h.rollout.abort();
    expect(h.rollout.status()).toEqual(before);
  });

  it("a --nodes peer with no nodeInfo snapshots lastUpgrade with a hello before the push", async () => {
    const stale = {
      version: TARGET,
      outcome: "failed" as const,
      reason: "stale",
      at: new Date(1_000_000 - 60_000).toISOString(),
    };
    const h = setup([
      entry("p1", "0.5.0", { reachable: false, nodeInfo: undefined }),
    ]);
    // Before the push the peer reports an OLD failure for the same target;
    // after it, the same record until it comes back on the target.
    h.versions.set("p1", info("0.5.0", stale));
    let polls = 0;
    h.helloHook.set("p1", () => {
      if (!h.calls.includes("push(p1)")) return;
      polls += 1;
      h.versions.set("p1", polls < 3 ? info("0.5.0", stale) : info(TARGET));
    });
    const s = await run(h, { nodes: ["p1"] });
    expect(s.peers[0]?.state).toBe("succeeded");
    expect(h.calls.at(-1)).toBe("upgradeSelf");
  });

  it("persists the status when self hands off to its restart", async () => {
    const saved: RolloutStatus[] = [];
    const h = setup([entry("p1", "0.5.0")], {
      persist: async (status) => {
        saved.push(status);
      },
    });
    const s = await run(h);
    for (let i = 0; i < 20 && saved.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(s);
    expect(saved[0]?.self.state).toBe("restarting");
  });

  it("persists a stopped rollout too", async () => {
    const saved: RolloutStatus[] = [];
    const h = setup([entry("p1", "0.5.0")], {
      waitMs: 30,
      persist: async (status) => {
        saved.push(status);
      },
    });
    h.helloHook.set("p1", () => h.versions.set("p1", undefined));
    await run(h);
    for (let i = 0; i < 20 && saved.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(saved.map((s) => s.state)).toEqual(["stopped"]);
  });

  it("a failing persist does not break the rollout", async () => {
    const h = setup([entry("p1", "0.5.0")], {
      persist: async () => {
        throw new Error("disk full");
      },
    });
    const s = await run(h);
    expect(s.self.state).toBe("restarting");
  });

  it("serves the previous (restored) rollout until a new one starts", async () => {
    const restored = {
      id: "old",
      target: TARGET,
      startedAt: new Date(0).toISOString(),
      state: "done",
      peers: [],
      self: { state: "succeeded" },
    } satisfies RolloutStatus;
    const h = setup([entry("p1", "0.5.0")], { previous: () => restored });
    expect(h.rollout.status()).toEqual(restored);
    const s = await run(h);
    expect(s.id).not.toBe("old");
  });
});

describe("restoreRolloutStatus", () => {
  const startedAt = "2026-10-23T10:00:00.000Z";
  const saved: RolloutStatus = {
    id: "r1",
    target: TARGET,
    startedAt,
    state: "running",
    peers: [
      {
        deviceId: "t",
        name: "tower",
        from: "0.5.0",
        state: "refused",
        reason: "remote upgrades are disabled",
      },
    ],
    self: { state: "restarting" },
  };

  it("back on the target: self succeeded, rollout done, peers kept", () => {
    const s = restoreRolloutStatus(saved, { daemonVersion: TARGET });
    expect(s.state).toBe("done");
    expect(s.self).toEqual({ state: "succeeded" });
    expect(s.peers).toEqual(saved.peers);
  });

  it("a fresh rolled-back record for the target becomes the self outcome", () => {
    const s = restoreRolloutStatus(saved, {
      daemonVersion: "0.5.0",
      lastUpgrade: {
        from: "0.5.0",
        to: TARGET,
        outcome: "rolled-back",
        reason: "health check failed",
        at: Date.parse(startedAt) + 60_000,
      },
    });
    expect(s.self).toEqual({
      state: "rolled-back",
      reason: "health check failed",
    });
    expect(s.state).toBe("done");
  });

  it("an older failure record is ignored: self still restarting, never running", () => {
    const s = restoreRolloutStatus(saved, {
      daemonVersion: "0.5.0",
      lastUpgrade: {
        from: "0.5.0",
        to: TARGET,
        outcome: "failed",
        at: Date.parse(startedAt) - 60_000,
      },
    });
    expect(s.self.state).toBe("restarting");
    expect(s.state).toBe("done");
  });

  it("a status saved without a self restart is served as it was", () => {
    const stopped = { ...saved, state: "stopped", self: { state: "pending" } };
    expect(
      restoreRolloutStatus(stopped as RolloutStatus, {
        daemonVersion: "0.5.0",
      }),
    ).toEqual(stopped);
  });
});
