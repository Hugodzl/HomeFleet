/**
 * `unpairPeer` (the control API's unpair step list) against minimal fakes:
 * step order, not-paired, and the two failure postures (trust persist
 * failure -> revoked in memory + status 500; known-nodes failure swallowed).
 * The HTTP route is covered in control-server.test.ts; the assembled
 * behavior in daemon.control.integration.test.ts.
 */
import { expect, test } from "vitest";
import { unpairPeer } from "./daemon.js";

const PEER = "b".repeat(64);

function fakes(
  options: { removeThrows?: boolean; forgetThrows?: boolean } = {},
) {
  const calls: string[] = [];
  const devices = [
    { deviceId: PEER, name: "peer", addedAt: "2026-09-25T00:00:00.000Z" },
  ];
  return {
    calls,
    trustStore: {
      list: () => devices.map((d) => ({ ...d })),
      remove: async (id: string) => {
        calls.push(`trust.remove:${id}`);
        if (options.removeThrows) {
          throw new Error("EPERM: disk says no");
        }
        return true;
      },
    },
    jobManager: {
      cancelOwnedBy: (id: string) => {
        calls.push(`jobs.cancelOwnedBy:${id}`);
        return 2;
      },
    },
    knownNodes: {
      remove: async (id: string) => {
        calls.push(`known.remove:${id}`);
        if (options.forgetThrows) {
          throw new Error("known-nodes write failed");
        }
        return true;
      },
    },
  };
}

test("revokes trust first, then cancels owned jobs, then forgets the node", async () => {
  const f = fakes();
  const summary = await unpairPeer({ ...f, deviceId: PEER });
  expect(summary).toEqual({ deviceId: PEER, name: "peer", canceledJobs: 2 });
  expect(f.calls).toEqual([
    `trust.remove:${PEER}`,
    `jobs.cancelOwnedBy:${PEER}`,
    `known.remove:${PEER}`,
  ]);
});

test("a device that is not paired resolves undefined and touches nothing", async () => {
  const f = fakes();
  expect(await unpairPeer({ ...f, deviceId: "c".repeat(64) })).toBeUndefined();
  expect(f.calls).toEqual([]);
});

test("a trust persist failure still cuts the peer off, then throws status 500", async () => {
  const f = fakes({ removeThrows: true });
  const failure = await unpairPeer({ ...f, deviceId: PEER }).catch((e) => e);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { status?: number }).status).toBe(500);
  expect((failure as Error).message).toMatch(/not saved/);
  expect((failure as Error).message).toMatch(/restart/);
  expect((failure as Error).message).toContain("EPERM: disk says no");
  expect((failure as Error).cause).toBeInstanceOf(Error);
  expect(((failure as Error).cause as Error).message).toBe(
    "EPERM: disk says no",
  );
  expect(f.calls).toEqual([
    `trust.remove:${PEER}`,
    `jobs.cancelOwnedBy:${PEER}`,
    `known.remove:${PEER}`,
  ]);
});

test("a known-nodes failure does not fail the unpair", async () => {
  const f = fakes({ forgetThrows: true });
  const summary = await unpairPeer({ ...f, deviceId: PEER });
  expect(summary?.canceledJobs).toBe(2);
});
