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
3. Update every user-facing text that names the current version or what has
   shipped: the README **Status** banner, the "currently vX.Y.Z" note in
   README **Install**, and the README **Roadmap** (mark items done with their
   version). Check the GitHub repo *About* description too (`gh repo view
   --json description`) and edit it with `gh repo edit --description` if it
   has gone stale. `git grep -n "v<previous>"` catches leftovers.
4. `pnpm lint && pnpm typecheck && pnpm test`, commit, push.
5. Optional dry run: `gh workflow run release.yml --ref main` — everything
   except the Release. The `pack` job must print `verified homefleet-X.Y.Z.tgz`.
6. `git tag vX.Y.Z && git push origin vX.Y.Z`. The `pack` job waits for
   approval on the `release` environment (see [Release signing](#release-signing)).

## Release signing

Every release publishes three assets: `homefleet-X.Y.Z.tgz`,
`homefleet-X.Y.Z.manifest.json` (version, sha256, size, HFP version) and
`homefleet-X.Y.Z.manifest.sig` (a detached Ed25519 signature over the
manifest bytes). `homefleet upgrade` installs only a tarball whose manifest
verifies under a key pinned in
`packages/daemon/src/upgrade/release-keys.ts`.

- The private key is the `HOMEFLEET_RELEASE_KEY` secret on the `release`
  GitHub **environment**, not a repo secret. The environment admits only
  `main` and `v*` tags and requires Hugo's approval, so a workflow edited on
  any other branch (including an agent's `claude/*` branch) can never read
  the key. An offline backup lives with Hugo.
- The `pack` job signs, then verifies against the pinned key, before
  anything is published.
- To sign a local build by hand (for example the rig rollback test):
  `pnpm sign:release <tgz> --key-file <pem>`, then
  `pnpm verify:release <tgz>`.
- **Rotating the key:** generate a new pair with `pnpm release:keygen`, ADD
  the new public key to `RELEASE_PUBLIC_KEYS` (keep the old one), ship a
  release still signed with the old key, and only then switch the secret.
  Nodes that never installed a release pinning the new key must be upgraded
  by hand.

## If the tag was wrong

A tag that doesn't match the version, or has no notes file, fails in `pack` before anything is
built, and no Release is created. Delete the tag (`git push --delete origin
vX.Y.Z && git tag -d vX.Y.Z`), fix, and re-tag.

To fix a published Release's title or notes, edit the notes file and run
`gh release edit vX.Y.Z --title "<first line without # >" --notes-file <rest>`.
