import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { releaseFileName } from "./manifest.js";
import {
  FallbackReleaseSource,
  GitHubReleaseSource,
  ReleaseFetchError,
  type ReleaseSource,
} from "./release-source.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./test-release.js";

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

describe("FallbackReleaseSource", () => {
  function failing(message: string): ReleaseSource {
    return {
      latestVersion: async () => "0.0.1",
      fetchRelease: async (_version, destDir) => {
        // Leave debris, as a half-finished download would.
        await mkdir(destDir, { recursive: true });
        await writeFile(path.join(destDir, "partial.tmp"), "junk");
        throw new ReleaseFetchError(message);
      },
    };
  }

  async function origin() {
    const root = await mkdtemp(path.join(tmpdir(), "hf-fallback-"));
    dirs.push(root);
    const originDir = path.join(root, "origin");
    await writeSignedRelease(originDir, "0.5.1", makeTestKeys());
    return { root, originDir };
  }

  test("falls through to the next source and clears destDir between attempts", async () => {
    const { root, originDir } = await origin();
    const dest = path.join(root, "dest");
    const source = new FallbackReleaseSource([
      failing("peer down"),
      new FakeReleaseSource(originDir, "0.5.1"),
    ]);
    const fetched = await source.fetchRelease("0.5.1", dest);
    expect(fetched.tarballPath).toBe(path.join(dest, releaseFileName("0.5.1")));
    expect((await readdir(dest)).sort()).toEqual([
      "homefleet-0.5.1.manifest.json",
      "homefleet-0.5.1.manifest.sig",
      "homefleet-0.5.1.tgz",
    ]);
  });

  test("rejects with every source's reason, in order, when all fail", async () => {
    const { root } = await origin();
    const source = new FallbackReleaseSource([
      failing("peer: connection refused"),
      failing("GitHub: 404"),
    ]);
    const error = await source
      .fetchRelease("0.5.1", path.join(root, "dest"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReleaseFetchError);
    expect((error as Error).message).toBe(
      "peer: connection refused; then GitHub: 404",
    );
  });

  test("a single source's error passes through unchanged", async () => {
    const { root } = await origin();
    const source = new FallbackReleaseSource([failing("only")]);
    await expect(
      source.fetchRelease("0.5.1", path.join(root, "dest")),
    ).rejects.toThrow(/^only$/);
  });

  test("latestVersion delegates to the last source", async () => {
    const { originDir } = await origin();
    const source = new FallbackReleaseSource([
      failing("x"),
      new FakeReleaseSource(originDir, "0.7.0"),
    ]);
    expect(await source.latestVersion()).toBe("0.7.0");
  });
});
