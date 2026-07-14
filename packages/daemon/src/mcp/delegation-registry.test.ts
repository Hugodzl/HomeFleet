import { describe, expect, test } from "vitest";
import {
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
    registry.record("job-1", route(1));
    expect(registry.lookup("job-1")).toEqual(route(1));
  });

  test("an unknown jobId looks up to undefined (caller returns a clean error)", () => {
    const registry = new DelegationRegistry();
    expect(registry.lookup("never-recorded")).toBeUndefined();
  });

  test("re-recording a jobId replaces its route and refreshes recency", () => {
    const registry = new DelegationRegistry();
    registry.record("job-1", route(1));
    registry.record("job-1", route(2));
    expect(registry.lookup("job-1")).toEqual(route(2));
    expect(registry.size).toBe(1);
  });

  test("evicts the oldest entry once the cap is exceeded (bounded state)", () => {
    const registry = new DelegationRegistry();
    for (let i = 0; i < MAX_TRACKED_DELEGATIONS; i += 1) {
      registry.record(`job-${i}`, route(i));
    }
    expect(registry.size).toBe(MAX_TRACKED_DELEGATIONS);
    // One over the cap evicts the oldest (job-0).
    registry.record("job-overflow", route(9999));
    expect(registry.size).toBe(MAX_TRACKED_DELEGATIONS);
    expect(registry.lookup("job-0")).toBeUndefined();
    expect(registry.lookup("job-1")).toBeDefined();
    expect(registry.lookup("job-overflow")).toBeDefined();
  });

  test("recordApplied remembers a write job's applied artifact until the entry is evicted", () => {
    const registry = new DelegationRegistry();
    registry.record("job-w", route(1));
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

  test("re-recording an existing job protects it from eviction (moves to newest)", () => {
    const registry = new DelegationRegistry();
    registry.record("keep-me", route(1));
    for (let i = 0; i < MAX_TRACKED_DELEGATIONS - 1; i += 1) {
      registry.record(`job-${i}`, route(i));
    }
    // Touch keep-me so it is now the most-recent entry.
    registry.record("keep-me", route(2));
    // Two more inserts evict the two oldest (job-0, job-1), not keep-me.
    registry.record("extra-1", route(101));
    registry.record("extra-2", route(102));
    expect(registry.lookup("keep-me")).toEqual(route(2));
    expect(registry.lookup("job-0")).toBeUndefined();
  });
});
