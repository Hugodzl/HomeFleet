import { expect, test } from "vitest";
import {
  DISCOVERY_MAX_DATAGRAM_BYTES,
  DISCOVERY_MDNS_SERVICE_TYPE,
  DISCOVERY_MULTICAST_GROUP,
  DISCOVERY_UDP_PORT,
  type DiscoveryAnnouncement,
  DiscoveryAnnouncementSchema,
  DiscoveryDatagramSchema,
} from "./discovery.js";
import { validDeviceId } from "./test-fixtures.js";

const validAnnouncement: DiscoveryAnnouncement = {
  deviceId: validDeviceId,
  name: "tower",
  port: 47113,
  protocolVersion: "0.3.0",
};

test("DiscoveryAnnouncementSchema round-trips a valid announcement", () => {
  expect(DiscoveryAnnouncementSchema.parse(validAnnouncement)).toEqual(
    validAnnouncement,
  );
});

test("DiscoveryAnnouncementSchema rejects an invalid deviceId", () => {
  expect(
    DiscoveryAnnouncementSchema.safeParse({
      ...validAnnouncement,
      deviceId: "not-a-fingerprint",
    }).success,
  ).toBe(false);
  expect(
    DiscoveryAnnouncementSchema.safeParse({
      ...validAnnouncement,
      deviceId: validDeviceId.toUpperCase(),
    }).success,
  ).toBe(false);
});

test("DiscoveryAnnouncementSchema enforces NodeInfo name constraints", () => {
  expect(
    DiscoveryAnnouncementSchema.safeParse({ ...validAnnouncement, name: "" })
      .success,
  ).toBe(false);
  expect(
    DiscoveryAnnouncementSchema.safeParse({
      ...validAnnouncement,
      name: "x".repeat(65),
    }).success,
  ).toBe(false);
  const name = "x".repeat(64);
  expect(
    DiscoveryAnnouncementSchema.parse({ ...validAnnouncement, name }).name,
  ).toBe(name);
});

test("DiscoveryAnnouncementSchema bounds port to 1-65535 integers", () => {
  for (const port of [0, 65536, 1.5, -1]) {
    expect(
      DiscoveryAnnouncementSchema.safeParse({ ...validAnnouncement, port })
        .success,
    ).toBe(false);
  }
  expect(
    DiscoveryAnnouncementSchema.parse({ ...validAnnouncement, port: 1 }).port,
  ).toBe(1);
  expect(
    DiscoveryAnnouncementSchema.parse({ ...validAnnouncement, port: 65535 })
      .port,
  ).toBe(65535);
});

test("DiscoveryAnnouncementSchema requires a semver protocolVersion", () => {
  expect(
    DiscoveryAnnouncementSchema.safeParse({
      ...validAnnouncement,
      protocolVersion: "0.1",
    }).success,
  ).toBe(false);
  expect(
    DiscoveryAnnouncementSchema.safeParse({
      ...validAnnouncement,
      protocolVersion: "v0.2.0",
    }).success,
  ).toBe(false);
});

test("DiscoveryAnnouncementSchema strips unknown fields on parse", () => {
  const parsed = DiscoveryAnnouncementSchema.parse({
    ...validAnnouncement,
    futureField: "ignored",
  });
  expect(parsed).toEqual(validAnnouncement);
  expect(parsed).not.toHaveProperty("futureField");
});

test("DiscoveryDatagramSchema accepts announce and response kinds", () => {
  for (const kind of ["announce", "response"] as const) {
    const datagram = { ...validAnnouncement, kind };
    expect(DiscoveryDatagramSchema.parse(datagram)).toEqual(datagram);
  }
});

test("DiscoveryDatagramSchema rejects a missing or unknown kind", () => {
  expect(DiscoveryDatagramSchema.safeParse(validAnnouncement).success).toBe(
    false,
  );
  expect(
    DiscoveryDatagramSchema.safeParse({ ...validAnnouncement, kind: "hello" })
      .success,
  ).toBe(false);
});

test("discovery constants match the RFC", () => {
  expect(DISCOVERY_MDNS_SERVICE_TYPE).toBe("homefleet");
  expect(DISCOVERY_MULTICAST_GROUP).toBe("239.255.42.98");
  expect(DISCOVERY_UDP_PORT).toBe(56371);
  expect(DISCOVERY_MAX_DATAGRAM_BYTES).toBe(4096);
});
