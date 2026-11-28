# ADR-0008: Release trust and release candidates

- **Status:** accepted (design approved by Hugo, 2026-11-12)
- **Date:** 2026-11-24

## Context

HomeFleet nodes upgrade themselves and each other with signed release
tarballs (`homefleet upgrade`, `homefleet fleet upgrade`, the dashboard). So
whoever can produce a signed release can run code on every node. Releases
were also doing two jobs: shipping to users, and proving a change on Hugo's
two-machine rig. Every rig proof was a public Release that any node's update
check would offer.

The design is in
[`specs/2026-11-12-release-candidates-design.md`](../specs/2026-11-12-release-candidates-design.md);
this records the decisions and what each check proves.

## Decision

**Who can produce a signed release.** Only the `sign` job of
`release.yml` can read the Ed25519 release key, an environment secret on
`release`. That environment admits only `main` and `v*` tags and waits for
Hugo's approval, which is the real gate. `sign` installs nothing and
downloads no artifact: it signs a digest (version, sha256, size) computed by
`pack`. `scripts/lib/workflows.test.ts` pins these properties.

**What each check proves.**

| Check | Proves |
| --- | --- |
| Hugo's approval of `release` | a person chose to sign this run's commit |
| `pack`'s tag-on-main check | catches a mistaken tag (not a defense: an edited workflow could drop it) |
| `verify` | the signature verifies under the key pinned in the daemon, and the real tarball matches the signed digest |
| `smoke` | the real tarball installs and runs on Ubuntu and Windows |
| build provenance attestation | which commit and workflow run built the bytes (SLSA Build L2) |
| a node's own check before installing | the manifest verifies under its pinned key, and the tarball matches it |

**Release candidates.** A `vX.Y.Z-rc.N` tag publishes the final `X.Y.Z`
tarball as a GitHub prerelease that is never "latest", so only an explicit
`--candidate <tag>` installs it. Because a candidate shares its version with
its final, nodes tell builds apart by the tarball's sha256: the cache is
keyed by it, `NodeInfo.releaseSha256` reports it, a same-version reinstall
is allowed only when it differs, and rollouts count progress by it. A
candidate push is fetched only from the pushing node.

**Promotion republishes the tested bytes.** The final tag goes on the last
candidate's commit. `pack` takes that candidate's tarball instead of
building, the unchanged `sign` job re-signs the same digest (Ed25519 is
deterministic, so the manifest and signature are identical), and `release`
compares the bytes with the candidate Release before publishing. No job
other than `sign` gains access to the key.

**When a candidate is required (decided by Hugo):** every minor and major
release, and patches that touch the upgrade path, daemon lifecycle, the HFP
protocol or auth.

## Considered and rejected

- **Semver prerelease versions** (`0.8.0-rc.1` as the package version): the
  bytes tested would not be the bytes shipped, since the final needs a
  rebuild with another version string; and every version comparison in the
  upgrade path would have to learn prerelease ordering.
- **Release Please or Changesets:** release PR automation for a project with
  one maintainer and one package adds a bot and a config to trust, for a
  four-line version bump.
- **npm publishing:** nodes install signed GitHub Release assets; a registry
  would add a second distribution channel and its credentials.
- **SLSA Build L3:** needs a hardened, isolated builder; L2 provenance from
  the GitHub-hosted runner is the honest level here.
- **An AI agent in CI** (review or release steps): it would run with the
  workflow's tokens and read untrusted text; agents work in sessions and
  PRs instead, where a person approves what ships.

## Consequences

- Hugo proves a build on the rig before anyone else can install it, and the
  final release is byte-identical to what he tested.
- v0.8.0 itself shipped as an ordinary release (v0.7.0 has no
  `--candidate`); nodes that reached it through v0.7.0's updater report
  their hash as unknown until their next upgrade.
- The plan rules exist twice, in TypeScript for `pack`
  (`scripts/lib/release-plan.ts`) and in bash in `release`, which must not
  trust `pack`. The workflow tests pin both.
