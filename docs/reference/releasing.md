# Releasing

A `v*` tag on `main` runs [`.github/workflows/release.yml`](../../.github/workflows/release.yml):
the CI gate, then `pnpm pack:release --tag <tag>`, then a global install of
the real tarball on Ubuntu and Windows (bins must print their exact version),
then a GitHub Release with `homefleet-<version>.tgz` attached.

## Cutting a release

1. Bump the version in **all four** places — the pack refuses a tag that
   doesn't match, and `version.test.ts` refuses a drifted `DAEMON_VERSION`:
   `packages/{daemon,executors,protocol}/package.json` and
   `packages/daemon/src/version.ts`. Update `docs/rfc/hfp-v0.md`'s example
   `daemonVersion` too.
2. `pnpm lint && pnpm typecheck && pnpm test`, commit, push.
3. Optional dry run: `gh workflow run release.yml --ref main` — everything
   except the Release.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.

## If the tag was wrong

A tag that doesn't match the version fails in `pack` before anything is
built, and no Release is created. Delete the tag (`git push --delete origin
vX.Y.Z && git tag -d vX.Y.Z`), fix, and re-tag.
