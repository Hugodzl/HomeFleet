import type { DiscoveryAnnouncement } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { FakeMdnsBackend } from "../test-fixtures.js";
import type { DiscoveryCandidate } from "./candidate.js";
import {
  decodeFoundService,
  encodeAnnouncementTxt,
  MAX_INSTANCE_LABEL_BYTES,
  MdnsDiscovery,
  SELF_ECHO_DEADLINE_MS,
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
    protocolVersion: "0.3.0",
    ...overrides,
  };
}

/**
 * Manual timers for the self-echo watchdog: `fire()` runs (and clears)
 * every pending callback, standing in for the deadline elapsing.
 */
interface FakeTimers {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  fire(): void;
  pendingCount(): number;
  lastDelayMs: number | null;
}

function fakeTimers(): FakeTimers {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const timers: FakeTimers = {
    lastDelayMs: null,
    schedule(callback, delayMs) {
      timers.lastDelayMs = delayMs;
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancel(handle) {
      pending.delete(handle as number);
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
  return timers;
}

function startDiscovery(
  backend: FakeMdnsBackend,
  own: DiscoveryAnnouncement,
  now = () => 1_751_800_000_000,
  timers?: FakeTimers,
): {
  discovery: MdnsDiscovery;
  candidates: DiscoveryCandidate[];
  diagnostics: string[];
} {
  const candidates: DiscoveryCandidate[] = [];
  const diagnostics: string[] = [];
  const discovery = new MdnsDiscovery({
    backend,
    announcement: own,
    onCandidate: (candidate) => candidates.push(candidate),
    onDiagnostic: (message) => diagnostics.push(message),
    now,
    timers,
  });
  discovery.start();
  return { discovery, candidates, diagnostics };
}

test("advertises the announcement as a homefleet service with TXT records", () => {
  const backend = new FakeMdnsBackend();
  const { discovery } = startDiscovery(backend, announcement(deviceIdA));

  expect(backend.publications).toHaveLength(1);
  expect(backend.publications[0]?.request).toEqual({
    name: "tower",
    type: "homefleet",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
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
  backend.deliver({ ...base, txt: { id: "not-hex", pv: "0.3.0" } });
  backend.deliver({ ...base, txt: { id: deviceIdB, pv: "not-semver" } });
  backend.deliver({
    ...base,
    txt: { id: Buffer.from(deviceIdB), pv: "0.3.0" }, // non-string value
  });

  expect(a.candidates).toEqual([]);
  await a.discovery.stop();
});

test("drops services with an out-of-range port or no usable address", async () => {
  const backend = new FakeMdnsBackend();
  const a = startDiscovery(backend, announcement(deviceIdA));
  const txt = { id: deviceIdB, pv: "0.3.0" };

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
  const txt = { id: deviceIdB, pv: "0.3.0" };

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
    txt: { id: "not-a-device-id", pv: "0.3.0" },
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
    txt: { id: deviceIdA, pv: "0.3.0" },
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
  expect(txt).toEqual({ id: deviceIdA, pv: "0.3.0" });
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
      txt: { pv: "0.3.0" },
      addresses: [],
    }),
  ).toBeNull();
});

test("renames when its own echo never confirms the publication", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // Probe-death: the "tower" publication silently loses its probe and is
  // never announced, so no browser (ours included) ever sees it.
  backend.suppressDelivery = (request) => request.name === "tower";
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);

  expect(timers.pendingCount()).toBe(1);
  expect(timers.lastDelayMs).toBe(SELF_ECHO_DEADLINE_MS);
  timers.fire();

  // The dead publication was stopped and republished under the next label;
  // the new label's echo did arrive, confirming it (no timer left).
  expect(backend.publications[0]?.stopped).toBe(true);
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower (2)",
  ]);
  expect(timers.pendingCount()).toBe(0);
  await a.discovery.stop();
});

test("its own echo confirms the publication and no watchdog rename happens", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);

  // The fake echoed the publication back during start(): confirmed, timer
  // cancelled, and firing what's left (nothing) renames nothing.
  expect(timers.pendingCount()).toBe(0);
  timers.fire();
  expect(backend.publications).toHaveLength(1);
  expect(backend.publications[0]?.request.name).toBe("tower");
  await a.discovery.stop();
});

