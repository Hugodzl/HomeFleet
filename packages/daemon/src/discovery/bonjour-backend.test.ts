import { expect, test } from "vitest";
import { toFoundService } from "./bonjour-backend.js";

test("maps a browsed service with addresses straight through", () => {
  expect(
    toFoundService("homefleet", {
      name: "tower",
      port: 47113,
      txt: { id: "aa", pv: "0.1.0" },
      addresses: ["192.168.1.20", "fe80::1"],
      referer: { address: "192.168.1.99" },
    }),
  ).toEqual({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: "aa", pv: "0.1.0" },
    addresses: ["192.168.1.20", "fe80::1"],
  });
});

test("falls back to the responder's address when addresses are empty", () => {
  expect(
    toFoundService("homefleet", {
      name: "tower",
      port: 47113,
      txt: {},
      addresses: [],
      referer: { address: "192.168.1.99" },
    }).addresses,
  ).toEqual(["192.168.1.99"]);
  expect(
    toFoundService("homefleet", {
      name: "tower",
      port: 47113,
      referer: { address: "192.168.1.99" },
    }).addresses,
  ).toEqual(["192.168.1.99"]);
});

test("yields no addresses when the service has neither addresses nor referer", () => {
  expect(
    toFoundService("homefleet", { name: "tower", port: 47113 }).addresses,
  ).toEqual([]);
});

test("an undefined or non-object txt becomes an empty record", () => {
  expect(
    toFoundService("homefleet", { name: "tower", port: 47113 }).txt,
  ).toEqual({});
  expect(
    toFoundService("homefleet", { name: "tower", port: 47113, txt: "junk" })
      .txt,
  ).toEqual({});
});
