import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitHubReleaseSource, ReleaseFetchError } from "./release-source.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function fakeFetch(routes: Record<string, () => Response>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, urls };
}

describe("GitHubReleaseSource", () => {
  test("latestVersion strips the v from tag_name", async () => {
    const { fetch } = fakeFetch({
      "https://api.github.com/repos/Hugodzl/HomeFleet/releases/latest": () =>
        Response.json({ tag_name: "v0.5.1" }),
    });
    await expect(
      new GitHubReleaseSource({ fetch }).latestVersion(),
    ).resolves.toBe("0.5.1");
  });

  test("latestVersion rejects a non-semver tag", async () => {
    const { fetch } = fakeFetch({
      "https://api.github.com/repos/Hugodzl/HomeFleet/releases/latest": () =>
        Response.json({ tag_name: "nightly" }),
    });
    await expect(
      new GitHubReleaseSource({ fetch }).latestVersion(),
    ).rejects.toThrow(ReleaseFetchError);
  });

  test("fetchRelease downloads the three assets", async () => {
    const base =
      "https://github.com/Hugodzl/HomeFleet/releases/download/v0.5.1/";
    const { fetch, urls } = fakeFetch({
      [`${base}homefleet-0.5.1.tgz`]: () => new Response("tgz"),
      [`${base}homefleet-0.5.1.manifest.json`]: () => new Response("{}"),
      [`${base}homefleet-0.5.1.manifest.sig`]: () => new Response("c2ln\n"),
    });
    const dir = await mkdtemp(path.join(tmpdir(), "hf-src-"));
    dirs.push(dir);
    const fetched = await new GitHubReleaseSource({ fetch }).fetchRelease(
      "0.5.1",
      path.join(dir, "0.5.1"),
    );
    expect(urls).toHaveLength(3);
    expect(await readFile(fetched.tarballPath, "utf8")).toBe("tgz");
    expect(fetched.manifestBytes.toString()).toBe("{}");
    expect(fetched.signature).toBe("c2ln\n");
  });

  test("an HTTP error becomes a ReleaseFetchError naming the URL", async () => {
    const { fetch } = fakeFetch({});
    const dir = await mkdtemp(path.join(tmpdir(), "hf-src-"));
    dirs.push(dir);
    await expect(
      new GitHubReleaseSource({ fetch }).fetchRelease("0.5.1", dir),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("a network failure becomes a ReleaseFetchError", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(
      new GitHubReleaseSource({ fetch }).latestVersion(),
    ).rejects.toThrow(/could not reach api.github.com/);
  });
});
