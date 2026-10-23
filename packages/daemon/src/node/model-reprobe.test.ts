import type { ModelStatus } from "@homefleet/protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { CatalogRuntime } from "./catalog.js";
import {
  MODEL_REPROBE_INTERVAL_MS,
  startModelReprobe,
} from "./model-reprobe.js";

const catalog: CatalogRuntime = {
  entries: new Map([
    ["qwen", { id: "qwen", contextWindow: 32768, baseUrl: "http://h/v1" }],
  ]),
  defaults: {},
};

/** A model server whose served ids can change between probes. */
function liveServer(): {
  serve: (ids: string[] | "DOWN") => void;
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let state: string[] | "DOWN" = "DOWN";
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (state === "DOWN") throw new Error("connection refused");
    const ids = state;
    return {
      ok: true,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    } as Response;
  }) as unknown as typeof fetch;
  return {
    serve: (ids) => {
      state = ids;
    },
    fetchImpl,
    calls: () => calls,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("probeNow refreshes the shared status map in place (late model server turns ok)", async () => {
  const server = liveServer();
  const statuses = new Map<string, ModelStatus>([["qwen", "unreachable"]]);
  const reprobe = startModelReprobe({
    catalog,
    statuses,
    fetchImpl: server.fetchImpl,
  });
  try {
    server.serve(["qwen"]);
    await reprobe.probeNow();
    expect(statuses.get("qwen")).toBe("ok");
    server.serve(["something-else"]);
    await reprobe.probeNow();
    expect(statuses.get("qwen")).toBe("not_served");
  } finally {
    reprobe.stop();
  }
});

test("re-probes on every interval tick until stopped", async () => {
  vi.useFakeTimers();
  const server = liveServer();
  const statuses = new Map<string, ModelStatus>([["qwen", "unreachable"]]);
  const reprobe = startModelReprobe({
    catalog,
    statuses,
    fetchImpl: server.fetchImpl,
  });
  server.serve(["qwen"]);
  await vi.advanceTimersByTimeAsync(MODEL_REPROBE_INTERVAL_MS);
  expect(statuses.get("qwen")).toBe("ok");
  expect(server.calls()).toBe(1);
  reprobe.stop();
  await vi.advanceTimersByTimeAsync(MODEL_REPROBE_INTERVAL_MS * 3);
  expect(server.calls()).toBe(1);
});

test("a tick is skipped while the previous probe is still in flight", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let calls = 0;
  const slowFetch = (async () => {
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      ok: true,
      json: async () => ({ data: [{ id: "qwen" }] }),
    } as Response;
  }) as unknown as typeof fetch;
  const statuses = new Map<string, ModelStatus>([["qwen", "unreachable"]]);
  const reprobe = startModelReprobe({
    catalog,
    statuses,
    fetchImpl: slowFetch,
    timeoutMs: MODEL_REPROBE_INTERVAL_MS * 10,
  });
  try {
    await vi.advanceTimersByTimeAsync(MODEL_REPROBE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(MODEL_REPROBE_INTERVAL_MS);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.get("qwen")).toBe("ok");
  } finally {
    reprobe.stop();
  }
});
