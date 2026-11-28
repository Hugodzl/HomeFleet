# Devlog 027: the first release through a candidate

**2026-11-28**

v0.8.0 adds release candidates. It was also the first release cut as one:
`v0.8.0-rc.1` went onto the rig, and `v0.8.0` was published 19 minutes later
with exactly the same bytes.

Release: [v0.8.0](../docs/releases/v0.8.0.md). PRs:
[25](https://github.com/Hugodzl/HomeFleet/pull/25) (release-trust hardening)
and [36](https://github.com/Hugodzl/HomeFleet/pull/36) (release candidates).
Design: [release candidates](../docs/specs/2026-11-12-release-candidates-design.md),
and [ADR 0008](../docs/adr/0008-release-trust-and-candidates.md).

## Why

[Devlog 026](2026-11-08-daemon-command.md) ended on this note: HomeFleet had no
pre-release channel. `homefleet upgrade` follows GitHub's `releases/latest`, so
the only way to put a build on the rig through the normal path was to make it
the public release. v0.5.3, v0.6.1 and v0.7.0 were all proven on the rig after
anyone could install them.

## What a candidate is

A candidate is the final `X.Y.Z` tarball published under a `vX.Y.Z-rc.N` tag,
as a GitHub prerelease that is never "latest". Update checks and the dashboard
never offer one. `homefleet fleet upgrade --candidate <tag>` installs one on
purpose.

The design question was how to tell two builds of one version apart. A semver
prerelease version (`0.8.0-rc.1` inside the package) was rejected: the final
would then be a rebuild, so the bytes tested would not be the bytes shipped.
The tarball's sha256 does the job instead:

- The release cache is keyed by it, so a cached candidate can never be
  mistaken for the final.
- Each node records the hash it runs, and reports it as
  `NodeInfo.releaseSha256`, in `homefleet status`, and in a new dashboard
  column.
- A candidate may reinstall the same version only when the hash differs, and a
  rollout counts a node as done only when it reports the candidate's hash.

Promotion is tagging `vX.Y.Z` on the last candidate's commit. The workflow
then takes the candidate's tarball instead of building, and the unchanged
signing job signs the same digest again. Ed25519 signatures are
deterministic and the manifest has no timestamp, so the signature comes out
identical. Before publishing, the release job compares the bytes with the
candidate Release.

## The review

PR 36 was about 4,600 lines, and it touches the upgrade path, the protocol and
the release workflow, so it got the independent review loop before merge.

- **The plan was reviewed before any code.** That review found two must-fix
  design gaps. A peer upgraded by v0.7.0's updater writes no hash, so a
  candidate rollout would have waited 3 minutes and stopped on it. And a
  pushed candidate had no rollback copy, because the pushing node only serves
  the version it pushes. Both were fixed in the plan.
- **Round 1 on the code** found one should-fix: if the updater could not write
  the hash record (an antivirus lock, a full disk) right after `npm i -g`, it
  crashed before relaunching, and the node was left with no daemon. Writing
  the record is now best effort.
- Round 1 also found that the release job's tag filter didn't escape dots on
  bash 5.2: `${final//./\\.}` leaves them unescaped. That one got a test that
  runs the workflow's own bash step against fake Releases.
- **Round 2**, on the fix diff only, came back clean. The deferred findings are
  in the [backlog](../docs/backlog.md#release-and-ci-follow-ups-from-the-2026-11-12-design).

## The bootstrap problem

v0.8.0 couldn't reach the rig the way later candidates will. The rig ran
v0.7.0, which has no `--candidate`. `homefleet fleet upgrade --to 0.8.0` looks
for a final `v0.8.0` Release, which didn't exist yet. The spec had planned an
ordinary release for this reason.

Hugo chose a candidate anyway, installed by hand: `homefleet daemon stop`,
`gh release download v0.8.0-rc.1`, `npm i -g` and `homefleet daemon start`, on
each machine. It cost one manual install per machine. In exchange, the
candidate and promote paths of the workflow ran for real on this release
instead of the next one. It was also the first run of the tsup 9 bins, which
only the release workflow's smoke job exercises.

## The rig check

- `v0.8.0-rc.1` was published at 16:41 UTC: a prerelease, not Latest, with its
  three assets.
- Hugo installed it by hand on both nodes and reported that it went well. As in
  devlog 026, this entry has his report, not a transcript.
- `v0.8.0` was tagged on the same commit. In its run, `pack` skipped the build
  and took the candidate's tarball, and the release job's byte comparison
  passed. It was published at 17:00 UTC.
- Downloaded afterwards, the final's tarball, manifest and signature are
  byte-identical to rc.1's (tarball sha256 `687217b8b37d…`). The identical
  signature is the deterministic re-sign working as designed.

What this does and doesn't prove:

- **Proven:** the candidate and promote paths of the release workflow, and a
  final release that is the exact bytes the rig ran.
- **Not run on the rig:** `--candidate` itself. A push between nodes, a
  same-version reinstall and a rollback by hash need a node already on v0.8.0,
  so they first run on the next release that needs a candidate. Both nodes
  report `releaseSha256: unknown` until then, because a manual install writes
  no record.

## Notes for next time

- The next minor release, and any patch that touches the upgrade path, the
  daemon lifecycle, the protocol or auth, now starts with `vX.Y.Z-rc.1`.
- Running the workflow's bash in a test caught something the YAML guards
  couldn't. The bash in a workflow is code, and it deserves tests.
- The tower's llama-server was down again before this check. Supervising the
  model server is still in the backlog.
