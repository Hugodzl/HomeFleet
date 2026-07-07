import type { DiscoveryAnnouncement } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { FakeMdnsBackend } from "../test-fixtures.js";
import type { DiscoveryCandidate } from "./candidate.js";
import {
  decodeFoundService,
  encodeAnnouncementTxt,
  MAX_INSTANCE_LABEL_BYTES,
  MdnsDiscovery,
  truncateInstanceLabel,
} from "./mdns.js";

const deviceIdA = "aa".repeat(32);
const deviceIdB = "bb".repeat(32);

function announcement(
  deviceId: string,
  overrides: Partial<DiscoveryAnnouncement> = {},
): DiscoveryAnnouncement {
  return {
    deviceId,
    name: "tower",
    port: 47113,
    protocolVersion: "0.1.0",
    ...overrides,
  };
}

function startDiscovery(
  backend: FakeMdnsBackend,
  own: DiscoveryAnnouncement,
  now = () => 1_751_800_000_000,
): { discovery: MdnsDiscovery; candidates: DiscoveryCandidate[] } {
  const candidates: DiscoveryCandidate[] = [];
  const discovery = new MdnsDiscovery({
    backend,
    announcement: own,
    onCandidate: (candidate) => candidates.push(candidate),
    now,
  });
  discovery.start();
  return { discovery, candidates };
}

test("advertises the announcement as a homefleet service with TXT records", () => {
  const backend = new FakeMdnsBackend();
  const { discovery } = startDiscovery(backend, announcement(deviceIdA));

  expect(backend.publications).toHaveLength(1);
  expect(backend.publications[0]?.request).toEqual({
    name: "tower",
    type: "homefleet",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.1.0" },
  });
  return discovery.stop();
});

test("advertise -> browse round-trip through the fake surfaces a candidate", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));
  const b = startDiscovery(
    backend,
    announcement(deviceIdB, { name: "laptop", port: 47999 }),
  );

  // B sees A (published before B started browsing) and vice versa.
  expect(b.candidates).toContainEqual({
    deviceId: deviceIdA,
    name: "tower",
    host: "192.168.1.20",
    port: 47113,
    source: "mdns",
    lastSeenAt: 1_751_800_000_000,
  });
  expect(a.candidates).toContainEqual({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.20",
    port: 47999,
    source: "mdns",
    lastSeenAt: 1_751_800_000_000,
  });
  await a.discovery.stop();
  await b.discovery.stop();
});

test("ignores its own announcement echo", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));

  // The backend delivered A's own publication back to A's browser.
  expect(a.candidates).toEqual([]);
  await a.discovery.stop();
});

test("drops services whose TXT record fails validation", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));

  const base = {
    type: "homefleet",
    name: "peer",
    port: 47113,
    addresses: ["192.168.1.30"],
  };
  backend.deliver({ ...base, txt: {} }); // missing keys
  backend.deliver({ ...base, txt: { id: "not-hex", pv: "0.1.0" } });
  backend.deliver({ ...base, txt: { id: deviceIdB, pv: "not-semver" } });
  backend.deliver({
    ...base,
    txt: { id: Buffer.from(deviceIdB), pv: "0.1.0" }, // non-string value
  });

  expect(a.candidates).toEqual([]);
  await a.discovery.stop();
});

test("drops services with an out-of-range port or no usable address", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));
  const txt = { id: deviceIdB, pv: "0.1.0" };

  backend.deliver({
    type: "homefleet",
    name: "peer",
    port: 0,
    txt,
    addresses: ["192.168.1.30"],
  });
  backend.deliver({
    type: "homefleet",
    name: "peer",
    port: 47113,
    txt,
    addresses: [],
  });

  expect(a.candidates).toEqual([]);
  await a.discovery.stop();
});

test("prefers an IPv4 address but falls back to the first address", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));
  const txt = { id: deviceIdB, pv: "0.1.0" };

  backend.deliver({
    type: "homefleet",
    name: "peer",
    port: 47113,
    txt,
    addresses: ["fe80::1", "192.168.1.30"],
  });
  backend.deliver({
    type: "homefleet",
    name: "peer6",
    port: 47113,
    txt,
    addresses: ["fe80::2"],
  });

  expect(a.candidates.map((candidate) => candidate.host)).toEqual([
    "192.168.1.30",
    "fe80::2",
  ]);
  await a.discovery.stop();
});

test("truncates the instance name to 63 bytes without splitting a character", () => {
  expect(truncateInstanceLabel("x".repeat(64))).toBe("x".repeat(63));
  expect(truncateInstanceLabel("x".repeat(63))).toBe("x".repeat(63));
  // "é" is 2 bytes in UTF-8: 32 of them (64 bytes) must truncate to 31
  // characters (62 bytes), never to a split 63rd byte.
  const truncated = truncateInstanceLabel("é".repeat(32));
  expect(truncated).toBe("é".repeat(31));
  expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(
    MAX_INSTANCE_LABEL_BYTES,
  );
});

