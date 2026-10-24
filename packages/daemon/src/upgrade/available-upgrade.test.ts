import { expect, test } from "vitest";
import {
  AVAILABLE_UPGRADE_FAILURE_TTL_MS,
  AVAILABLE_UPGRADE_TTL_MS,
  createAvailableUpgrade,
} from "./available-upgrade.js";

/** Lets a fire-and-forget refresh settle (several microtask hops). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function harness(
  currentVersion: string,
  lookup: () => Promise<string> | string,
) {
  const clock = { t: 1_000 };
  let calls = 0;
  const cache = createAvailableUpgrade({
    currentVersion,
    latestVersion: async () => {
      calls++;
      return lookup();
    },
    now: () => clock.t,
  });
  return { clock, cache, calls: () => calls };
}

test("the first refresh does exactly one lookup and exposes a newer version", async () => {
  const h = harness("0.6.0", () => "0.6.1");
  expect(h.cache.current()).toBeUndefined();
  h.cache.refreshIfStale();
  await settle();
  expect(h.calls()).toBe(1);
  expect(h.cache.current()).toBe("0.6.1");
});

test("no further lookups within 6 hours, one more after", async () => {
  const h = harness("0.6.0", () => "0.6.1");
  h.cache.refreshIfStale();
  await settle();
  h.clock.t += AVAILABLE_UPGRADE_TTL_MS - 1;
  h.cache.refreshIfStale();
  await settle();
  expect(h.calls()).toBe(1);
  h.clock.t += 1;
  h.cache.refreshIfStale();
  await settle();
  expect(h.calls()).toBe(2);
});

test("a latest equal to (or older than) the current version is undefined", async () => {
  const same = harness("0.6.0", () => "0.6.0");
  same.cache.refreshIfStale();
  await settle();
  expect(same.cache.current()).toBeUndefined();
  const older = harness("0.6.0", () => "0.5.9");
  older.cache.refreshIfStale();
  await settle();
  expect(older.cache.current()).toBeUndefined();
});

test("a non-semver latest counts as a failed lookup", async () => {
  const h = harness("0.6.0", () => "not-a-version");
  h.cache.refreshIfStale();
  await settle();
  expect(h.cache.current()).toBeUndefined();
  h.clock.t += AVAILABLE_UPGRADE_FAILURE_TTL_MS - 1;
  h.cache.refreshIfStale();
  await settle();
  expect(h.calls()).toBe(1);
});

test("a failed lookup yields undefined, retries only after 15 minutes", async () => {
  let fail = true;
  const h = harness("0.6.0", () => {
    if (fail) {
      throw new Error("offline");
    }
    return "0.7.0";
  });
  h.cache.refreshIfStale();
  await settle();
  expect(h.cache.current()).toBeUndefined();
  h.clock.t += AVAILABLE_UPGRADE_FAILURE_TTL_MS - 1;
  h.cache.refreshIfStale();
  await settle();
  expect(h.calls()).toBe(1);
  fail = false;
  h.clock.t += 1;
  h.cache.refreshIfStale();
  await settle();
  expect(h.calls()).toBe(2);
  expect(h.cache.current()).toBe("0.7.0");
});

test("concurrent refreshes share one lookup", async () => {
  let resolve: (v: string) => void = () => {};
  const h = harness(
    "0.6.0",
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  h.cache.refreshIfStale();
  h.cache.refreshIfStale();
  h.cache.refreshIfStale();
  expect(h.calls()).toBe(1);
  resolve("0.6.2");
  await settle();
  expect(h.cache.current()).toBe("0.6.2");
  expect(h.calls()).toBe(1);
});
