import { type PairRequest, PairRequestSchema } from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import {
  makeNodeInfo,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import { TrustStore } from "../trust/trust-store.js";
import {
  DEFAULT_PAIRING_TTL_MS,
  generatePairingCode,
  MAX_PAIRING_FAILURES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingManager,
} from "./pairing.js";

// --- generatePairingCode -----------------------------------------------

test("pairing codes are 8 chars of uppercase alphanumerics", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generatePairingCode();
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
  }
});

test("pairing codes never contain the ambiguous chars 0, O, 1, I", () => {
  expect(PAIRING_CODE_ALPHABET).not.toMatch(/[0O1I]/);
  for (let i = 0; i < 200; i += 1) {
    const code = generatePairingCode();
    expect(code).not.toMatch(/[0O1I]/);
    for (const char of code) {
      expect(PAIRING_CODE_ALPHABET).toContain(char);
    }
  }
});

test("pairing codes satisfy the protocol PairRequestSchema code pattern", () => {
  const ownDeviceId = "c0de".repeat(16);
  for (let i = 0; i < 20; i += 1) {
    const request = {
      code: generatePairingCode(),
      nodeInfo: makeNodeInfo(ownDeviceId, "self"),
    };
    expect(PairRequestSchema.safeParse(request).success).toBe(true);
  }
});

test("pairing codes do not repeat over a sample", () => {
  const sample = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    sample.add(generatePairingCode());
  }
  // 32^8 = 2^40 combinations; 1000 draws colliding would indicate broken
  // randomness, not bad luck.
  expect(sample.size).toBe(1000);
});

// --- PairingManager -----------------------------------------------------

const OWN_DEVICE_ID = "c0de".repeat(16);
const PEER_DEVICE_ID = "ab".repeat(32);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

async function makeManager(): Promise<{
  manager: PairingManager;
  trustStore: TrustStore;
  clock: { now: number };
}> {
  const dir = await makeTempDataDir("homefleet-pairing-");
  tempDirs.push(dir);
  const trustStore = await TrustStore.load(dir);
  const clock = { now: 1_000_000 };
  const manager = new PairingManager({
    trustStore,
    nodeInfoProvider: () => makeNodeInfo(OWN_DEVICE_ID, "self"),
    now: () => clock.now,
  });
  return { manager, trustStore, clock };
}

function peerRequest(code: string): PairRequest {
  return { code, nodeInfo: makeNodeInfo(PEER_DEVICE_ID, "peer") };
}

test("accepts the correct code, trusts the peer, and returns own nodeInfo", async () => {
  const { manager, trustStore, clock } = await makeManager();
  const { code, expiresAt } = manager.beginPairing();
  expect(expiresAt).toBe(clock.now + DEFAULT_PAIRING_TTL_MS);

  const response = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(response.accepted).toBe(true);
  expect(response.nodeInfo?.deviceId).toBe(OWN_DEVICE_ID);
  expect(trustStore.has(PEER_DEVICE_ID)).toBe(true);
  expect(trustStore.list()).toEqual([
    {
      deviceId: PEER_DEVICE_ID,
      name: "peer",
      addedAt: new Date(clock.now).toISOString(),
    },
  ]);
});

test("rejects a wrong code without touching the trust store", async () => {
  const { manager, trustStore } = await makeManager();
  const { code } = manager.beginPairing();
  const wrong = code === "ABCDEFGH" ? "ABCDEFGJ" : "ABCDEFGH";

  const response = await manager.handlePairRequest(
    peerRequest(wrong),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(response).toEqual({ accepted: false });
  expect(trustStore.list()).toEqual([]);
});

test("rejects when no pairing window is active", async () => {
  const { manager } = await makeManager();
  const response = await manager.handlePairRequest(
    peerRequest("ABCDEFGH"),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(response).toEqual({ accepted: false });
});

test("rejects an expired code (and accepts right up to the boundary)", async () => {
  const { manager, clock } = await makeManager();
  const { code } = manager.beginPairing(1000);

  clock.now += 999; // 1ms before expiry: still valid
  const justInTime = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(justInTime.accepted).toBe(true);

  const { code: secondCode } = manager.beginPairing(1000);
  clock.now += 1000; // exactly at expiry: no longer valid
  const tooLate = await manager.handlePairRequest(
    peerRequest(secondCode),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(tooLate).toEqual({ accepted: false });
});

test("a code is single-use: replaying it after acceptance is rejected", async () => {
  const { manager } = await makeManager();
  const { code } = manager.beginPairing();

  const first = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(first.accepted).toBe(true);

  const replay = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(replay).toEqual({ accepted: false });
});

test("five wrong attempts invalidate the active code (brute-force guard)", async () => {
  const { manager } = await makeManager();
  const { code } = manager.beginPairing();
  const wrong = code === "ABCDEFGH" ? "ABCDEFGJ" : "ABCDEFGH";

  for (let i = 0; i < MAX_PAIRING_FAILURES; i += 1) {
    const rejected = await manager.handlePairRequest(
      peerRequest(wrong),
      PEER_DEVICE_ID,
      "peer",
    );
    expect(rejected).toEqual({ accepted: false });
  }

  // Even the correct code is now dead.
  const afterGuard = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(afterGuard).toEqual({ accepted: false });
});

test("four wrong attempts do not invalidate the code", async () => {
  const { manager } = await makeManager();
  const { code } = manager.beginPairing();
  const wrong = code === "ABCDEFGH" ? "ABCDEFGJ" : "ABCDEFGH";

  for (let i = 0; i < MAX_PAIRING_FAILURES - 1; i += 1) {
    await manager.handlePairRequest(peerRequest(wrong), PEER_DEVICE_ID, "peer");
  }
  const stillValid = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(stillValid.accepted).toBe(true);
});

test("beginPairing replaces any previous code", async () => {
  const { manager } = await makeManager();
  const { code: oldCode } = manager.beginPairing();
  const { code: newCode } = manager.beginPairing();

  const withOld = await manager.handlePairRequest(
    peerRequest(oldCode),
    PEER_DEVICE_ID,
    "peer",
  );
  // The old code only works in the astronomically unlikely event the two
  // random codes collided.
  if (oldCode !== newCode) {
    expect(withOld).toEqual({ accepted: false });
  }
  const withNew = await manager.handlePairRequest(
    peerRequest(newCode),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(withNew.accepted).toBe(true);
});

test("cancelPairing invalidates the active code", async () => {
  const { manager } = await makeManager();
  const { code } = manager.beginPairing();
  manager.cancelPairing();
  const response = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(response).toEqual({ accepted: false });
});

test("rejects when the claimed deviceId does not match the TLS fingerprint", async () => {
  const { manager, trustStore } = await makeManager();
  const { code } = manager.beginPairing();

  // Request claims PEER_DEVICE_ID, but the TLS layer saw a different cert.
  const tlsObserved = "ef".repeat(32);
  const spoofed = await manager.handlePairRequest(
    peerRequest(code),
    tlsObserved,
    "peer",
  );
  expect(spoofed).toEqual({ accepted: false });
  expect(trustStore.list()).toEqual([]);

  // The mismatch neither consumed nor burned the code: an honest request
  // still succeeds.
  const honest = await manager.handlePairRequest(
    peerRequest(code),
    PEER_DEVICE_ID,
    "peer",
  );
  expect(honest.accepted).toBe(true);
});