test("advertises a truncated instance name for a long node name", async () => {
  const backend = new FakeMdnsBackend();
  // 64 chars is a valid node name but 1 byte over the mDNS label limit.
  const a = startDiscovery(
    backend,
    announcement(deviceIdA, { name: "x".repeat(64) }),
  );
  expect(backend.publications[0]?.request.name).toBe("x".repeat(63));
  await a.discovery.stop();
});

test("a squatter with undecodable TXT under our name causes no rename", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));

  // Same instance name, but the TXT record does not decode: it could be a
  // mangled echo of our own advertisement, so renaming would risk chasing
  // ourselves. Ignore it — only a decodable, different deviceId is a
  // rename-worthy collision.
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: "not-a-device-id", pv: "0.1.0" },
    addresses: ["192.168.1.30"],
  });
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: {},
    addresses: ["192.168.1.30"],
  });

  expect(backend.publications).toHaveLength(1);
  expect(backend.publications[0]?.request.name).toBe("tower");
  expect(a.candidates).toEqual([]);
  await a.discovery.stop();
});

test("renames on a collision when the peer wins the tie-break", async () => {
  const backend = new FakeMdnsBackend();
  // Both nodes are named "tower". Deterministic tie-break: the node with
  // the lexicographically larger deviceId renames, so exactly one side
  // moves and the pair cannot rename-storm.
  const a = startDiscovery(backend, announcement(deviceIdA));
  const b = startDiscovery(backend, announcement(deviceIdB));

  const active = backend.activePublications();
  expect(active.map((publication) => publication.request.name).sort()).toEqual([
    "tower",
    "tower (2)",
  ]);
  // A (smaller deviceId) kept its name; B renamed.
  expect(active.find((p) => p.request.txt.id === deviceIdA)?.request.name).toBe(
    "tower",
  );
  expect(active.find((p) => p.request.txt.id === deviceIdB)?.request.name).toBe(
    "tower (2)",
  );
  // Both still surfaced each other as candidates.
  expect(a.candidates.some((c) => c.deviceId === deviceIdB)).toBe(true);
  expect(b.candidates.some((c) => c.deviceId === deviceIdA)).toBe(true);
  await a.discovery.stop();
  await b.discovery.stop();
});

test("a renamed instance keeps the label within 63 bytes", async () => {
  const backend = new FakeMdnsBackend();
  const longName = "x".repeat(64);
  const a = startDiscovery(
    backend,
    announcement(deviceIdB, { name: longName }),
  );
  // A peer with the same (truncated) label and a smaller deviceId forces a
  // rename.
  backend.deliver({
    type: "homefleet",
    name: "x".repeat(63),
    port: 47113,
    txt: { id: deviceIdA, pv: "0.1.0" },
    addresses: ["192.168.1.30"],
  });

  const renamed = backend.activePublications()[0]?.request.name;
  expect(renamed).toBe(`${"x".repeat(59)} (2)`);
  expect(Buffer.byteLength(renamed ?? "", "utf8")).toBeLessThanOrEqual(
    MAX_INSTANCE_LABEL_BYTES,
  );
  await a.discovery.stop();
});

test("encodeAnnouncementTxt / decodeFoundService round-trip", () => {
  const own = announcement(deviceIdA, { name: "tower", port: 47113 });
  const txt = encodeAnnouncementTxt(own);
  expect(txt).toEqual({ id: deviceIdA, pv: "0.1.0" });
  expect(
    decodeFoundService({
      type: "homefleet",
      name: "tower",
      port: 47113,
      txt,
      addresses: [],
    }),
  ).toEqual(own);
  expect(
    decodeFoundService({
      type: "homefleet",
      name: "tower",
      port: 47113,
      txt: { pv: "0.1.0" },
      addresses: [],
    }),
  ).toBeNull();
});

test("stop tears down the publication, browser, and backend", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));

  await a.discovery.stop();
  expect(backend.activePublications()).toEqual([]);
  expect(backend.browsers.every((browser) => browser.stopped)).toBe(true);
  expect(backend.destroyed).toBe(true);

  // Idempotent, and no candidates after stop.
  await a.discovery.stop();
  backend.deliver({
    type: "homefleet",
    name: "late",
    port: 47113,
    txt: { id: deviceIdB, pv: "0.1.0" },
    addresses: ["192.168.1.30"],
  });
  expect(a.candidates).toEqual([]);
});
