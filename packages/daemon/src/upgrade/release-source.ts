/**
 * Where upgrade tarballs come from (fleet-upgrade spec, Phase 2). Phase 3
 * adds a peer source; everything downstream only sees this interface.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAEMON_VERSION } from "../version.js";
import {
  manifestFileName,
  releaseFileName,
  signatureFileName,
} from "./manifest.js";
import { isSemver } from "./semver.js";

export interface FetchedRelease {
  manifestBytes: Buffer;
  /** base64 detached Ed25519 signature over `manifestBytes`. */
  signature: string;
  tarballPath: string;
}

export interface ReleaseSource {
  /** The newest published version (`X.Y.Z`, no leading `v`). */
  latestVersion(): Promise<string>;
  /** Downloads the three release files for `version` into `destDir`. Unverified. */
  fetchRelease(version: string, destDir: string): Promise<FetchedRelease>;
}

/** The public repo releases are published from. */
export const RELEASES_REPO = "Hugodzl/HomeFleet";

/** No release asset is anywhere near this; bounds a hostile or broken server. */
export const MAX_RELEASE_ASSET_BYTES = 100 * 1024 * 1024;

export class ReleaseFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseFetchError";
  }
}

export class GitHubReleaseSource implements ReleaseSource {
  private readonly fetchImpl: typeof fetch;
  private readonly repo: string;

  constructor(options: { fetch?: typeof fetch; repo?: string } = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.repo = options.repo ?? RELEASES_REPO;
  }

  async latestVersion(): Promise<string> {
    const response = await this.get(
      `https://api.github.com/repos/${this.repo}/releases/latest`,
      "application/vnd.github+json",
    );
    const body = (await response.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    if (!isSemver(version)) {
      throw new ReleaseFetchError(
        `the latest release tag "${tag}" is not vX.Y.Z`,
      );
    }
    return version;
  }

  async fetchRelease(
    version: string,
    destDir: string,
  ): Promise<FetchedRelease> {
    await mkdir(destDir, { recursive: true });
    const base = `https://github.com/${this.repo}/releases/download/v${version}/`;
    const names = {
      tarball: releaseFileName(version),
      manifest: manifestFileName(version),
      signature: signatureFileName(version),
    };
    const files: Record<keyof typeof names, Buffer> = {
      tarball: await this.download(base + names.tarball),
      manifest: await this.download(base + names.manifest),
      signature: await this.download(base + names.signature),
    };
    for (const key of Object.keys(names) as Array<keyof typeof names>) {
      await writeFile(path.join(destDir, names[key]), files[key]);
    }
    return {
      manifestBytes: files.manifest,
      signature: files.signature.toString("utf8"),
      tarballPath: path.join(destDir, names.tarball),
    };
  }

  private async get(url: string, accept: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept, "user-agent": `homefleet/${DAEMON_VERSION}` },
        redirect: "follow",
      });
    } catch (error) {
      throw new ReleaseFetchError(
        `could not reach ${new URL(url).host}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new ReleaseFetchError(
        `GET ${url} returned HTTP ${response.status}`,
      );
    }
    return response;
  }

  private async download(url: string): Promise<Buffer> {
    const response = await this.get(url, "application/octet-stream");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RELEASE_ASSET_BYTES) {
      throw new ReleaseFetchError(
        `${url} is larger than the ${MAX_RELEASE_ASSET_BYTES}-byte cap`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RELEASE_ASSET_BYTES) {
      throw new ReleaseFetchError(
        `${url} is larger than the ${MAX_RELEASE_ASSET_BYTES}-byte cap`,
      );
    }
    return bytes;
  }
}

/**
 * Tries each source in order (peer first, GitHub last) and returns the first
 * that fetches. destDir is emptied between attempts so a failed source's
 * partial files never mix into the next one's. Verification is the caller's.
 */
export class FallbackReleaseSource implements ReleaseSource {
  constructor(private readonly sources: readonly ReleaseSource[]) {
    if (sources.length === 0) {
      throw new Error("FallbackReleaseSource needs at least one source");
    }
  }

  /** The last source is the authority on what is newest (GitHub). */
  latestVersion(): Promise<string> {
    return (
      this.sources[this.sources.length - 1] as ReleaseSource
    ).latestVersion();
  }

  async fetchRelease(
    version: string,
    destDir: string,
  ): Promise<FetchedRelease> {
    const errors: unknown[] = [];
    for (const source of this.sources) {
      await rm(destDir, { recursive: true, force: true });
      try {
        return await source.fetchRelease(version, destDir);
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(destDir, { recursive: true, force: true });
    if (errors.length === 1) {
      throw errors[0];
    }
    // Every reason, so a peer + GitHub double failure records both in
    // lastUpgrade.reason rather than only GitHub's.
    throw new ReleaseFetchError(
      errors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; then "),
    );
  }
}
