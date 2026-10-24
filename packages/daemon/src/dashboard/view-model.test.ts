import { describe, expect, test } from "vitest";
import type { ControlJobs, ControlStatus } from "../control/control-server.js";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import {
  compareVersions,
  confirmSummary,
  delegatedJobRows,
  modelRows,
  nodeRows,
  progressRows,
  relativeTime,
  reloadDecision,
  restartBannerState,
  selfRows,
  selfUpgrade,
  shortId,
  startOutcome,
  versionCell,
  workerJobRows,
} from "./assets/view-model.js";

const SELF: ControlStatus = {
  deviceId: "a".repeat(64),
  name: "laptop",
  platform: "win32",
  daemonVersion: "0.3.1",
  protocolVersion: "0.3.0",
  hfpPort: 56370,
  mcpPort: 56372,
  controlPort: 56373,
  roles: ["execution"],
  executors: ["command", "agent"],
  models: [
    { id: "qwen3.5:4b", label: "Qwen 4B", status: "ok" },
    { id: "bare" },
  ],
  activeJobs: 1,
  maxConcurrentJobs: 2,
};

describe("formatting helpers", () => {
  test("shortId truncates long ids with an ellipsis and leaves short ones", () => {
    expect(shortId("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
    expect(shortId("abc")).toBe("abc");
  });

  test("relativeTime buckets seconds/minutes/hours/days; undefined is a dash", () => {
    const now = 1_000_000_000;
    expect(relativeTime(undefined, now)).toBe("—");
    expect(relativeTime(now - 5_000, now)).toBe("5s ago");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(relativeTime(now + 5_000, now)).toBe("0s ago"); // clock skew clamps
  });
});

test("selfRows renders identity, versions, ports, capabilities and load", () => {
  expect(selfRows(SELF)).toEqual([
    ["Name", "laptop"],
    ["Device ID", "a".repeat(64)],
    ["Platform", "win32"],
    ["Version", "daemon 0.3.1 · protocol 0.3.0"],
    ["Ports", "HFP 56370 · MCP 56372 · control 56373"],
    ["Roles", "execution"],
    ["Executors", "command, agent"],
    ["Load", "1 / 2 jobs running"],
  ]);
  expect(selfRows({ ...SELF, roles: [], executors: [] })[5]).toEqual([
    "Roles",
    "(none)",
  ]);
});

test("modelRows shows label and catalog status, dashing missing fields", () => {
  expect(modelRows(SELF.models)).toEqual([
    { id: "qwen3.5:4b", label: "Qwen 4B", status: "ok" },
    { id: "bare", label: "—", status: "—" },
  ]);
});

test("nodeRows flags version skew and handles unreachable peers", () => {
  const nodes: NodeDirectoryEntry[] = [
    {
      deviceId: "b".repeat(64),
      name: "tower",
      host: "192.168.68.73",
      port: 56370,
      reachable: true,
      nodeInfo: {
        deviceId: "b".repeat(64),
        name: "tower",
        daemonVersion: "0.3.0",
        protocolVersion: "0.3.0",
        platform: "win32",
        roles: ["inference", "execution"],
        executors: ["command", "agent", "write"],
        models: [{ id: "qwen3.6-35b-a3b" }],
        hardware: { cpu: "Ryzen", ramBytes: 1, gpus: [] },
        maxConcurrentJobs: 2,
        activeJobs: 0,
      },
    },
    { deviceId: "c".repeat(64), name: "asleep", reachable: false },
  ];
  expect(nodeRows(nodes, "0.3.1")).toEqual([
    {
      name: "tower",
      deviceId: `${"b".repeat(12)}…`,
      endpoint: "192.168.68.73:56370",
      reachable: "yes",
      version: "0.3.0",
      skew: true,
      executors: "command, agent, write",
      models: "qwen3.6-35b-a3b",
      load: "0 / 2",
      fullId: "b".repeat(64),
      allowRemote: false,
      activeJobs: 0,
      upgrade: { eligible: false, label: "", why: "no upgrade available" },
    },
    {
      name: "asleep",
      deviceId: `${"c".repeat(12)}…`,
      endpoint: "—",
      reachable: "no",
      version: "—",
      skew: false,
      executors: "—",
      models: "—",
      load: "—",
      fullId: "c".repeat(64),
      allowRemote: false,
      activeJobs: 0,
      upgrade: { eligible: false, label: "", why: "no upgrade available" },
    },
  ]);
});

test("job rows prefer paired names and format times/status", () => {
  const now = 10_000_000;
  const jobs: ControlJobs = {
    worker: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        type: "command",
        ownerDeviceId: "b".repeat(64),
        repoId: "homefleet",
        status: "failed",
        createdAt: now - 120_000,
        startedAt: now - 60_000,
        terminalAt: now - 1_000,
        errorCode: "INTERNAL",
      },
      {
        jobId: "33333333-3333-4333-8333-333333333333",
        type: "command",
        ownerDeviceId: "b".repeat(64),
        ownerName: "tower",
        repoId: "homefleet",
        status: "succeeded",
        createdAt: now - 120_000,
        startedAt: now - 60_000,
        terminalAt: now - 1_000,
      },
    ],
    delegated: [
      {
        jobId: "22222222-2222-4222-8222-222222222222",
        type: "write",
        targetDeviceId: "b".repeat(64),
        targetName: "tower",
        repoId: "homefleet",
        recordedAt: now - 30_000,
        lastStatus: "succeeded",
        lastStatusAt: now - 2_000,
        appliedBranch: "homefleet/222222222222",
      },
      {
        jobId: "44444444-4444-4444-8444-444444444444",
        type: "write",
        targetDeviceId: "b".repeat(64),
        repoId: "homefleet",
        recordedAt: now - 30_000,
        lastStatus: "succeeded",
        lastStatusAt: now - 2_000,
      },
    ],
  };
  expect(workerJobRows(jobs.worker, now)).toEqual([
    {
      jobId: "11111111-111…",
      type: "command",
      owner: `${"b".repeat(12)}…`,
      repoId: "homefleet",
      status: "failed",
      created: "2m ago",
      started: "1m ago",
      finished: "1s ago",
      error: "INTERNAL",
    },
    {
      jobId: "33333333-333…",
      type: "command",
      owner: "tower",
      repoId: "homefleet",
      status: "succeeded",
      created: "2m ago",
      started: "1m ago",
      finished: "1s ago",
      error: "",
    },
  ]);
  expect(delegatedJobRows(jobs.delegated, now)).toEqual([
    {
      jobId: "22222222-222…",
      type: "write",
      target: "tower",
      repoId: "homefleet",
      sent: "30s ago",
      status: "succeeded",
      seen: "2s ago",
      branch: "homefleet/222222222222",
    },
    {
      jobId: "44444444-444…",
      type: "write",
      target: `${"b".repeat(12)}…`,
      repoId: "homefleet",
      sent: "30s ago",
      status: "succeeded",
      seen: "2s ago",
      branch: "",
    },
  ]);
});

