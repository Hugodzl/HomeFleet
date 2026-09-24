import { describe, expect, test } from "vitest";
import type { ControlJobs, ControlStatus } from "../control/control-server.js";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import {
  delegatedJobRows,
  modelRows,
  nodeRows,
  relativeTime,
  selfRows,
  shortId,
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