test("a stale echo of a pre-rename name does not confirm the current publication", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  backend.suppressDelivery = () => true;
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);
  timers.fire(); // probe-death rename: now "tower (2)", watchdog re-armed

  // A late echo of the OLD name arrives — it proves nothing about the
  // current publication and must not confirm it.
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
    addresses: ["192.168.1.20"],
  });
  expect(timers.pendingCount()).toBe(1);

  // The current name's echo is what confirms.
  backend.deliver({
    type: "homefleet",
    name: "tower (2)",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
    addresses: ["192.168.1.20"],
  });
  expect(timers.pendingCount()).toBe(0);
  timers.fire();
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower (2)",
  ]);
  await a.discovery.stop();
});

test("a collision rename supersedes the watchdog and re-arms it for the new name", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // B's "tower" publication dies at probe time; the peer's same-name
  // publication won that probe race and is alive.
  backend.suppressDelivery = (request) => request.name === "tower";
  const b = startDiscovery(backend, announcement(deviceIdB), undefined, timers);
  expect(timers.pendingCount()).toBe(1);

  // The peer's browse result arrives; B loses the tie-break and renames
  // through the collision path before the watchdog ever fires.
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });
  // The rename re-armed the watchdog for "tower (2)", whose echo (not
  // suppressed) confirmed it — so no timer is left to fire a second rename.
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower (2)",
  ]);
  expect(timers.pendingCount()).toBe(0);
  timers.fire();
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower (2)",
  ]);
  await b.discovery.stop();
});

test("watchdog recovers when we win the tie-break but our publication died probing", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // The probe race the collision path cannot fix: A wins the tie-break
  // (smaller deviceId) so it never renames off browse results, yet its own
  // "tower" publication is the one that silently died.
  backend.suppressDelivery = (request) =>
    request.txt.id === deviceIdA && request.name === "tower";
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);

  // The peer's live same-name publication shows up: no collision rename
  // (the peer loses the tie-break), and a peer service is not our echo —
  // the watchdog stays armed.
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: deviceIdB, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower",
  ]);
  expect(timers.pendingCount()).toBe(1);

  timers.fire();
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower (2)",
  ]);
  await a.discovery.stop();
});

test("watchdog renames stay bounded when self-echo never arrives", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // No publication ever echoes (e.g. multicast loopback disabled): the
  // watchdog must burn its bounded attempts and then go quiet.
  backend.suppressDelivery = () => true;
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);

  while (timers.pendingCount() > 0) {
    timers.fire();
  }
  // MAX_RENAME_ATTEMPTS = 10: the initial publication plus nine renames,
  // then the node stays on its last name with no timer re-armed.
  expect(backend.publications).toHaveLength(10);
  expect(backend.activePublications().map((p) => p.request.name)).toEqual([
    "tower (10)",
  ]);
  await a.discovery.stop();
});

test("a watchdog fired by a leaky scheduler after stop renames nothing", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // A misbehaving injected scheduler: cancellation does not remove the
  // callback, so stop() cannot prevent the deadline from firing late.
  const leakyTimers: FakeTimers = { ...timers, cancel: () => {} };
  backend.suppressDelivery = () => true;
  const a = startDiscovery(
    backend,
    announcement(deviceIdA),
    undefined,
    leakyTimers,
  );

  await a.discovery.stop();
  timers.fire();
  expect(backend.publications).toHaveLength(1);
});

test("a watchdog fired by a leaky scheduler after confirmation renames nothing", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // Same leaky scheduler, but the discovery is still running: the echo
  // confirmed the publication, so the lingering callback is stale and must
  // not rename.
  const leakyTimers: FakeTimers = { ...timers, cancel: () => {} };
  const a = startDiscovery(
    backend,
    announcement(deviceIdA),
    undefined,
    leakyTimers,
  );

  timers.fire();
  expect(backend.publications).toHaveLength(1);
  expect(backend.publications[0]?.request.name).toBe("tower");
  await a.discovery.stop();
});

test("stop cancels a pending watchdog", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  backend.suppressDelivery = () => true;
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);
  expect(timers.pendingCount()).toBe(1);

  await a.discovery.stop();
  expect(timers.pendingCount()).toBe(0);
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
    txt: { id: deviceIdB, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });
  expect(a.candidates).toEqual([]);
});

