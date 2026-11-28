/**
 * Release tags: `vX.Y.Z` is a final release; `vX.Y.Z-rc.N` (N ≥ 1, no
 * leading zero) is a release candidate that carries the final `X.Y.Z`
 * tarball. Nothing else is a release tag.
 */
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)(?:-rc\.([1-9]\d*))?$/;

export interface ReleaseTag {
  version: string;
  /** The candidate number N of `vX.Y.Z-rc.N`; absent for a final tag. */
  candidate?: number;
}

export function parseReleaseTag(tag: string): ReleaseTag {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) {
    throw new Error(
      `release tag "${tag}" is not of the form v<semver> (vX.Y.Z or vX.Y.Z-rc.N)`,
    );
  }
  const version = match[1] ?? "";
  const candidate = match[2];
  return candidate === undefined
    ? { version }
    : { version, candidate: Number(candidate) };
}

/**
 * Release guard (S1 spec §3): the pushed tag must name exactly the version
 * being packed, so a Release can never carry a mislabeled tarball. A
 * candidate tag `vX.Y.Z-rc.N` carries the final `X.Y.Z`.
 */
export function checkTagVersion(tag: string, version: string): void {
  const parsed = parseReleaseTag(tag);
  if (parsed.version !== version) {
    throw new Error(
      `release tag ${tag} does not match @homefleet/daemon version ${version} — bump the version (and DAEMON_VERSION) or fix the tag`,
    );
  }
}

/** The highest `v<version>-rc.N` among `tags`, by number; undefined if none. */
export function highestCandidate(
  tags: readonly string[],
  version: string,
): string | undefined {
  let best: { tag: string; n: number } | undefined;
  for (const tag of tags) {
    let parsed: ReleaseTag;
    try {
      parsed = parseReleaseTag(tag);
    } catch {
      continue;
    }
    if (parsed.version !== version || parsed.candidate === undefined) {
      continue;
    }
    if (best === undefined || parsed.candidate > best.n) {
      best = { tag, n: parsed.candidate };
    }
  }
  return best?.tag;
}