function peer(
  version: string,
  opts: {
    reachable?: boolean;
    allowRemote?: boolean | null;
    activeJobs?: number;
  } = {},
): NodeDirectoryEntry {
  const reachable = opts.reachable ?? true;
  const allowRemote = opts.allowRemote === undefined ? true : opts.allowRemote;
  const info = {
    deviceId: "d".repeat(64),
    name: "peer",
    daemonVersion: version,
    protocolVersion: "0.4.0",
    platform: "win32",
    roles: ["execution"],
    executors: ["command"],
    models: [],
    hardware: { cpu: "x", ramBytes: 1, gpus: [] },
    maxConcurrentJobs: 2,
    activeJobs: opts.activeJobs ?? 0,
    ...(allowRemote === null ? {} : { upgrade: { allowRemote } }),
  };
  return {
    deviceId: "d".repeat(64),
    name: "peer",
    reachable,
    ...(reachable ? { nodeInfo: info } : {}),
  } as NodeDirectoryEntry;
}

describe("compareVersions", () => {
  test("orders strict X.Y.Z; non-semver sorts lowest", () => {
    expect(compareVersions("0.5.9", "0.6.0")).toBe(-1);
    expect(compareVersions("0.6.0", "0.6.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("x", "0.1.0")).toBe(-1);
    expect(compareVersions("0.1.0", "x")).toBe(1);
    expect(compareVersions("x", "y")).toBe(0);
  });
});

describe("upgrade eligibility", () => {
  const up = (n: NodeDirectoryEntry, target: string | undefined = "0.6.0") =>
    nodeRows([n], "0.6.0", target)[0]?.upgrade;

  test("reachable older peer with allowRemote is eligible", () => {
    expect(up(peer("0.5.2"))).toEqual({
      eligible: true,
      label: "⬆ 0.6.0 available",
      why: "",
    });
  });
  test("allowRemote off: no label, says why", () => {
    expect(up(peer("0.5.2", { allowRemote: false }))).toEqual({
      eligible: false,
      label: "",
      why: "remote upgrades off",
    });
  });
  test("peer without the upgrade field is too old", () => {
    expect(up(peer("0.3.0", { allowRemote: null }))).toEqual({
      eligible: false,
      label: "",
      why: "too old for remote upgrade",
    });
  });
  test("unreachable peer is not eligible", () => {
    expect(up(peer("0.5.2", { reachable: false }))?.eligible).toBe(false);
  });
  test("peer at or above the target is not eligible", () => {
    expect(up(peer("0.6.0"))?.eligible).toBe(false);
    expect(up(peer("0.7.0"))?.eligible).toBe(false);
  });
  test("exposes fullId, allowRemote and activeJobs", () => {
    const row = nodeRows(
      [peer("0.5.2", { activeJobs: 3 })],
      "0.6.0",
      "0.6.0",
    )[0];
    expect(row?.fullId).toBe("d".repeat(64));
    expect(row?.allowRemote).toBe(true);
    expect(row?.activeJobs).toBe(3);
  });
  test("a non-semver daemonVersion is never eligible (no downgrade offer)", () => {
    expect(up(peer("dev-build"))).toEqual({
      eligible: false,
      label: "",
      why: "unknown version",
    });
    expect(
      selfUpgrade({ daemonVersion: "dev-build", availableUpgrade: "0.6.0" }),
    ).toEqual({ eligible: false, label: "", why: "unknown version" });
  });
  test("selfUpgrade compares status version to availableUpgrade", () => {
    expect(
      selfUpgrade({ daemonVersion: "0.5.2", availableUpgrade: "0.6.0" }),
    ).toEqual({ eligible: true, label: "⬆ 0.6.0 available", why: "" });
    expect(selfUpgrade({ daemonVersion: "0.6.0" }).eligible).toBe(false);
    expect(
      selfUpgrade({ daemonVersion: "0.6.0", availableUpgrade: "0.6.0" }).label,
    ).toBe("");
  });
});

describe("confirmSummary", () => {
  const prepared = {
    current: "0.5.2",
    target: "0.6.0",
    verified: true as const,
    size: 5,
  };
  const row = (name: string, eligible: boolean, activeJobs = 0, why = "") => ({
    name,
    activeJobs,
    upgrade: { eligible, label: "", why },
  });
  const base = {
    prepared,
    peers: [row("tower", true)],
    self: { included: false, version: "0.5.2", activeJobs: 0 },
    forceSelf: false,
  };

  test("lists the verified line and peer outcomes", () => {
    const s = confirmSummary({
      ...base,
      peers: [
        row("tower", true),
        row("busy", true, 2),
        row("old", false, 0, "too old for remote upgrade"),
      ],
    });
    expect(s.canConfirm).toBe(true);
    expect(s.lines).toEqual([
      "v0.6.0 — signature verified",
      "tower: will upgrade",
      "busy: busy (2 jobs) — will be refused",
      "old: not eligible (too old for remote upgrade)",
    ]);
  });
  test("job counts are pluralized", () => {
    const busy = (n: number) =>
      confirmSummary({ ...base, peers: [row("b", true, n)] }).lines.at(-1);
    expect(busy(1)).toBe("b: busy (1 job) — will be refused");
    expect(busy(2)).toBe("b: busy (2 jobs) — will be refused");
  });
  test("self lines: idle, busy, forced, already current", () => {
    const withSelf = (self: object, forceSelf = false) =>
      confirmSummary({
        ...base,
        forceSelf,
        self: { included: true, version: "0.5.2", activeJobs: 0, ...self },
      }).lines.at(-1);
    expect(withSelf({})).toBe("This node: will upgrade last");
    expect(withSelf({ activeJobs: 1 })).toBe(
      "This node: busy (1 job) — will be refused unless forced",
    );
    expect(withSelf({ activeJobs: 1 }, true)).toBe(
      "This node: will upgrade last (forced)",
    );
    expect(withSelf({ version: "0.6.0" })).toBe("This node: already on 0.6.0");
  });
  test("error blocks confirmation and is the only line", () => {
    expect(confirmSummary({ ...base, error: "no release" })).toEqual({
      title: "Upgrade failed to prepare",
      lines: ["no release"],
      canConfirm: false,
    });
  });
  test("no eligible target blocks confirmation", () => {
    expect(
      confirmSummary({ ...base, peers: [row("old", false, 0, "unreachable")] })
        .canConfirm,
    ).toBe(false);
    expect(
      confirmSummary({
        ...base,
        peers: [],
        self: { included: true, version: "0.6.0", activeJobs: 0 },
      }).canConfirm,
    ).toBe(false);
  });
});

describe("progressRows", () => {
  test("peers then this node, with reasons; [] for null", () => {
    expect(progressRows(null)).toEqual([]);
    expect(
      progressRows({
        id: "r",
        target: "0.6.0",
        startedAt: "2026-10-23T00:00:00.000Z",
        state: "running",
        peers: [
          { deviceId: "a", name: "tower", state: "refused", reason: "busy" },
          { deviceId: "b", name: "nuc", state: "succeeded" },
        ],
        self: { state: "pending" },
      }),
    ).toEqual([
      { name: "tower", state: "refused", reason: "busy" },
      { name: "nuc", state: "succeeded", reason: "" },
      { name: "This node", state: "pending", reason: "" },
    ]);
  });
});

describe("startOutcome", () => {
  test("locked means already running; anything else is an error", () => {
    expect(startOutcome({ status: 409, code: "locked", message: "x" })).toEqual(
      { kind: "already-running" },
    );
    expect(startOutcome({ status: 500, message: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
  });
});

describe("reloadDecision", () => {
  const base = {
    loadedVersion: "0.5.2",
    statusVersion: "0.5.2",
    badToken: false,
    lastReloadAt: 0,
    now: 60_000,
  };
  test("version change or bad token reloads", () => {
    expect(reloadDecision({ ...base, statusVersion: "0.6.0" })).toBe(true);
    expect(reloadDecision({ ...base, badToken: true })).toBe(true);
  });
  test("throttled within 10 s; no change means no reload", () => {
    expect(
      reloadDecision({ ...base, badToken: true, lastReloadAt: 55_000 }),
    ).toBe(false);
    expect(reloadDecision(base)).toBe(false);
  });
});

describe("versionCell", () => {
  const cell = (version: string, skew: boolean, eligible: boolean) =>
    versionCell({
      version,
      skew,
      upgrade: {
        eligible,
        label: eligible ? "⬆ 0.6.1 available" : "",
      },
    });
  test("eligible row gets the badge even when not skewed", () => {
    expect(cell("0.5.2", false, true)).toEqual({
      text: "0.5.2 ⬆ 0.6.1 available",
      className: "badge",
    });
    expect(cell("0.4.0", true, true).className).toBe("badge");
  });
  test("skewed, ineligible row keeps the suffix and warn", () => {
    expect(cell("0.4.0", true, false)).toEqual({
      text: "0.4.0 (differs from ours)",
      className: "warn",
    });
  });
  test("neither: plain version", () => {
    expect(cell("0.5.2", false, false)).toEqual({
      text: "0.5.2",
      className: undefined,
    });
  });
});

describe("restartBannerState", () => {
  const rollout = (state: string, self: string) =>
    ({ state, self: { state: self }, peers: [] }) as never;
  test("shows only for a restarting self or a poll failure after a confirmed self/fleet start", () => {
    expect(
      restartBannerState({
        confirmedSelfOrFleet: true,
        rollout: rollout("running", "restarting"),
        pollFailed: false,
      }),
    ).toBe(true);
    expect(
      restartBannerState({
        confirmedSelfOrFleet: true,
        rollout: null,
        pollFailed: true,
      }),
    ).toBe(true);
  });
  test("no banner when self was refused, the rollout stopped, or nothing failed", () => {
    expect(
      restartBannerState({
        confirmedSelfOrFleet: true,
        rollout: rollout("done", "refused"),
        pollFailed: false,
      }),
    ).toBe(false);
    expect(
      restartBannerState({
        confirmedSelfOrFleet: true,
        rollout: rollout("stopped", "pending"),
        pollFailed: false,
      }),
    ).toBe(false);
    expect(
      restartBannerState({
        confirmedSelfOrFleet: false,
        rollout: null,
        pollFailed: true,
      }),
    ).toBe(false);
  });
});