test("a collision rename emits an operator diagnostic naming both labels", async () => {
  const backend = new FakeMdnsBackend();
  const b = startDiscovery(backend, announcement(deviceIdB));

  // A peer with the same name and a smaller deviceId: B loses the tie-break
  // and renames. The diagnostic is the only operator-visible signal.
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });

  expect(b.diagnostics).toEqual([
    'mDNS name collision on "tower": renamed to "tower (2)"',
  ]);
  await b.discovery.stop();
});

test("a watchdog rename emits an operator diagnostic naming both labels", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // The "tower" publication silently dies at probe time and never echoes.
  backend.suppressDelivery = (request) => request.name === "tower";
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);

  timers.fire();

  expect(a.diagnostics).toEqual([
    'mDNS publication "tower" never confirmed by its own echo ' +
      '(probe conflict?): renamed to "tower (2)"',
  ]);
  await a.discovery.stop();
});

test("rename-budget exhaustion is reported exactly once, then declines stay quiet", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  // No publication ever echoes (e.g. multicast loopback disabled): the
  // watchdog burns all attempts and the final deadline finds the budget
  // spent — the operator must hear about the degraded state, once.
  backend.suppressDelivery = () => true;
  const b = startDiscovery(backend, announcement(deviceIdB), undefined, timers);

  while (timers.pendingCount() > 0) {
    timers.fire();
  }
  expect(b.diagnostics.filter((m) => m.includes("renamed to"))).toHaveLength(9);
  // "after 9 renames" reads truthfully beside the log it summarizes: the
  // budget allows nine renames past the bare name, so exactly nine
  // "renamed to" lines precede this notice.
  expect(
    b.diagnostics.filter((m) => m.includes("rename budget exhausted")),
  ).toEqual([
    'mDNS rename budget exhausted after 9 renames; staying on "tower (10)" ' +
      "— mDNS discovery may be degraded",
  ]);

  // A colliding browse result while exhausted also declines the rename —
  // but that says nothing new, so it must not repeat the message.
  backend.deliver({
    type: "homefleet",
    name: "tower (10)",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });
  expect(
    b.diagnostics.filter((m) => m.includes("rename budget exhausted")),
  ).toHaveLength(1);
  await b.discovery.stop();
});

test("a collision decline reports exhaustion first; the pending watchdog then stays quiet", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  backend.suppressDelivery = () => true;
  const b = startDiscovery(backend, announcement(deviceIdB), undefined, timers);

  // Nine watchdog renames park the node on "tower (10)" with a watchdog
  // still pending for it — the budget is spent but not yet reported.
  for (let i = 0; i < 9; i += 1) {
    timers.fire();
  }
  expect(timers.pendingCount()).toBe(1);
  expect(
    b.diagnostics.filter((m) => m.includes("rename budget exhausted")),
  ).toHaveLength(0);

  // The reverse ordering of the test above: a colliding browse result on
  // the new name declines FIRST, reporting the exhaustion…
  backend.deliver({
    type: "homefleet",
    name: "tower (10)",
    port: 47113,
    txt: { id: deviceIdA, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });
  expect(
    b.diagnostics.filter((m) => m.includes("rename budget exhausted")),
  ).toHaveLength(1);

  // …and the still-pending attempt-10 watchdog then declines silently.
  timers.fire();
  expect(
    b.diagnostics.filter((m) => m.includes("rename budget exhausted")),
  ).toHaveLength(1);
  await b.discovery.stop();
});

test("the happy path emits no diagnostics", async () => {
  const backend = new FakeMdnsBackend();
  const timers = fakeTimers();
  const a = startDiscovery(backend, announcement(deviceIdA), undefined, timers);

  // Our publication is confirmed by its own echo, and a peer under a
  // different name is not rename-worthy: the operator hears nothing.
  backend.deliver({
    type: "homefleet",
    name: "laptop",
    port: 47999,
    txt: { id: deviceIdB, pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });
  timers.fire();

  expect(a.diagnostics).toEqual([]);
  expect(a.candidates).toHaveLength(1);
  await a.discovery.stop();
});
