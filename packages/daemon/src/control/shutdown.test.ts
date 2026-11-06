import { expect, test } from "vitest";
import { decideShutdown, type ShutdownFacts } from "./shutdown.js";

const idle: ShutdownFacts = {
  pid: 42,
  hasShutdownHook: true,
  upgrading: false,
  alreadyRequested: false,
  activeJobs: 0,
  force: false,
};

test("an idle daemon starts its shutdown", () => {
  expect(decideShutdown(idle)).toEqual({
    result: { ok: true, pid: 42, alreadyStopping: false },
    request: true,
  });
});

test("a repeat request answers success again but never re-requests", () => {
  expect(decideShutdown({ ...idle, alreadyRequested: true })).toEqual({
    result: { ok: true, pid: 42, alreadyStopping: true },
    request: false,
  });
  // Even with jobs running: the first request already decided.
  expect(
    decideShutdown({ ...idle, alreadyRequested: true, activeJobs: 3 }).request,
  ).toBe(false);
});

test("busy: jobs running without force is refused; force goes through", () => {
  const busy = decideShutdown({ ...idle, activeJobs: 2 });
  expect(busy.request).toBe(false);
  expect(busy.result).toMatchObject({ ok: false, code: "busy" });
  expect(decideShutdown({ ...idle, activeJobs: 2, force: true })).toEqual({
    result: { ok: true, pid: 42, alreadyStopping: false },
    request: true,
  });
});

test("upgrading is refused, even with force and even after the upgrade set the flag", () => {
  for (const facts of [
    { ...idle, upgrading: true },
    { ...idle, upgrading: true, force: true },
    { ...idle, upgrading: true, alreadyRequested: true },
  ]) {
    const decision = decideShutdown(facts);
    expect(decision.request).toBe(false);
    expect(decision.result).toMatchObject({ ok: false, code: "upgrading" });
  }
});

test("no shutdown hook is unsupported", () => {
  const decision = decideShutdown({ ...idle, hasShutdownHook: false });
  expect(decision.request).toBe(false);
  expect(decision.result).toMatchObject({ ok: false, code: "unsupported" });
});
