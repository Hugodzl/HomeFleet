import { describe, expect, test } from "vitest";
import {
  DEFAULT_DELEGATION_LIST_LIMIT,
  DelegationRegistry,
  MAX_TRACKED_DELEGATIONS,
} from "./delegation-registry.js";

const route = (n: number) => ({
  deviceId: "d".repeat(64),
  host: "127.0.0.1",
  port: 40000 + n,
  repoId: "repo-x",
});

describe("DelegationRegistry", () => {
  test("records and looks up a delegated job's route", () => {
    const registry = new DelegationRegistry();
    registry.record("job-1", route(1), "command");
    expect(registry.lookup("job-1")).toEqual(route(1));
  });

  test("an unknown jobId looks up to undefined (caller returns a clean error)", () => {
    const registry = new DelegationRegistry();
    expect(registry.lookup("never-recorded")).toBeUndefined();
  });

  test("re-recording a jobId replaces its route and refreshes recency", () => {
    const registry = new DelegationRegistry();
    registry.record("job-1", route(1), "command");
    registry.record("job-1", route(2), "command");
    expect(registry.lookup("job-1")).toEqual(route(2));
    expect(registry.size).toBe(1);
  });

  test("evicts the oldest entry once the cap is exceeded (bounded state)", () => {
    const registry = new DelegationRegistry();
    for (let i = 0; i < MAX_TRACKED_DELEGATIONS; i += 1) {
      registry.record(`job-${i}`, route(i), "command");
    }
    expect(registry.size).toBe(MAX_TRACKED_DELEGATIONS);
    // One over the cap evicts the oldest (job-0).
    registry.record("job-overflow", route(9999), "command");
    expect(registry.size).toBe(MAX_TRACKED_DELEGATIONS);
    expect(registry.lookup("job-0")).toBeUndefined();
    expect(registry.lookup("job-1")).toBeDefined();
    expect(registry.lookup("job-overflow")).toBeDefined();
  });

  test("recordApplied remembers a write job's applied artifact until the entry is evicted", () => {
    const registry = new DelegationRegistry();
    registry.record("job-w", route(1), "write");
    expect(registry.appliedArtifact("job-w")).toBeUndefined();

    const applied = {
      branchName: "homefleet/abcdefabcdef",
      baseCommit: "a".repeat(40),
    };
    registry.recordApplied("job-w", applied);
    expect(registry.appliedArtifact("job-w")).toEqual(applied);
    // A copy, not the live object: mutating the result must not corrupt state.
    const got = registry.appliedArtifact("job-w");
    if (got !== undefined) {
      got.branchName = "mutated";
    }
    expect(registry.appliedArtifact("job-w")?.branchName).toBe(
      "homefleet/abcdefabcdef",
    );
  });

  test("recordApplied for an untracked jobId is a no-op (evicted entries stay evicted)", () => {
    const registry = new DelegationRegistry();
    registry.recordApplied("never-recorded", {
      branchName: "homefleet/abcdefabcdef",
      baseCommit: "a".repeat(40),
    });
    expect(registry.appliedArtifact("never-recorded")).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test("singleFlightApply shares ONE in-flight run between overlapping callers, then allows a fresh one", async () => {
    const registry = new DelegationRegistry();
    let runs = 0;
    let release: (value: string) => void = () => {};
    const slow = (): Promise<string> => {
      runs += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };

    const first = registry.singleFlightApply("job-1", slow);
    const second = registry.singleFlightApply("job-1", slow);
    // A different jobId is its own flight, never joined to job-1's.
    const other = registry.singleFlightApply("job-2", async () => "other");
    release("applied");

    expect(await first).toBe("applied");
    expect(await second).toBe("applied");
    expect(await other).toBe("other");
    expect(runs).toBe(1);

    // Settled: the next call starts a FRESH run (retry semantics).
    expect(
      await registry.singleFlightApply("job-1", async () => "retried"),
    ).toBe("retried");
    expect(runs).toBe(1);
  });

  test("re-recording an existing job protects it from eviction (moves to newest)", () => {
    const registry = new DelegationRegistry();
    registry.record("keep-me", route(1), "command");
    for (let i = 0; i < MAX_TRACKED_DELEGATIONS - 1; i += 1) {
      registry.record(`job-${i}`, route(i), "command");
    }
    // Touch keep-me so it is now the most-recent entry.
    registry.record("keep-me", route(2), "command");
    // Two more inserts evict the two oldest (job-0, job-1), not keep-me.
    registry.record("extra-1", route(101), "command");
    registry.record("extra-2", route(102), "command");
    expect(registry.lookup("keep-me")).toEqual(route(2));
    expect(registry.lookup("job-0")).toBeUndefined();
  });

  test("record stamps type, recordedAt and an initial queued status", () => {
    let now = 1_000;
    const registry = new DelegationRegistry({ now: () => now });
    registry.record("job-1", route(1), "write");
    now = 2_000;
    expect(registry.list()).toEqual([
      {
        jobId: "job-1",
        type: "write",
        deviceId: route(1).deviceId,
        repoId: "repo-x",
        recordedAt: 1_000,
        lastStatus: "queued",
        lastStatusAt: 1_000,
      },
    ]);
  });

  test("observeStatus updates lastStatus/lastStatusAt; unknown ids are a no-op", () => {
    let now = 1_000;
    const registry = new DelegationRegistry({ now: () => now });
    registry.record("job-1", route(1), "command");
    now = 5_000;
    registry.observeStatus("job-1", "succeeded");
    registry.observeStatus("never-recorded", "failed");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toMatchObject({
      lastStatus: "succeeded",
      lastStatusAt: 5_000,
    });
  });

  test("list is newest first, includes the applied branch, and honours the limit", () => {
    const registry = new DelegationRegistry();
    registry.record("job-a", route(1), "command");
    registry.record("job-b", route(2), "write");
    registry.recordApplied("job-b", {
      branchName: "homefleet/job-b",
      baseCommit: "c".repeat(40),
    });
    expect(registry.list().map((d) => d.jobId)).toEqual(["job-b", "job-a"]);
    expect(registry.list()[0]?.appliedBranch).toBe("homefleet/job-b");
    expect(registry.list(1).map((d) => d.jobId)).toEqual(["job-b"]);
  });

  test("list defaults to the newest DEFAULT_DELEGATION_LIST_LIMIT entries", () => {
    const registry = new DelegationRegistry();
    for (let i = 0; i < DEFAULT_DELEGATION_LIST_LIMIT + 5; i += 1) {
      registry.record(`job-${i}`, route(i), "command");
    }
    const listed = registry.list();
    expect(listed).toHaveLength(DEFAULT_DELEGATION_LIST_LIMIT);
    expect(listed[0]?.jobId).toBe(`job-${DEFAULT_DELEGATION_LIST_LIMIT + 4}`);
  });
});
