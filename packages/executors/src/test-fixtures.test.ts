/**
 * Focused fixture test for {@link MockOpenAiEndpoint}'s `GET /models` support
 * (A2): the daemon's startup catalog validation probes this route over real
 * loopback HTTP, so the mock must answer it from a configurable model list.
 */
import { expect, test } from "vitest";
import { MockOpenAiEndpoint } from "./test-fixtures.js";

test("MockOpenAiEndpoint serves GET /models from its configured list", async () => {
  const endpoint = await MockOpenAiEndpoint.start([], { models: ["m1", "m2"] });
  try {
    const res = await fetch(`${endpoint.baseUrl}/models`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({
      object: "list",
      data: [
        { id: "m1", object: "model" },
        { id: "m2", object: "model" },
      ],
    });
  } finally {
    await endpoint.close();
  }
});

test("MockOpenAiEndpoint serves an empty GET /models list by default", async () => {
  const endpoint = await MockOpenAiEndpoint.start([]);
  try {
    const res = await fetch(`${endpoint.baseUrl}/models`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ object: "list", data: [] });
  } finally {
    await endpoint.close();
  }
});
