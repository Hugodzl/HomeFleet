# Releasing

A `v*` tag on `main` runs [`.github/workflows/release.yml`](../../.github/workflows/release.yml),
job by job. The tag picks the mode (see [Release candidates](#release-candidates)):
`vX.Y.Z-rc.N` publishes a **candidate**, a final `vX.Y.Z` with published
candidates **promotes** the last one, and any other final tag is a plain
**build**.

1. **`gate`:** the CI workflow (tests on Ubuntu and Windows, plus `zizmor`).
2. **`pack`:** checks that the tagged commit is on `main`, plans the run
   (`pnpm release:plan`), checks that the notes file of the final version
   exists, then runs `pnpm pack:release --tag <tag>` (or, on a promote, takes
   the candidate's tarball and verifies it) and outputs the tarball's
   version, sha256 and size. It holds no secret.
3. **`sign`:** signs that digest without ever receiving the tarball (see
   [Release signing](#release-signing)). It waits for Hugo's approval.
4. **`verify`** and **`smoke`**, in parallel:
   - `verify` checks the signature against the pinned key, the real tarball
     against the signed digest, and the signed HFP version against the
     source.
   - `smoke` installs the real tarball globally on Ubuntu and Windows; the
     bins must print their exact version.
5. **`release`:** plans the run again from the tag and the published
   Releases (it never trusts `pack`'s plan), on a promote checks the tarball
   and manifest byte for byte against the candidate Release, attests the
   assets and publishes a GitHub Release with them, titled and described
   from `docs/releases/vX.Y.Z.md`. A candidate is a prerelease that never
   becomes "latest".

## Release flow

Any PR that changes shipped behaviour (code under `packages/`) ships in a
release. Docs-only PRs (devlogs, specs, plans, this file) don't. A Claude
session runs this flow every time, without being asked:

1. **Pick the version** when the PR is ready to merge:
   - **Patch** (`0.6.4` → `0.6.5`): fixes and small visible changes, with no
     new command, route or protocol change.
   - **Minor** (`0.6.x` → `0.7.0`): a new command, control or HFP route,
     config section, or protocol version.
   - **Major** (`1.0.0`): only when Hugo calls it.
2. **Ask before any minor or major bump.** Ask once, together with the merge.
   Say what ships, what upgrading does to the rig (daemon restart, new
   permissions or config, version-skew limits), and what still needs a
   hardware check. A patch bump doesn't need its own approval; it rides on
   the merge approval.
3. **Once approved, the prep is part of the job, not a separate request.**
   - **Where:** add a "Release prep: vX.Y.Z" commit to the feature PR, as
     v0.6.4 did. Use a separate prep PR only if the feature PR is already
     merged.
   - **What:** it covers steps 1–3 of [Cutting a release](#cutting-a-release):
     the four version places plus the RFC example, `docs/releases/vX.Y.Z.md`,
     and the README Status banner, Install note and Roadmap.
   - **Before merging:** `git grep` for the previous version, and wait for CI
     to pass on the prep commit.
4. **Merge, then tag.** When a candidate is required (see
   [Release candidates](#release-candidates)), tag `vX.Y.Z-rc.1` first and
   cut it without being asked; otherwise tag `vX.Y.Z`
   (`git tag <tag> && git push origin <tag>`). The `sign` job waits for Hugo
   to approve the `release` environment. That approval is the last human
   gate. Before approving, check that the run's commit is the merge on `main`
   (see [Release signing](#release-signing)).
5. **After the Release is published**, check:
   - the three assets are present
   - the repo About description is still accurate
   - the bump is a milestone (a minor or major release), in which case
     propose the devlog entry
6. **Give Hugo the rig steps** in the closing message. For a candidate:
   `homefleet fleet upgrade --candidate vX.Y.Z-rc.N` plus the PR's hardware
   checks; fixes land as PRs and get `rc.N+1`; once a candidate passes, tag
   `vX.Y.Z` on its commit to promote it. For a final: **Upgrade all** or
   `homefleet fleet upgrade`. Claude never upgrades or restarts the real rig
   daemons from its own shell.

Risky PRs go through [Reviewing a risky change](#reviewing-a-risky-change)
before step 1. A release-prep commit added after a clean review doesn't need
another review.

## Release candidates

A release candidate is the final `X.Y.Z` tarball published under a
`vX.Y.Z-rc.N` tag as a GitHub **prerelease**. Update checks, the dashboard
and a plain `homefleet upgrade` never see it (GitHub's "latest" is always a
final). Hugo installs it on the rig on purpose, through the same push path
users run, before anyone else can.

**When one is required (decided by Hugo):**

- **Minor and major releases:** always.
- **Patches that touch risky code:** the upgrade path
  (`packages/daemon/src/upgrade/`), daemon start/stop/restart, the HFP
  protocol, or the control token / auth.
- **Other patches** (docs, labels, small visible fixes) go straight to a
  final release.

**The flow:** merge → tag `vX.Y.Z-rc.1` on the merge commit → Hugo approves
`sign` → Hugo runs `homefleet fleet upgrade --candidate vX.Y.Z-rc.1` and the
PR's hardware checks → any fix lands as a PR and gets `vX.Y.Z-rc.2`, and so
on → tag `vX.Y.Z` **on the last candidate's commit** → Hugo approves `sign`
again → the final is published.

**Commands:**

- `homefleet upgrade --candidate <tag>` upgrades this node;
  `homefleet fleet upgrade --candidate <tag>` rolls it out to the peers and
  then this node. `<tag>` is `vX.Y.Z-rc.N`, or a final `vX.Y.Z` to move a
  node off a superseded candidate. A node already running those exact bytes
  answers "Already running …" and nothing happens.
- A candidate has the same version as its final, so nodes tell builds apart
  by the tarball's sha256: `homefleet status` prints `releaseSha256`, the
  dashboard shows a **Release** column, and `NodeInfo.releaseSha256` carries
  it over HFP. A node that has never been upgraded by a release with this
  feature reports it as unknown.
- A candidate push is fetched only from the pushing node, never from GitHub.
  A peer still on v0.7.0 ignores the `candidate` field: it accepts a newer
  version normally (and may fall back to GitHub, which has no candidate
  bytes under the final tag, so the fetch just fails) and refuses a
  same-version push as not newer.

**How promote works.** The final tag must be on the same commit as the
highest published candidate (by number: `rc.10` beats `rc.9`). `pack` then
downloads that candidate's tarball and verifies it against the pinned key
instead of building. The unchanged `sign` job signs its digest again:
Ed25519 signing is deterministic and the manifest has no timestamp, so the
manifest and signature come out byte-identical to the candidate's. The
bytes are then checked twice: `verify` checks the signature against the
pinned key and the tarball against the signed digest, and `release`
compares the tarball and manifest with the candidate Release's before
publishing. Candidate prereleases are kept after promotion.

**Bootstrap:** v0.8.0, which added candidates, shipped as an ordinary
release: v0.7.0 has no `--candidate`. Nodes that reached v0.8.0 through
v0.7.0's updater report their hash as unknown until their next upgrade.

**What the updater's hash check proves.** After installing, the updater
writes `<dataDir>/installed-release.json` (`{ version, sha256 }`) before it
relaunches the daemon, which reads it once at boot and trusts it only for
its own version. For a candidate, success needs the relaunched daemon to
report the target hash. Because the updater writes the record itself, this
catches the old process still answering on the control port; it does not
prove which bytes npm put on disk (the signature and hash checks before the
install do that). After a manual `npm i -g` of the same version, delete
`installed-release.json` so the node reports its hash as unknown.

## Reviewing a risky change

Before merging a change that touches the control token or auth, kills or
restarts the daemon, adds a control or HFP route, or runs concurrent work,
get an independent review in a session that didn't write it. Then re-review
the fix diff. Green CI only proves the tests that exist; PR 22 passed CI and
still had two must-fix bugs. The reviewer's brief should include this
checklist. Every item comes from a bug a review actually found:

- **Enforced in the daemon, not only the CLI or the page.** If the daemon
  must refuse something (busy jobs, a rollout in progress), the route refuses
  it with a 409, the way `checkUpgradeGuards` does. A CLI-side check is a
  convenience, not a guard. (PR 22: the jobs refusal was CLI-only.)
- **The same request twice.** A second shutdown, prepare or rollout request
  must be idempotent or refused, never escalate. (PR 22: a second shutdown
  forced an exit mid-teardown.)
- **Check, then act.** Anything read before acting can change in between: a
  job count, a cached file another request is writing, a saved record from a
  previous run. (v0.6.0: two prepares deleted each other's cache; the
  dashboard took an old rollout record for the new one.)
- **Reused ids.** A pid, port or rollout id can belong to something else by
  the time you use it. Confirm identity before killing or matching. (PR 22:
  the kill fallback.)
- **Version skew both ways.** A new CLI against an older daemon, and a new
  daemon against an older peer or CLI, must fail with a clear message.
- **Mutating routes stay off the dashboard.** New POSTs need the per-boot
  token, and `assets.scan.test.ts` must still pin which POSTs the page can
  make.
- **Windows specifics.** `process.kill` is TerminateProcess, so no shutdown
  code runs; mode 0600 is ignored; a Claude desktop shell runs inside an MSIX
  package with a virtualized `%LOCALAPPDATA%`.
- **Docs match the code.** The spec, plan, README and `docs/backlog.md` name
  only things that exist. Deferred findings go into the backlog.

Reviews and tests never start, stop or restart the real rig daemon. Use temp
data dirs. What needs hardware goes into the PR as steps for Hugo.

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
   README **Install**, the README **Roadmap** (mark items done with their
   version), a row in README **Proven on real hardware** for a new minor, and
   the feature list in **What it does today** when the release adds one.
   `pnpm check:docs` enforces the mechanical part, and it runs in CI, so the
   prep PR can't go green without it:
   - the Status banner and the "currently vX.Y.Z" note name the new version;
   - the Roadmap mentions the new minor (`vX.Y`) and the hardware table has a
     row for it;
   - `docs/releases/vX.Y.Z.md` exists;
   - the CLI block in `packages/daemon/README.md` equals the `USAGE` text in
     `packages/daemon/src/cli/cli.ts`, and every top-level command is
     mentioned in the README.

   It can't judge prose, so still reread the Status banner and the feature
   list, and check the GitHub repo *About* description (`gh repo view
   --json description`); edit it with `gh repo edit --description` if it
   has gone stale. `git grep -n "v<previous>"` catches leftovers.
4. `pnpm lint && pnpm typecheck && pnpm test`, commit, push.
5. Optional dry run: `gh workflow run release.yml --ref main` — everything
   except the Release. The `verify` job must print `verified homefleet-X.Y.Z.tgz`.
   A dry run from any other branch stops at `sign`: the environment refuses
   it, which is the point.
6. `git tag vX.Y.Z && git push origin vX.Y.Z`. The `sign` job waits for
   approval on the `release` environment (see [Release signing](#release-signing)).

## Release signing

Every release publishes three assets: `homefleet-X.Y.Z.tgz`,
`homefleet-X.Y.Z.manifest.json` (version, sha256, size, HFP version) and
`homefleet-X.Y.Z.manifest.sig` (a detached Ed25519 signature over the
manifest bytes). `homefleet upgrade` installs only a tarball whose manifest
verifies under a key pinned in
`packages/daemon/src/upgrade/release-keys.ts`.

- The private key is the `HOMEFLEET_RELEASE_KEY` secret on the `release`
  GitHub **environment**, not a repo secret. An offline backup lives with
  Hugo.
- **Only the `sign` job can read it, and that job installs nothing.** It has
  no pnpm and no `node_modules`, and it checks out only
  `scripts/sign-release.mjs` (`node:` built-ins only) and
  `packages/protocol/src/version.ts`, which the signer reads as text for the
  HFP version. So no npm dependency ever runs next to the key.
- **It downloads no artifact either.** It signs the digest `pack` computed
  (`node scripts/sign-release.mjs --digest <dir>`, which validates each
  value), so no file `pack` produced, whose job does run dependencies, can
  land next to the key and overwrite the signer or the Node it runs on. A
  `pack` that lies about the digest gets it signed but fails `verify`, which
  hashes the real tarball before anything is published. On a tag run the
  signer signs only the tag's own version, and the signature artifact
  expires after a day, so a bogus signed manifest can't linger. Re-running
  the release more than a day later means re-running the whole workflow.
- `scripts/lib/workflows.test.ts` pins all of this, reading the workflows
  with a real YAML parser (`yaml`, a dev dependency that never runs in
  `sign`).
- **The environment admits only `main` and `v*` tags, and requires Hugo's
  approval.** A run from a branch (including an agent's `claude/*` branch)
  can't reach the key. A `v*` tag on *any* commit does pass the filter,
  though, and that commit's workflow is what runs. `pack` refuses a tag
  whose commit isn't on `main`, but that check catches mistakes only: an
  edited workflow could drop it. **Hugo's approval is the real gate:**
  before approving, check that the run's commit is on `main`.
- `verify` then checks the signature against the pinned key, and the signed
  HFP version against the source, before anything is published.
- To sign a local build by hand (for example the rig rollback test):
  `pnpm sign:release <tgz> --key-file <pem>`, then
  `pnpm verify:release <tgz>`.
- **Rotating the key:** generate a new pair with `pnpm release:keygen`, ADD
  the new public key to `RELEASE_PUBLIC_KEYS` (keep the old one), ship a
  release still signed with the old key, and only then switch the secret.
  Nodes that never installed a release pinning the new key must be upgraded
  by hand.

## Verifying a release

Anyone can check a downloaded release two ways:

- **The signature**, which is what `homefleet upgrade` checks: the manifest
  is signed by a key pinned in the daemon. That proves Hugo's release key
  approved these bytes.
- **The provenance attestation:**
  `gh attestation verify homefleet-X.Y.Z.tgz -R Hugodzl/HomeFleet` (also
  works for the `.manifest.json`). That proves which commit and which
  workflow run built them (SLSA Build L2). Releases up to v0.7.0 have no
  attestation; the first release cut after this pipeline change does.

Neither one replaces the other.

## Branch rule on `main`

`main` requires a pull request, with 0 approvals, because GitHub never
lets an author approve their own PR. The checks `test (ubuntu-latest)`,
`test (windows-latest)` and `zizmor` must pass, and the branch must be up to
date. Force-pushes and deletion are blocked, admins included. So a rejected
direct push to `main` is this rule, not a fault: open a PR. The `zizmor-online`
check (zizmor's network audits, pull requests only) is advisory, not
required: the release gate runs zizmor offline so it stays deterministic. Tags aren't
covered, and `v*` tags are still pushed directly.

## If the tag was wrong

A tag that doesn't match the version, or has no notes file, fails in `pack` before anything is
built, and no Release is created. Delete the tag (`git push --delete origin
vX.Y.Z && git tag -d vX.Y.Z`), fix, and re-tag.

Releases are immutable once published: their assets and tag can't change.
A bad published release is fixed by a new patch version, never by
re-uploading. A run that fails while publishing leaves at most a draft,
which re-running the `release` job replaces.

To fix a published Release's title or notes, edit the notes file and run
`gh release edit vX.Y.Z --title "<first line without # >" --notes-file <rest>`.
