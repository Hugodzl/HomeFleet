/**
 * Unit tests for `pairWithPeer` (the control API's outbound pairing
 * attempt — see the docstring in daemon.ts). Drives it against minimal fakes
 * for `HfpClient`/`TrustStore`/`KnownNodesRegistry` (only the one method each
 * actually used is faked, thanks to `pairWithPeer`'s `Pick<...>` parameter
 * types) rather than assembling a real daemon, since the point here is the
 * local accept/reject/persist-failure/seeding branching, not any real
 * transport or disk I/O (those are covered where they live: client.test.ts,
 * trust-store.test.ts, known-nodes.test.ts).
 */
import type { NodeInfo } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { pairWithPeer } from "./daemon.js";
import type { KnownNode } from "./discovery/known-nodes.js";
import type { TrustedDevice } from "./trust/trust-store.js";

const FAKE_PEER_DEVICE_ID = "b".repeat(64);

const fakeNodeInfoProvider = (): NodeInfo => ({}) as NodeInfo;

const baseInput = { host: "192.168.1.50", port: 56370, code: "ABCDEFGH" };

/** A no-op fake `knownNodes` for tests that don't assert on seeding. */
const noopKnownNodes = { record: async () => {} };

test("on acceptance, adds the peer to the trust store, seeds knownNodes, and returns the summary", async () => {
  const added: TrustedDevice[] = [];
  const recorded: KnownNode[] = [];
  const summary = await pairWithPeer({
    hfpClient: {
      pair: async () => ({
        response: {
          accepted: true,
          nodeInfo: { name: "peer-node" } as NodeInfo,
        },
        serverDeviceId: FAKE_PEER_DEVICE_ID,
      }),
    },
    trustStore: {
      add: async (entry) => {
        added.push(entry);
      },
    },
    knownNodes: {
      record: async (entry) => {
        recorded.push(entry);
      },
    },
    nodeInfoProvider: fakeNodeInfoProvider,
    input: baseInput,
  });

  expect(summary).toEqual({
    accepted: true,
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer-node",
  });
  expect(added).toEqual([
    expect.objectContaining({
      deviceId: FAKE_PEER_DEVICE_ID,
      name: "peer-node",
    }),
  ]);
  // Seeded with the peer's HFP endpoint (the host:port this function just
  // dialed), not merely the trust-store fields, so NodeDirectory can reach
  // it without waiting on live mDNS/UDP discovery.
  expect(recorded).toEqual([
    expect.objectContaining({
      deviceId: FAKE_PEER_DEVICE_ID,
      name: "peer-node",
      host: baseInput.host,
      port: baseInput.port,
      source: "static",
    }),
  ]);
});

test("on rejection, resolves {accepted: false} and never touches the trust store or knownNodes", async () => {
  let addCalled = false;
  let recordCalled = false;
  const summary = await pairWithPeer({
    hfpClient: {
      pair: async () => ({
        response: { accepted: false },
        serverDeviceId: FAKE_PEER_DEVICE_ID,
      }),
    },
    trustStore: {
      add: async () => {
        addCalled = true;
      },
    },
    knownNodes: {
      record: async () => {
        recordCalled = true;
      },
    },
    nodeInfoProvider: fakeNodeInfoProvider,
    input: baseInput,
  });

  expect(summary).toEqual({ accepted: false });
  expect(addCalled).toBe(false);
  expect(recordCalled).toBe(false);
});

test("a thrown peer/transport error propagates unchanged (not lumped with local persist failures)", async () => {
  class FakeHfpRequestError extends Error {
    status = 400;
  }
  await expect(
    pairWithPeer({
      hfpClient: {
        pair: async () => {
          throw new FakeHfpRequestError("peer refused the connection");
        },
      },
      trustStore: { add: async () => {} },
      knownNodes: noopKnownNodes,
      nodeInfoProvider: fakeNodeInfoProvider,
      input: baseInput,
    }),
  ).rejects.toMatchObject({
    message: "peer refused the connection",
    status: 400,
  });
});

test("a local trust-store failure AFTER peer acceptance throws a distinguishable 500, not the raw store error", async () => {
  const storeError = new Error("ENOSPC: no space left on device");
  await expect(
    pairWithPeer({
      hfpClient: {
        pair: async () => ({
          response: {
            accepted: true,
            nodeInfo: { name: "peer-node" } as NodeInfo,
          },
          serverDeviceId: FAKE_PEER_DEVICE_ID,
        }),
      },
      trustStore: {
        add: async () => {
          throw storeError;
        },
      },
      knownNodes: noopKnownNodes,
      nodeInfoProvider: fakeNodeInfoProvider,
      input: baseInput,
    }),
  ).rejects.toMatchObject({
    // Distinguishable from the generic 502 `pairingErrorStatus` gives every
    // other thrown (peer/network) error, and from the store error's own
    // message — the caller needs to know the peer already accepted.
    status: 500,
    message: expect.stringContaining("peer accepted"),
  });
});

test("a knownNodes.record failure after acceptance is swallowed (best-effort seeding, not a source of truth)", async () => {
  const added: TrustedDevice[] = [];
  const summary = await pairWithPeer({
    hfpClient: {
      pair: async () => ({
        response: {
          accepted: true,
          nodeInfo: { name: "peer-node" } as NodeInfo,
        },
        serverDeviceId: FAKE_PEER_DEVICE_ID,
      }),
    },
    trustStore: {
      add: async (entry) => {
        added.push(entry);
      },
    },
    knownNodes: {
      record: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    },
    nodeInfoProvider: fakeNodeInfoProvider,
    input: baseInput,
  });

  // The pairing still succeeds: trust was already established by
  // `trustStore.add` above, and knownNodes is purely an accelerator — the
  // peer falls back to live discovery instead.
  expect(summary).toEqual({
    accepted: true,
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer-node",
  });
  expect(added).toHaveLength(1);
});
