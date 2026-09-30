/**
 * Where upgrade tarballs come from (fleet-upgrade spec, Phase 2). Phase 3
 * adds a peer source; everything downstream only sees this interface.
 */
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
