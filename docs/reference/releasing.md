# Releasing

A `v*` tag on `main` runs [`.github/workflows/release.yml`](../../.github/workflows/release.yml):
the CI gate, then `pnpm pack:release --tag <tag>`, then a global install of
the real tarball on Ubuntu and Windows (bins must print their exact version),
then a GitHub Release with `homefleet-<version>.tgz` attached, titled and
described from `docs/releases/<tag>.md`.

## Cutting a release

1. Bump the version in **all four** places — the pack refuses a tag that
   doesn't match, and `version.test.ts` refuses a drifted `DAEMON_VERSION`:
   `packages/{daemon,executors,protocol}/package.json` and
   `packages/daemon/src/version.ts`. Update `docs/rfc/hfp-v0.md`'s example
   `daemonVersion` too.
2. Write the release notes at `docs/releases/vX.Y.Z.md`. The **first line is
   the Release title** and must read `# HomeFleet vX.Y.Z — <theme>` (the
   workflow refuses the tag otherwise); everything after it is the Release
   body. Follow the shape of the previous notes: a bold one-line lead, the
   real-hardware proof, `## What's new`, `## Known limitations`, `## Install`,
   and a `**Full changelog:**` compare link.
3. `pnpm lint && pnpm typecheck && pnpm test`, commit, push.
4. Optional dry run: `gh workflow run release.yml --ref main` — everything
   except the Release.
5. `git tag vX.Y.Z && git push origin vX.Y.Z`.

## If the tag was wrong

A tag that doesn't match the version, or has no notes file, fails in `pack` before anything is
built, and no Release is created. Delete the tag (`git push --delete origin
vX.Y.Z && git tag -d vX.Y.Z`), fix, and re-tag.

To fix a published Release's title or notes, edit the notes file and run
`gh release edit vX.Y.Z --title "<first line without # >" --notes-file <rest>`.
