/**
 * What a release workflow run does, from its ref and the repo's Releases
 * (spec 2026-11-12, PR 2):
 *
 * - `build`: pack a new tarball. A branch run (no publish), or a final tag
 *   `vX.Y.Z` with no candidate.
 * - `candidate`: a `vX.Y.Z-rc.N` tag. Packs the final X.Y.Z tarball and
 *   publishes it as a prerelease; `final` names the notes file.
 * - `promote`: a final tag with published candidates of its version.
 *   Republishes the highest candidate's exact bytes instead of building.
 *
 * The release job re-derives this itself in bash (it never trusts pack's
 * view); this is pack's copy, and the tested statement of the rules.
 */
import { highestCandidate, parseReleaseTag } from "./tag-version.js";

export interface ReleaseEntry {
  tag: string;
  prerelease: boolean;
  draft: boolean;
}

export interface ReleasePlan {
  mode: "build" | "candidate" | "promote";
  /** The final tag `vX.Y.Z` (its notes file); absent on a branch run. */
  final?: string;
  /** The candidate tag a promote republishes. */
  candidate?: string;
}

export function planRelease(input: {
  ref: string;
  refName: string;
  releases: readonly ReleaseEntry[];
}): ReleasePlan {
  if (!input.ref.startsWith("refs/tags/")) {
    return { mode: "build" };
  }
  const parsed = parseReleaseTag(input.refName);
  const final = `v${parsed.version}`;
  if (parsed.candidate !== undefined) {
    return { mode: "candidate", final };
  }
  const published = input.releases
    .filter((release) => release.prerelease && !release.draft)
    .map((release) => release.tag);
  const candidate = highestCandidate(published, parsed.version);
  return candidate !== undefined
    ? { mode: "promote", final, candidate }
    : { mode: "build", final };
}

/** `gh api --paginate --slurp .../releases` output → release entries. */
export function flattenReleasePages(json: unknown): ReleaseEntry[] {
  if (!Array.isArray(json)) {
    throw new Error("expected the slurped pages of GET /releases (an array)");
  }
  return json.flatMap((page: unknown) => {
    if (!Array.isArray(page)) {
      throw new Error("expected each page of GET /releases to be an array");
    }
    return page.map((release: unknown) => {
      const r = release as Record<string, unknown>;
      if (
        typeof r?.tag_name !== "string" ||
        typeof r.prerelease !== "boolean" ||
        typeof r.draft !== "boolean"
      ) {
        throw new Error("a release without tag_name/prerelease/draft");
      }
      return { tag: r.tag_name, prerelease: r.prerelease, draft: r.draft };
    });
  });
}
