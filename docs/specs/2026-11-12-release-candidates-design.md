# Release candidates and release-pipeline hardening — design

**Status:** proposed (2026-11-12). Brainstormed with Hugo after a research
pass on current CI/release practice (summary in [Background](#background)).

## Why

Releases have been doing two jobs: shipping to users and proving a change on
the real rig. v0.5.3 was the first release delivered by fleet push, v0.5.4
fixed the bug that push exposed, and v0.6.1 was cut partly to prove dashboard
upgrades on real hardware. Every one of those was a public Release that any
node's update check would offer. A release candidate (RC) lets Hugo prove a
build on the rig, through the same `homefleet fleet upgrade` path users run,
before anyone else can see it.

The same review found the pipeline's weakest point: the Ed25519 release key,
which every node trusts to auto-install code, is exposed to the whole npm
dependency tree. RCs add more signing runs, so that gets fixed first.

HomeFleet is also a portfolio piece. The pipeline should show deliberate
decisions, including what was considered and rejected, not a pile of every
practice on the internet.

## Goals

- Cut a candidate from `main` with a `vX.Y.Z-rc.N` tag. It is built, signed,
  smoke-tested and published as a GitHub **prerelease** that no node's update
  check ever offers.
- Deliver a candidate to the rig with fleet upgrade, including to peers still
  running the last release (v0.7.0 at the time of writing), with **no HFP
  breaking change**.
- Replace rc.1 with rc.2 on the rig, although both carry the same version.
- Promote a candidate to the final release **without rebuilding**: the final
  `vX.Y.Z` Release carries the candidate's exact bytes.
- Keep the release signing key away from installed dependencies.
- Pin and audit the workflows, and publish build provenance for every release.

## Non-goals

- Candidates for users. Candidates are Hugo's; there is no "beta channel"
  setting, and the dashboard never shows them.
- npm registry publishing. Releases stay GitHub Release assets.
- Automated changelogs or versioning tools (Release Please, Changesets). The
  hand-written notes are a deliverable.
- SLSA Build L3, merge queues, required PR approvals (GitHub does not let an
  author approve their own PR; this is a solo repo).

## Anti-goals

- A user's node offered, or auto-installing, a candidate.
- A final release whose bytes differ from the candidate Hugo tested.
- Any change in behavior for a plain `homefleet upgrade` / `fleet upgrade` /
  dashboard upgrade: same-version reinstalls stay refused unless the caller
  explicitly asks for a candidate.
- A check that must pass on the rig to pass CI. Everything stays testable on
  one machine (temp data dirs, test daemons, a test signing key).

## When a candidate is required (decided by Hugo)

- **Minor and major releases:** always.
- **Patch releases that touch risky code:** the upgrade path
  (`packages/daemon/src/upgrade/`), daemon start/stop/restart, the HFP
  protocol, or the control token / auth.
- **Other patches** (docs, labels, small visible fixes) go straight to a
  final release, as today.

## Background

The research behind this (sources in the brainstorm session, summarized):

- **Supply chain.** The 2026 tj-actions, Trivy and Nx incidents came through
  mutable action references. GitHub's own guidance and tools like `zizmor`
  push SHA-pinning, least-privilege `permissions:` and audited workflows.
  Install-time defenses (pnpm `minimumReleaseAge`, Dependabot's 3-day default
  cooldown) cover the dependency side.
- **Provenance.** GitHub artifact attestations give SLSA Build L2 provenance
  ("built from this commit by this workflow"), verifiable with
  `gh attestation verify`. That complements the Ed25519 signature ("Hugo's
  key approved this"), it doesn't replace it. Immutable releases (GA since
  2025-10) lock a published Release's assets and tag.
- **The AI era.** DORA 2025: AI raises throughput and lowers stability; it
  amplifies whatever practices exist; small batches and strong independent
  checks matter more. Studies of agent-authored PRs tie failed CI checks to
  rejection. PromptPwnd-class attacks hit AI agents run inside privileged CI
  on untrusted issue/PR text, which is a reason HomeFleet does **not** run an
  agent in CI.

## Design

Two PRs, in this order. PR 1 changes only workflows, scripts and docs. PR 2
is the product change plus the RC workflow.

### PR 1 — release-trust hardening

1. **Signing moves to its own job with no installed dependencies.** Today
   the `pack` job runs `pnpm install`, then signs with `pnpm sign:release`
   through `tsx` from `node_modules`. Any compromised dev dependency there
   could read `HOMEFLEET_RELEASE_KEY`, and a stolen key forges every future
   release the fleet will install. New job order:
   `gate → pack (no secrets) → sign (environment: release) → smoke → publish`.
   - `sign` downloads the tarball artifact, checks out only the signing
     script (sparse checkout, like `smoke`), and runs it with plain `node`.
     No `pnpm install`, no `node_modules`.
   - The signing script uses only `node:` built-ins. Today
     `scripts/lib/sign-release.ts` imports the daemon's manifest module,
     which imports `zod`, so it needs a dependency-free variant. A unit test
     must pin that its manifest bytes equal `serializeManifest`'s output for
     the same input, so CI and the verifier can never disagree. The signer
     also needs `HFP_PROTOCOL_VERSION` (today imported from
     `packages/protocol`); it gets it without importing dependency code, for
     example from the `pack` job as an input, with a test pinning it to the
     source.
   - Verification against the pinned key (`pnpm verify:release`) may stay in
     a job that has dependencies; it handles no secret.
   - The environment approval moves from `pack` to `sign`, so Hugo approves
     after CI and the pack have passed.
   - The threat this closes is key theft. A poisoned `pack` could still ship
     one bad tarball; provenance (item 4) makes that traceable to a commit
     and run, and the smoke still runs the real artifact.
2. **Pin every action to a full commit SHA**, with the version in a trailing
   comment (`uses: actions/checkout@<sha> # v4.x.y`). Add
   `.github/dependabot.yml` for `github-actions` and `npm`, weekly, grouped
   into one PR per ecosystem, keeping the default cooldown.
3. **Least privilege.** A top-level `permissions: contents: read` in
   `ci.yml`, and write scopes granted per job only where needed (`publish`:
   `contents: write`, plus what attestations need).
4. **Provenance.** The publish job attests the tarball and manifest with
   `actions/attest-build-provenance`. `releasing.md` and the README Install
   section show `gh attestation verify homefleet-X.Y.Z.tgz -R Hugodzl/HomeFleet`.
5. **Workflow audit.** Run `zizmor` on `.github/workflows/` in CI and fix its
   findings. It blocks merges (plain output mode; SARIF mode always exits 0).
6. **Tag-on-main check.** Before `sign`, the run fails unless the tagged
   commit is an ancestor of `origin/main`. This catches mistakes, not an
   attacker: a workflow edited on a branch could remove the check, which is
   why Hugo's approval stays the real gate.
7. **Fix the docs overclaim.** `releasing.md` says a workflow edited on
   another branch "can never read the key". A `v*` tag on any commit passes
   the environment's branch policy, so the approval is the only stop.
   Reword it to say that, and say what Hugo should check before approving
   (the run's commit is on `main`).
8. **Immutable releases.** Hugo turns the repo setting on (Settings →
   General → Releases). The publish step must attach all assets at creation:
   an immutable Release can't get assets after it is published. The builder
   verifies how `gh release create` with files behaves under immutability
   (it is expected to draft, upload, then publish) and adjusts if not.

### PR 2 — release candidates

#### Versions and tags

A candidate's tarball carries the **final** version. Tag `v0.8.0-rc.1` holds
`homefleet-0.8.0.tgz` and its manifest and signature, all saying `0.8.0`.
Nothing on the wire or in the manifest ever contains `-rc`.

This is what makes fleet delivery work. In a fleet push, a peer receives only
`{ version, manifest, signature }` (`UpgradeRequestSchema`) and pulls the
tarball from the pushing node. Versions are strict `X.Y.Z` on the wire, so a
peer on v0.7.0 accepts `0.8.0` but would reject `0.8.0-rc.1`. Real semver
prerelease versions were considered and rejected for that reason, and
because the final release would then be a rebuild.

`scripts/lib/tag-version.ts` changes accordingly: for a `vX.Y.Z-rc.N` tag the
packed version must equal `X.Y.Z`. Any other prerelease suffix is refused.

#### The workflow

`release.yml` keeps one entry point (`v*` tags plus `workflow_dispatch`) and
picks a path from the tag:

- **Candidate tag** `vX.Y.Z-rc.N`: the full PR 1 pipeline, then
  `gh release create --prerelease --latest=false`. Title
  `HomeFleet vX.Y.Z-rc.N — <theme>`; body = the same `docs/releases/vX.Y.Z.md`
  with a first line saying it is a release candidate for Hugo's rig, not for
  general use. The notes check in `release.yml` changes with this: it
  currently requires `docs/releases/<tag>.md` titled with the tag, so for a
  candidate tag it must look for `vX.Y.Z.md` titled `# HomeFleet vX.Y.Z — …`.
  No per-candidate notes files.
- **Final tag** `vX.Y.Z`, with at least one `vX.Y.Z-rc.*` Release existing:
  **promote**. The run fails unless the final tag's commit equals the commit
  of the highest-numbered candidate. It then downloads that candidate's three
  assets, re-checks sha256 and the signature against the pinned key, runs the
  smoke job on them, waits for Hugo's approval on the `release` environment,
  and publishes them unchanged as the final Release (normal title and notes,
  marked latest). Attestations are keyed by the artifact's digest, so the
  candidate's provenance also covers the final Release.
- **Final tag with no candidate** (an ordinary patch): the PR 1 pipeline,
  unchanged.

Candidate prereleases stay published as history after promotion.

#### When candidates are cut (my call)

Candidates are tagged on `main`, after the PR merges. A fix found on the rig
is a normal PR, merged, then `rc.N+1` from the new `main` head. The final tag
goes on the last candidate's commit. This keeps the tag-on-main check
meaningful and avoids rebase/merge-commit mismatches between a branch
candidate and the final commit. While a candidate is out, `main` holds
unreleased code; for a solo repo that's acceptable.

#### Product change: delivering and replacing a candidate

"The hash" below always means the manifest's `sha256` field: the
**tarball's** sha256. It is the same for a candidate and the final Release
promoted from it, and Hugo can compare it with the manifest asset on GitHub.

- **Fetching.** `homefleet upgrade --candidate <tag>` and
  `homefleet fleet upgrade --candidate <tag>`. `<tag>` is a candidate tag
  (`v0.8.0-rc.1`) or a final tag (`v0.8.0`). The final-tag form moves a node
  left on a superseded candidate onto the final bytes; it is a no-op where
  the hash already matches. Only the node the command runs on fetches from
  GitHub, from `releases/download/<tag>/`. It verifies the manifest as
  today, and the manifest version must equal the tag's `X.Y.Z`.
  `--candidate` and `--to` are mutually exclusive.
- **Same-version reinstall.** With `--candidate`, a node accepts a target
  equal to its running version when the target hash differs from the one it
  runs, or when its own hash is unknown. Without `--candidate`, `checkNewer`
  is unchanged and still refuses. The guard runs in the daemon (the
  receiving side), not only in the CLI.
- **The release cache is keyed by hash, not only by version.** Today
  `prepareRelease` reuses any verified `upgrades/<version>/` copy
  (`prepare.ts:95`), and the tarball route serves whatever is cached for a
  version. Left as is, a node holding rc.1 would "install" rc.1 again when
  asked for rc.2, and would serve rc.1 to peers. The cache must be checked
  against the requested manifest's hash: on a mismatch it refetches, and the
  tarball route serves only bytes matching the hash being pushed.
- **Rollback.** On a same-version reinstall, the rollback copy is the bytes
  the node was running (rc.1 when installing rc.2), kept apart from the new
  candidate, so a failed rc.2 restores rc.1 as today's rollback restores the
  previous version. Where the running bytes are unknown or uncached (the
  node runs 0.8.0 installed by v0.7.0 code), there is no rollback copy. This
  is the same best-effort case `coordinator.ts:184` already handles.
- **Success check.** The updater (`updater.mjs`) reports success when the
  restarted daemon's version equals the target. For a candidate install it
  must also check that the daemon reports the target hash; otherwise a
  reinstall that left rc.1 running would pass.
- **Telling the peer.** `UpgradeRequest` gains an optional
  `candidate: boolean`. Older peers' schema strips unknown keys, so this is
  additive. Peers on v0.7.0 never need it: the first candidate is newer
  than what they run. Document it in `docs/rfc/hfp-v0.md` as an additive v0
  change.
- **No GitHub fallback on a candidate push.** A peer that can't pull the
  tarball from the pushing node normally falls back to GitHub by version
  (`release-source.ts:72`, `releases/download/v<version>/`). For a candidate
  that is the wrong tag: a 404 before promotion, and different bytes after.
  Candidate pushes pull from the pushing node only, and fail cleanly if that
  fails.
- **Knowing what a node runs.** At install, a node writes the installed
  hash to its data dir. `NodeInfo` and `/control/status` gain an optional
  `releaseSha256` (absent when unknown), and `homefleet status` and the
  dashboard peer row show its first 12 characters. That's how Hugo tells
  rc.1 from rc.2.
- **The rollout's progress logic.** `rollout.ts` decides pending, skipped
  and succeeded by version (lines 155, 245, 312, 407). In a candidate
  rollout, a node counts as done only when its `releaseSha256` equals the
  candidate's, so an rc.2 push doesn't skip nodes already on rc.1.
- **The dashboard** never offers candidates. Its "available" check keeps
  using the latest Release, which GitHub defines as the newest
  non-prerelease.

#### Bootstrap

PR 2 itself can't be tested as a candidate: v0.7.0 has no `--candidate`. It
ships as an ordinary release, with the hardware check done after release as
today. The first real candidate is the next release that needs one.

### Process changes

- **`docs/reference/releasing.md`:** a "Release candidates" section covering
  when one is required (above), the commands, and how to promote. The
  Release flow becomes: merge → tag `vX.Y.Z-rc.1` → Hugo approves → Hugo
  runs `homefleet fleet upgrade --candidate vX.Y.Z-rc.1` plus the PR's
  hardware checks → fixes as PRs → `rc.N+1` → tag `vX.Y.Z` on the last
  candidate's commit → approve → published.
- **The memory rule `homefleet-release-flow`** gets the same update, so a
  Claude session cuts a candidate unasked when one is required.
- **ADR 0008, "Release trust and candidates":** records the trust model (who
  can produce a signed release, what each check proves) and the
  considered-and-rejected list: semver prerelease versions, Release Please
  and Changesets, npm publishing, SLSA L3, an AI agent in CI.

## Testability

- Tag/version parsing, the dependency-free manifest serializer, the
  candidate guard (same version: different hash / same hash / unknown, with
  and without the flag) and candidate rollout progress are unit tests.
- Candidate fleet push across N test daemons, with `test-release.ts` signing
  two builds of the same version, as an integration test. That covers rc.1 →
  rc.2 (including a node that already caches rc.1), a failed rc.2 rolling
  back to rc.1, and a peer that never received the `candidate` field.
- Workflow paths: `workflow_dispatch` dry runs cover the build path. The
  candidate and promote paths get their first real run on the next release
  that needs a candidate; the PR lists that as a check for Hugo.

## Calls made by Claude (not discussed with Hugo)

- Candidates are cut from `main` after merge, not from PR branches.
- The `--candidate <tag>` flag name and shape.
- Promotion requires the final tag on the same commit as the last candidate,
  waits for the same environment approval, and re-runs smoke.
- Candidate prereleases are kept after promotion.
- `NodeInfo.releaseSha256` as an optional field, shown as 12 characters.
- "The hash" is the tarball's sha256 (the manifest's `sha256` field).
- `--candidate` also accepts a final tag, to move a node off a superseded
  candidate.
- Rollback on a same-version reinstall restores the bytes the node was
  running; there is none when those are unknown.
- Candidate pushes never fall back to GitHub.
- `zizmor` blocks merges; Dependabot runs weekly, grouped.
- PR 1 before PR 2.

## Left to the builder

- How the dependency-free signing script is written and run (plain `.mjs`,
  or `.ts` with Node's type stripping), as long as it uses only `node:`
  built-ins and is pinned to the shared serializer by a test.
- Exact `zizmor` configuration and how to fix each finding.
- Where the installed hash is stored and its file format.
- How the promote job finds the highest-numbered candidate.

## Proposed follow-ups (backlog, not this design)

- A root `AGENTS.md` that makes the agent working rules visible in the repo
  (independent review, release flow, rig safety). Today they live in Hugo's
  private Claude memory.
- Non-blocking mutation testing (e.g. Stryker) on `upgrade/` and the auth
  code, reported per PR. Agents write both the code and its tests, so
  coverage alone proves little.
- A `pnpm release:prep X.Y.Z` script for the four-place version bump.
- An OpenSSF Scorecard run, with the expected ceiling for a solo repo
  explained rather than chased.
