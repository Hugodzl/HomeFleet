/**
 * Unit tests for `pairWithPeer` (the control API's outbound pairing
 * attempt — see the docstring in daemon.ts). Drives it against minimal fakes
 * for `HfpClient`/`TrustStore` (only the one method each actually used is
 * faked, thanks to `pairWithPeer`'s `Pick<...>` parameter types) rather than
 * assembling a real daemon, since the point here is the local
 * accept/reject/persist-failure branching, not any real transport or disk
 * I/O (those are covered where they live: client.test.ts, trust-store.test.ts).
 */
import type { NodeInfo } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { pairWithPeer } from "./daemon.js";
import type { TrustedDevice } from "./trust/trust-store.js";

const FAKE_PEER_DEVICE_ID = "b".repeat(64);

const fakeNodeInfoProvider = (): NodeInfo => ({}) as NodeInfo;

const baseInput = { host: "192.168.1.50", port: 56370, code: "ABCDEFGH" };

test("on acceptance, adds the peer to the trust store and returns the summary", async () => {
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
});

test("on rejection, resolves {accepted: false} and never touches the trust store", async () => {
  let addCalled = false;
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
    nodeInfoProvider: fakeNodeInfoProvider,
    input: baseInput,
  });

  expect(summary).toEqual({ accepted: false });
  expect(addCalled).toBe(false);
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
