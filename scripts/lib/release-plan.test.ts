import { expect, test } from "vitest";
import { flattenReleasePages, planRelease } from "./release-plan.js";

const rc = (
  tag: string,
  extra: { draft?: boolean; prerelease?: boolean } = {},
) => ({
  tag,
  draft: extra.draft ?? false,
  prerelease: extra.prerelease ?? true,
});

test("a non-tag ref is a build", () => {
  expect(
    planRelease({ ref: "refs/heads/main", refName: "main", releases: [] }),
  ).toEqual({ mode: "build" });
});

test("a candidate tag is a candidate of its final", () => {
  expect(
    planRelease({
      ref: "refs/tags/v0.8.0-rc.2",
      refName: "v0.8.0-rc.2",
      releases: [],
    }),
  ).toEqual({ mode: "candidate", final: "v0.8.0" });
});

test("a final tag with published candidates promotes the highest one", () => {
  expect(
    planRelease({
      ref: "refs/tags/v0.8.0",
      refName: "v0.8.0",
      releases: [rc("v0.8.0-rc.9"), rc("v0.8.0-rc.10"), rc("v0.7.0-rc.11")],
    }),
  ).toEqual({ mode: "promote", final: "v0.8.0", candidate: "v0.8.0-rc.10" });
});

test("draft and non-prerelease candidate releases are ignored", () => {
  expect(
    planRelease({
      ref: "refs/tags/v0.8.0",
      refName: "v0.8.0",
      releases: [
        rc("v0.8.0-rc.1"),
        rc("v0.8.0-rc.3", { draft: true }),
        rc("v0.8.0-rc.2", { prerelease: false }),
      ],
    }),
  ).toEqual({ mode: "promote", final: "v0.8.0", candidate: "v0.8.0-rc.1" });
});

test("a final tag with no candidate is a build", () => {
  expect(
    planRelease({
      ref: "refs/tags/v0.8.0",
      refName: "v0.8.0",
      releases: [rc("v0.7.0-rc.1"), rc("v0.7.0", { prerelease: false })],
    }),
  ).toEqual({ mode: "build", final: "v0.8.0" });
});

test("a malformed tag throws", () => {
  for (const refName of ["v0.8.0-beta.1", "v0.8.0-rc.0", "0.8.0", "v0.8"]) {
    expect(
      () => planRelease({ ref: `refs/tags/${refName}`, refName, releases: [] }),
      refName,
    ).toThrow();
  }
});

test("flattenReleasePages reads gh api --paginate --slurp output (an array of pages)", () => {
  const pages = [
    [{ tag_name: "v0.7.0", draft: false, prerelease: false }],
    [{ tag_name: "v0.8.0-rc.1", draft: false, prerelease: true }],
  ];
  const releases = flattenReleasePages(pages);
  expect(releases).toEqual([
    { tag: "v0.7.0", draft: false, prerelease: false },
    { tag: "v0.8.0-rc.1", draft: false, prerelease: true },
  ]);
  // A candidate on page 2 is found.
  expect(
    planRelease({ ref: "refs/tags/v0.8.0", refName: "v0.8.0", releases }),
  ).toMatchObject({ mode: "promote", candidate: "v0.8.0-rc.1" });
});

test("flattenReleasePages refuses anything that is not pages of releases", () => {
  expect(() => flattenReleasePages({ message: "Not Found" })).toThrow();
  expect(() => flattenReleasePages([[{ name: "x" }]])).toThrow();
});

test("a candidate tag after its final is published throws", () => {
  expect(() =>
    planRelease({
      ref: "refs/tags/v0.8.0-rc.3",
      refName: "v0.8.0-rc.3",
      releases: [
        { tag: "v0.8.0", prerelease: false, draft: false },
        rc("v0.8.0-rc.2"),
      ],
    }),
  ).toThrow(/already released/);
  // A draft final does not count.
  expect(
    planRelease({
      ref: "refs/tags/v0.8.0-rc.3",
      refName: "v0.8.0-rc.3",
      releases: [{ tag: "v0.8.0", prerelease: false, draft: true }],
    }),
  ).toEqual({ mode: "candidate", final: "v0.8.0" });
});
