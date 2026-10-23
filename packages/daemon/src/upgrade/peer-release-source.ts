/**
 * A release source that is the node which pushed the upgrade (fleet-upgrade
 * Phase 3). The push already carries the signed manifest and signature; only
 * the (large) tarball is fetched, over the pinned mTLS HFP client. Nothing
 * here is trusted: the caller verifies the result against the release keys,
 * exactly as for a GitHub download.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HfpClient, HfpTarget } from "../transport/client.js";
import {
  manifestFileName,
  releaseFileName,
  signatureFileName,
} from "./manifest.js";
import {
  type FetchedRelease,
  MAX_RELEASE_ASSET_BYTES,
  ReleaseFetchError,
  type ReleaseSource,
} from "./release-source.js";

export class PeerReleaseSource implements ReleaseSource {
  constructor(
    private readonly options: {
      client: Pick<HfpClient, "fetchUpgradeTarball">;
      target: HfpTarget;
      /** The push's manifest bytes, written as-is. */
      manifestBytes: Buffer;
      /** The push's base64 detached signature over `manifestBytes`. */
      signature: string;
    },
  ) {}

  latestVersion(): Promise<string> {
    return Promise.reject(
      new ReleaseFetchError("a peer source has no latest version"),
    );
  }

  async fetchRelease(
    version: string,
    destDir: string,
  ): Promise<FetchedRelease> {
    await mkdir(destDir, { recursive: true });
    const { client, target, manifestBytes, signature } = this.options;
    await writeFile(
      path.join(destDir, manifestFileName(version)),
      manifestBytes,
    );
    // Same on-disk form as writeSignedRelease (trailing newline).
    await writeFile(
      path.join(destDir, signatureFileName(version)),
      `${signature}
`,
    );
    const tarballPath = path.join(destDir, releaseFileName(version));
    await client.fetchUpgradeTarball(target, version, tarballPath, {
      maxBytes: MAX_RELEASE_ASSET_BYTES,
    });
    return { manifestBytes, signature, tarballPath };
  }
}
