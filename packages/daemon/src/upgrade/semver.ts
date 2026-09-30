/**
 * Strict `X.Y.Z` semver helpers for the upgrade flow. HomeFleet versions
 * (daemon and HFP) never carry pre-release or build suffixes — see
 * `SemverSchema` in @homefleet/protocol — so anything else is rejected
 * rather than half-supported.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (match === null) {
    throw new Error(`"${version}" is not a semver string (X.Y.Z)`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/** -1 / 0 / 1 like a sort comparator. Throws on a non-`X.Y.Z` input. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l > r ? 1 : -1;
    }
  }
  return 0;
}

export function majorOf(version: string): number {
  return parse(version)[0];
}
