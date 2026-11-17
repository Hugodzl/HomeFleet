# Release candidates (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `vX.Y.Z-rc.N` candidates that carry the final `X.Y.Z` bytes, deliver and replace them on the rig with `--candidate <tag>`, and promote the last one to `vX.Y.Z` without rebuilding.

**Architecture:** The product side gets four things: a hash-keyed release cache, a record of the hash each node runs (`installed-release.json`), a candidate guard that allows a same-version reinstall when the bytes differ, and rollout progress by hash. HFP gains two optional fields. `release.yml` keeps its job chain and the `sign` job stays byte-for-byte the same. `pack` decides the mode (build, candidate or promote) through a tested script. In promote mode it downloads the candidate's tarball instead of packing one. `sign` re-signs the same digest, and Ed25519 is deterministic, so the manifest and signature come out identical too. The `release` job then checks those bytes against the candidate Release before it publishes.

**Tech Stack:** TypeScript, zod, vitest, Node 22 built-ins, GitHub Actions, `gh`.

**Spec:** `docs/specs/2026-11-12-release-candidates-design.md`: "PR 2 — release candidates", "When a candidate is required", "Process changes", "Testability", and the Status block. That block says PR 1 was built differently from the spec: `sign` downloads nothing and signs a digest, and the guards parse YAML.

## Global Constraints

- Nothing on the wire or in a manifest ever contains `-rc`. Versions stay strict `X.Y.Z` (`SemverSchema`, `ReleaseManifestSchema` unchanged).
- Candidate tag syntax, everywhere: `^v(\d+\.\d+\.\d+)-rc\.([1-9]\d*)$`. Any other prerelease suffix is refused.
- "The hash" is the manifest's `sha256` (the tarball's sha256). It shows as its first 12 characters.
- HFP changes are additive only: `UpgradeRequest.candidate?: boolean`, `NodeInfo.releaseSha256?: string` (64 lower-case hex). No new route, no `HFP_PROTOCOL_VERSION` bump.
- Without `--candidate`, behaviour is unchanged: `checkNewer` still refuses a same-version target, and the dashboard never offers or sends a candidate.
- The candidate guard runs in the daemon, not only in the CLI.
- Candidate pushes pull from the pushing node only, never from GitHub.
- The `sign` job and `SIGN_*` in `scripts/lib/workflow-guards.ts` stay as they are. `sign-release.mjs` changes only its tag check.
- Never start, stop or restart a real rig daemon. Tests use temp data dirs, test daemons and test keys.
- `packages/` changes, so this PR ships in a release. The bump is at least minor (a new CLI flag and HFP fields), so ask Hugo together with the merge.

## Review Focus

1. **A node on rc.1 that already caches rc.1 is pushed rc.2:** it must fetch rc.2 from the pusher. It must not reinstall its cache, and its rollback copy must be rc.1. → Task 4 (cache by hash) and Task 11 (integration test).
2. **A node left on 0.8.0 from an old candidate, plain `homefleet upgrade --to 0.8.0` or a fleet push of the final:** a plain by-version lookup must never reuse a cache entry that came from a candidate tag or a push. → Task 4, `by-version lookup ignores entries without the v<version> tag`.
3. **The same candidate pushed twice / `--candidate` for bytes already running:** this is a no-op (`same-release`, exit 0 in the CLI). It must never reinstall and never count as a failure in a rollout. → Tasks 5, 8 (`a same-release refusal counts as succeeded`) and 9.
6. **A peer on v0.7.0 or older gets a candidate of a newer version:** its old updater writes no `installed-release.json`, so it comes back on the target version with no hash. The rollout must count it as done, not time out. → Task 8 and Task 11.
7. **The rig's 0.8.0 nodes have no hash record** (they reached 0.8.0 through v0.7.0's updater). A pushed 0.9.0-rc.1 must still get a 0.8.0 rollback copy. → Task 6.
4. **An old daemon (v0.7.0) driven by a new CLI with `--candidate`:** the CLI prints a clear "this daemon is too old for --candidate" message, not a raw zod error. → Task 9.
5. **`installed-release.json` that is stale** (a manual `npm i -g` of another version) **or corrupt:** it is ignored unless its version equals the running `DAEMON_VERSION`, and the hash is then reported as unknown. → Task 3.

---

### Task 1: Release-tag parsing in scripts and the signer

**Files:**
- Modify: `scripts/lib/tag-version.ts`, `scripts/lib/tag-version.test.ts`
- Modify: `scripts/sign-release.mjs` (`digestFromEnv` tag check only), `scripts/sign-release.test.ts`

**Interfaces:**
- Produces: `parseReleaseTag(tag: string): { version: string; candidate?: number }` (throws on anything else); `checkTagVersion(tag, version)` (now: a candidate tag must carry its `X.Y.Z`); `highestCandidate(tags: string[], version: string): string | undefined` (highest `N` by number, not by string).

- [ ] **Step 1: Write the failing tests**

```ts
test("a candidate tag carries the final version", () => {
  expect(() => checkTagVersion("v0.8.0-rc.1", "0.8.0")).not.toThrow();
  expect(() => checkTagVersion("v0.8.0-rc.1", "0.8.0-rc.1")).toThrow();
});
test("any other prerelease suffix is refused", () => {
  for (const tag of ["v0.8.0-beta.1", "v0.8.0-rc.0", "v0.8.0-rc.01", "v0.8.0-rc1", "v0.8.0-rc.1.2"])
    expect(() => parseReleaseTag(tag), tag).toThrow();
});
test("highestCandidate picks rc.10 over rc.9 and ignores other versions", () => {
  expect(highestCandidate(["v0.8.0-rc.9", "v0.8.0-rc.10", "v0.8.1-rc.11", "v0.8.0"], "0.8.0")).toBe("v0.8.0-rc.10");
  expect(highestCandidate(["v0.8.0"], "0.8.0")).toBeUndefined();
});
```

Replace the old "prerelease tag matching a prerelease version passes" test. In `scripts/sign-release.test.ts`, add `--digest` runs with `GITHUB_REF`:
- `refs/tags/v0.8.0-rc.2` with version `0.8.0`: signs.
- `refs/tags/v0.8.0-rc.2` with version `0.8.1`: refused.
- `refs/tags/v0.8.0-beta.1` with version `0.8.0`: refused.
- `refs/tags/v0.8.0-rc.0` with version `0.8.0`: refused.

- [ ] **Step 2: Run** `pnpm vitest run scripts/lib/tag-version.test.ts scripts/sign-release.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** In `sign-release.mjs`, on a tag ref accept exactly `refs/tags/v${version}` or a ref that matches `^refs/tags/v(\d+\.\d+\.\d+)-rc\.[1-9]\d*$` with group 1 equal to `version`. Keep the file `node:`-only.
- [ ] **Step 4: Run the tests again.** They pass, and so does `scripts/lib/workflows.test.ts` (the guards are untouched).
- [ ] **Step 5: Commit** `release: candidate tags vX.Y.Z-rc.N carry the X.Y.Z tarball`.

### Task 2: Protocol fields

**Files:**
- Modify: `packages/protocol/src/upgrade.ts`, `packages/protocol/src/node.ts`, `packages/protocol/src/upgrade.test.ts`, `packages/protocol/src/node.test.ts`, `docs/rfc/hfp-v0.md` (Upgrade + NodeInfo sections)

**Interfaces:**
- Produces: `UpgradeRequestSchema.candidate: z.boolean().optional()`; `ReleaseSha256Schema = z.string().regex(/^[0-9a-f]{64}$/)` exported from `upgrade.ts`; `NodeInfoSchema.releaseSha256: ReleaseSha256Schema.optional()`.

- [ ] **Step 1: Write the failing tests.** The tests pin four things:
  - a request with `candidate: true` parses;
  - a request without it parses, as from an older peer;
  - `releaseSha256` accepts 64 hex and rejects uppercase or 63 characters;
  - a v0.7.0-shaped NodeInfo without the field still parses.
- [ ] **Step 2: Run** `pnpm vitest run packages/protocol`. Expected: FAIL.
- [ ] **Step 3: Implement the schemas.** Document both fields in `hfp-v0.md` as additive v0 changes:
  - `candidate`: same-version reinstall allowed when the hash differs, no GitHub fallback.
  - `releaseSha256`: absent when unknown.
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `protocol: optional UpgradeRequest.candidate and NodeInfo.releaseSha256`.

### Task 3: The installed-release record, and the updater's hash checks

**Files:**
- Modify: `packages/daemon/src/upgrade/files.ts`, `files.test.ts`, `updater.mjs`, `updater.test.ts`, `coordinator.ts` (only to set `toSha256: prepared.manifest.sha256` where it builds the `UpgradeState`, around line 199, so the task compiles)

**What the updater's hash check proves:** the updater writes the record itself just before launch, so a new daemon always reads the target hash. The check therefore catches one case: the old process still answering on the control port. Document this in a comment and in Task 13's docs; do not claim more.

**Interfaces:**
- Produces:
  - `INSTALLED_FILE = "installed-release.json"` in `<dataDir>`, holding `{ version, sha256 }`.
  - `writeInstalledRelease(dataDir, { version, sha256 })` (tests only; the updater writes its own copy).
  - `readInstalledReleaseSync(dataDir: string, runningVersion: string): string | undefined`. It returns the sha256 only when the file parses, the sha is 64 hex and `version === runningVersion`.
  - `UpgradeState` gains `toSha256: string`, `fromSha256?: string` and `candidate?: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - files: the record is returned for the matching version; it is `undefined` for another version, corrupt JSON, a bad sha or a missing file.
  - updater: `FAKE_DAEMON` reports `releaseSha256` read from `installed-release.json` at boot. The new tests:
    - `success writes installed-release.json with the target hash before launch`
    - `a rollback writes the from hash, or removes the record when fromSha256 is unknown`
    - `a failed install with no rollback removes the record`
    - `a failed rollback install removes the record` (`updater.mjs:135-149`)
    - `candidate: success needs the target hash, not just the version`: a stub daemon that ignores the record and keeps answering with the old hash on the control port (the "old process still up" case). Expect `rolled-back`.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/files.test.ts packages/daemon/src/upgrade/updater.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the updater changes.**
  - After a successful `install(tarball)` and before `launch()`, write `{ version, sha256 }`. That is `to`/`toSha256` for the target, and `from`/`fromSha256` for a rollback. When the rollback hash is unknown, remove the file.
  - On a failed install, on a failed rollback install, and on `recover` with no rollback copy, remove the file.
  - `reportsVersion(version, sha256?)` passes only when `daemonVersion === version` and, if `sha256` is given, `releaseSha256 === sha256`.
  - Pass `toSha256` when `state.candidate`, and pass `fromSha256` on a same-version rollback.
  - Keep the zero-dependency rule, and mirror the file name from `files.ts`.
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `upgrade: record the installed release hash; candidate installs check it`.

### Task 4: The release cache is keyed by hash

**Files:**
- Modify: `packages/daemon/src/upgrade/prepare.ts`, `prepare.test.ts`, `release-source.ts`, `release-source.test.ts`, `peer-release-source.ts`, `test-release.ts` (`FakeReleaseSource` takes an origin dir per tag, serves that tag's bytes, and records the tags it was asked for)

**Interfaces:**
- Layout: `<upgradesDir>/releases/<sha256>/` holds the three files plus `tags.json`, a JSON array of the GitHub tags this entry was fetched from. A pushed entry has `[]`. Legacy `upgrades/<version>/` dirs are ignored.
- `ReleaseSource.fetchRelease(version, destDir, options?: { tag?: string })`. `GitHubReleaseSource` uses `releases/download/${tag ?? `v${version}`}/`. `FallbackReleaseSource` passes the options through, and the peer source ignores them.
- `PrepareOptions` gains:
  - `sha256?: string`: only these bytes are acceptable.
  - `tag?: string`: the GitHub tag to fetch, recorded in `tags.json`. Default `v<version>` when `sha256` is absent.
  - `cacheOnly?: boolean`: never fetch; throw `fetch-failed` on a miss.
- `PreparedRelease` gains `sha256`, `manifestBytes: Buffer`, `signature: string` (trimmed) and `dir`.
- `readVerifiedCache(upgradesDir, query: { version: string; sha256?: string; tag?: string }, publicKeys?)` finds an entry three ways:
  - by `sha256`, a direct dir;
  - by `tag`, any entry whose `tags.json` includes it;
  - by version alone, an entry tagged `v<version>`.

  It then re-verifies the entry (signature, hash, `expectedVersion`) as today.

- [ ] **Step 1: Write the failing tests** (in `prepare.test.ts`, with two signed builds of `0.8.0`, A and B, using `writeSignedRelease(..., { content })`):
  - `a sha256 request misses a cache holding other bytes of the same version and fetches`
  - `a sha256 request whose fetched manifest has another hash fails verify-failed and leaves no entry`
  - `by-version lookup ignores entries without the v<version> tag` (A was cached by push or by `v0.8.0-rc.1`; a plain prepare of 0.8.0 fetches)
  - `a fetch by tag records the tag; the same bytes later fetched by v0.8.0 add that tag` (the promote case)
  - `cacheOnly never calls the source`
  - `two concurrent prepares of the same key share one fetch` (keeps the existing single-flight test passing)
  - `a staging dir from a failed fetch is removed`
  - `two prepares with different keys for the same bytes both succeed` (by `tag` and by `sha256` at once; the second rename finds the entry and keeps it)
  - `a hash-only fetch records tags: []`
  - `leftover staging-* dirs are removed on the next prepare`

  In `release-source.test.ts`, test `fetchRelease with tag downloads from that tag's URL`.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/prepare.test.ts packages/daemon/src/upgrade/release-source.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the cache.**
  - Fetch into `upgrades/staging-<randomUUID>/` and verify there, with `expectedVersion` plus `sha256` if given.
  - Then `rename` the staging dir to `releases/<sha>/`. If the target dir exists (rename fails with EEXIST, ENOTEMPTY or EPERM): when it verifies, keep it, delete the staging dir and merge the tag into `tags.json`; when it does not, remove it and retry the rename once.
  - Retry `rename` and `rm` on EBUSY/EPERM up to 5 times, 100 ms apart (Windows Defender briefly locks new files).
  - At the start of each prepare, remove `staging-*` dirs older than 1 hour.
  - Write `tags.json` through a temp file and a rename.
  - The single-flight key is `sha256 ?? tag ?? v<version>`.
- [ ] **Step 4: Update callers so `pnpm typecheck` passes:** `fleet-upgrade.ts` uses `prepared.manifestBytes` and `prepared.signature` instead of re-reading the files; `routes.ts` uses the new `readVerifiedCache` query. Run `pnpm vitest run packages/daemon/src/upgrade`. Expected: PASS.
- [ ] **Step 5: Commit** `upgrade: key the release cache by tarball hash`.

### Task 5: The candidate guard

**Files:**
- Modify: `packages/daemon/src/upgrade/guards.ts`, `guards.test.ts`, `errors.ts`

**Interfaces:**
- Produces:
  - `UpgradeErrorCode` adds `"same-release"`.
  - `checkCandidate(input: { current: string; currentSha256?: string; target: string; targetSha256: string }): UpgradeError | undefined`. It returns undefined when the target is newer, or when it is the same version and `currentSha256` is undefined or differs. It returns `same-release` when the version and hash are both equal, and `not-newer` when the target is older.
  - `GuardInput` gains `candidate?: { currentSha256?: string; targetSha256: string }`. With it, `checkUpgradeGuards` uses `checkCandidate` instead of `checkNewer`.

- [ ] **Step 1: Write the failing tests.** Cover the whole matrix: {newer, same version + different hash, same version + same hash, same version + unknown hash, older} × {with candidate, without}. Without `candidate`, the same version is always `not-newer`, which is unchanged.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/guards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Then map `same-release` in `control-server.ts` `upgradeErrorStatus` to 409 and in `routes.ts` `wireCode` to `UPGRADE_REJECTED`, with the reason text `already running these bytes`. Document that reason in `hfp-v0.md`'s Upgrade refusals.
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `upgrade: candidate guard allows a same-version reinstall of different bytes`.

### Task 6: The coordinator: candidate self-installs and candidate pushes

**Files:**
- Modify: `packages/daemon/src/upgrade/coordinator.ts`, `coordinator.test.ts`

**Interfaces:**
- Consumes: Task 4's `prepareRelease` options, Task 5's `checkCandidate` and `GuardInput.candidate`, Task 3's `UpgradeState` fields.
- Produces:
  - `UpgradeCoordinatorOptions.currentSha256?: string`.
  - `UpgradeSelfInput.candidate?: { tag?: string; sha256?: string }`. `tag` is a candidate or final tag, and the version comes from it. `sha256` asks for exact bytes, as in a rollout's self step; it needs `UpgradeSelfInput.version` too.
  - `UpgradeStarted` gains `sha256: string` and `candidate?: true`.

- [ ] **Step 1: Write the failing tests.**
  - `candidate self: same version, different hash → state has candidate, toSha256, fromSha256 and the rollback copy from the cache by hash`
  - `candidate self: same version, own hash unknown → proceeds with no rollback copy`
  - `candidate self: same hash → same-release, nothing spawned`
  - `candidate self: an older tag → not-newer before any download`
  - `plain self to the same version is still not-newer`
  - `pushed candidate: same version, different hash → accepted; the target comes from the peer only (the own source is never asked for the target version when the peer fetch fails, and lastUpgrade records failed)`
  - `pushed candidate of a newer version, own hash unknown → the rollback copy of the running version comes from the own source by version` (the rig's 0.8.0 → 0.9.0-rc.1 case)
  - `pushed candidate of a newer version, own hash known → the rollback copy comes from the cache by hash, else the own source, and is refused if its hash differs`
  - `pushed candidate with no address for the requester → refused before replying (fetch-failed)`
  - `pushed candidate, same hash → same-release before replying`
  - `a push without the candidate field to the same version → not-newer` (an old pusher)
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - **Target:** `prepare({ version, tag?, sha256? })`. Refuse `not-newer` before downloading when the version is lower.
  - **Guards:** `checkUpgradeGuards` with `candidate: { currentSha256, targetSha256: prepared.sha256 }`.
  - **Rollback, same version:** `prepare({ version: from, sha256: currentSha256, cacheOnly: true })`, or none when the hash is unknown.
  - **Rollback, older version:** `prepare({ version: from, sha256: currentSha256 })`, using the by-version source as today but requiring the hash when it is known.
  - **`acceptRemote` with `request.candidate === true`:** use `checkCandidate` against `verified.manifest.sha256` synchronously. The target comes from the `PeerReleaseSource` only. The rollback copy follows the two rollback rules above, using the node's own source (`this.options.source`), never the peer source, which serves only the pushed version (`peer-release-source.ts:57`). The `UpgradeState` gets `candidate`, `toSha256` and `fromSha256`. Split `runUpgrade`'s single `source` into `targetSource` and `rollbackSource`.
  - "Never fall back to GitHub" covers the candidate's bytes only; a final release fetched for the rollback copy is the same trust as today.
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `upgrade: candidate installs and pushes in the coordinator`.

### Task 7: The tarball route serves only the hash being pushed

**Files:**
- Modify: `packages/daemon/src/upgrade/routes.ts`, `fleet-upgrade.ts`, `routes.integration.test.ts`

**Interfaces:**
- Produces: `UpgradeRouteDeps.servedRelease: () => { version: string; sha256: string } | undefined`, the release this node's latest rollout pushed.
- Behaviour:
  - When `servedRelease()` names the requested version, the route serves `readVerifiedCache({ version, sha256 })`.
  - When it names another version or is undefined, it serves the `v<version>`-tagged entry. Today's behaviour stays for finals.
  - Otherwise it answers 404.
- `createFleetUpgradeSurface` keeps `served` and exposes it. It sets `served` only after the `rolloutBusy()` check and a successful prepare (`fleet-upgrade.ts:97-148`), right before `rollout.start`, so a refused second start never repoints a running rollout's route.
- Document the route's semantics in `hfp-v0.md` (around lines 666-672): it serves the bytes this node is currently pushing for that version, else the final release.

- [ ] **Step 1: Write the failing tests.**
  - `a node caching rc.1 and pushing rc.2 serves rc.2's bytes`. Both entries are cached; the route is asked for 0.8.0 after a candidate rollout starts.
  - `a refused second rollout start does not change the served release`.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/routes.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it,** and wire it in `daemon.ts`.
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `upgrade: the tarball route serves the pushed hash`.

### Task 8: Rollout progress by hash

**Files:**
- Modify: `packages/daemon/src/upgrade/rollout.ts`, `rollout.test.ts`, `files.ts` (`readRolloutStatusSync` keeps the optional `candidateSha256`)

**Interfaces:**
- Produces:
  - `RolloutStartInput.candidate?: boolean`.
  - `RolloutStatus.candidateSha256?: string`, present only for a candidate rollout.
  - `FleetRolloutOptions.currentSha256?: string`.
  - `restoreRolloutStatus(saved, { daemonVersion, releaseSha256?, lastUpgrade })`.
- `isDone(version, sha?, wasVersion?)` for a candidate rollout:
  - **selection** (before the push): done when the version is newer than the target, or equal with `sha === candidateSha256`.
  - **success** (after the push): done when the version is newer; or equal with `sha === candidateSha256`; or equal with `sha` absent and the peer was on an older version before the push (an old updater that writes no record).
  - A plain rollout keeps today's `compareSemver(version, target) >= 0`.
- A `same-release` refusal from a peer counts as `succeeded`, not `refused`.

- [ ] **Step 1: Write the failing tests.**
  - `candidate rollout: a peer on an older version comes back on the target with no hash → succeeded` (old updater)
  - `candidate rollout: a peer already on a newer version is skipped`
  - `candidate rollout: a same-release refusal counts as succeeded` (with `--nodes` naming a peer already on the candidate)
  - `candidate rollout selects same-version peers whose hash differs or is unknown, and skips peers already on it`
  - `candidate rollout: a peer back on the target version but the old hash keeps waiting, then succeeds on the new hash`
  - `candidate rollout: self is pending when its hash differs, skipped when equal`
  - `the push carries candidate: true; a plain rollout's push has no candidate key`
  - `restore: a candidate self step succeeds only on the candidate hash`
  - `self step calls upgradeSelf with candidate.sha256`
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/rollout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Replace each version comparison in `select`, the `self.state` init, the `rolloutPeer` success check and `restoreRolloutStatus` with an `isDone(version, sha?)` helper that is version-only for a plain rollout.
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `upgrade: candidate rollouts count progress by hash`.

### Task 9: Control API, CLI, status, and daemon wiring

**Files:**
- Modify:
  - `packages/daemon/src/control/messages.ts`, `control-server.ts` (+ test)
  - `packages/daemon/src/upgrade/fleet-upgrade.ts` (+ test)
  - `packages/daemon/src/cli/cli.ts`, `cli.test.ts`, `control-client.ts` (+ test)
  - `packages/daemon/src/daemon.ts`, `packages/daemon/src/node/node-info.ts` (+ test)
  - `packages/daemon/README.md` (CLI block = `USAGE`)

**Interfaces:**
- Control `UpgradeRequestSchema` gains `candidate: z.string().regex(CANDIDATE_OR_FINAL_TAG)`, where the pattern is `^v\d+\.\d+\.\d+(-rc\.[1-9]\d*)?$`. It is refused together with `version`.
- `ControlStatus.releaseSha256?: string`.
- `NodeInfoProviderOptions.releaseSha256?: string`.
- At boot, `daemon.ts` reads `readInstalledReleaseSync(dataDir, daemonVersion)` once. The value feeds NodeInfo, status, the coordinator and the rollout.
- CLI:
  - `homefleet upgrade --candidate <tag>` and `homefleet fleet upgrade --candidate <tag>`, each mutually exclusive with `--to` (usage error, exit 2).
  - `waitForUpgrade` succeeds on a candidate only when `status.releaseSha256 === started.sha256`.
  - `same-release` prints `Already running <tag> (sha256 <12>).` and exits 0.
  - Against an old daemon, which answers 400 because the v0.7.0 control schema is a `strictObject` that refuses the unknown `candidate` key, the CLI detects a 400 whose error names `candidate` and prints `The running homefleetd (<version>) does not support --candidate; upgrade it to a release first.`
  - `homefleet status` prints `releaseSha256: <12 chars | unknown>`.

- [ ] **Step 1: Write the failing tests.** Cover each CLI line above, plus:
  - the control schema refuses `version` + `candidate`, and a bad tag;
  - `fleet-upgrade` `candidate` resolves the version from the tag, prepares with `{ tag }`, and starts the rollout with `candidate: true`.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/cli packages/daemon/src/control packages/daemon/src/upgrade/fleet-upgrade.test.ts packages/daemon/src/node`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Then run `pnpm check:docs`; the README CLI block must equal `USAGE`.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `cli: homefleet upgrade/fleet upgrade --candidate <tag>; status shows the release hash`.

### Task 10: Dashboard peer row shows the hash

**Files:**
- Modify: `packages/daemon/src/dashboard/assets/view-model.js`, `view-model.d.ts`, `view-model.test.ts`, `app.js` (version cell)

- [ ] **Step 1: Write the failing test.** `nodeRows` gives `release: "abcdef012345"` for a peer with `releaseSha256`, and `DASH` without one. The status header shows `daemon 0.8.0 (abcdef012345)` when known.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/dashboard`. Expected: FAIL.
- [ ] **Step 3: Implement it.** The version cell renders `version` plus the short hash in a muted span. No new POST: `assets.scan.test.ts` stays unchanged and green. Add `dashboard assets never send a candidate field` to it (no `candidate` string in any request body built by the assets).
- [ ] **Step 4: Run the tests again.** They pass.
- [ ] **Step 5: Commit** `dashboard: show each node's release hash`.

### Task 11: Integration test: a candidate fleet push across test daemons

**Files:**
- Create: `packages/daemon/src/upgrade/candidate.integration.test.ts`. It reuses the `routes.integration.test.ts` harness: `createDaemonHarness`, `upgradeSeams` with a fake `spawnUpdater` and test `publicKeys`.

- [ ] **Step 1: Write the tests.** Three daemons: A is the requester, B and C are peers. All run `0.8.0`, with `installed-release.json` = rc.1's hash. B also caches rc.1. rc.1 and rc.2 are two signed builds of `0.8.0`.
  - `rc.1 → rc.2: A pushes the candidate; B and C pull rc.2 from A (their GitHub sources record no fetch); each state file has toSha256 = rc.2, fromSha256 = rc.1, and rollbackTarballPath inside releases/<rc.1>/`
  - `a peer already on rc.2 is skipped`
  - `with A's tarball route unreachable for B, B's push fails cleanly (lastUpgrade failed) and B's GitHub source is never asked`
  - `a peer that never received the candidate field (pushed without it) refuses the same-version push not-newer`
  - `a peer on 0.7.0 with a fake old updater that writes no record, pushed 0.8.0-rc.1, counts as succeeded once it reports 0.8.0`
  - The rolled-back path (`a failed rc.2 rolling back to rc.1`) is covered end to end by Task 3's updater test. That test drives the real `updater.mjs`, and here `spawnUpdater` is faked.
- [ ] **Step 2: Run** `pnpm vitest run packages/daemon/src/upgrade/candidate.integration.test.ts`. Expected: PASS. Fix any gap in the owning task, not in the test.
- [ ] **Step 3: Commit** `test: candidate fleet push across test daemons`.

### Task 12: `release.yml` candidate and promote paths

**Files:**
- Create: `scripts/release-plan.ts`, `scripts/lib/release-plan.ts`, `scripts/lib/release-plan.test.ts`
- Modify: `package.json` (`"release:plan": "tsx scripts/release-plan.ts"`), `.github/workflows/release.yml`, `scripts/lib/workflows.test.ts`

**Interfaces:**
- `planRelease({ ref, refName, releases: { tag: string; prerelease: boolean; draft: boolean }[] }): { mode: "build" | "candidate" | "promote"; final?: string; candidate?: string }`. Its rules:
  - A non-tag ref is `build`.
  - A candidate tag is `candidate`, with `final = vX.Y.Z`.
  - A final tag with published (non-draft) prerelease candidates of that version is `promote`, where `candidate = highestCandidate(...)`.
  - A final tag with no candidate is `build`.
  - A malformed tag throws.
- `release-plan.ts` reads `gh api repos/$GITHUB_REPOSITORY/releases --paginate --slurp` output (an array of pages, flattened) from a file argument and appends `mode=`, `final=` and `candidate=` to `$GITHUB_OUTPUT`.
- The `release` job does not trust `pack`'s `mode`/`candidate` outputs. It derives the plan itself with an inline bash step (`gh api --paginate --slurp ... | jq`, sorting rc numbers with `sort -V`), with no checkout of dependencies and no `pnpm install`, since this job holds `id-token` and `attestations` write. It re-checks the candidate's commit, and on promote `cmp`s both the tarball and `manifest.json` with the candidate Release's. A final tag with candidates where the two plans disagree fails the run.

- [ ] **Step 1: Write the failing tests.**
  - `release-plan.test.ts`: cover each mode, plus that draft and non-prerelease rc releases are ignored, that rc.10 beats rc.9, that a malformed tag throws, and that a two-page `--slurp` input finds a candidate on page 2.
  - `workflows.test.ts` (deliberate guard updates):
    - `pack outputs mode/final/candidate from release:plan`;
    - `pack's only token is github.token, set as GH_TOKEN on the plan and promote steps`;
    - `promote: pack refuses unless the final tag's commit equals the candidate's, then downloads and verify:release's the candidate`;
    - `a candidate is published --prerelease --latest=false`;
    - `promote: release re-derives the plan itself and cmps the tarball and manifest.json with the candidate Release's before publishing`;
    - `notes are read from docs/releases/<final>.md`;
    - `release needs pack, verify and smoke`, which replaces the `["verify", "smoke"]` pin.
  - The `sign` tests stay unchanged and must still pass.
- [ ] **Step 2: Run** `pnpm vitest run scripts`. Expected: the new tests fail.
- [ ] **Step 3: Implement the workflow.** All `needs.*.outputs` reach `run:` through `env:`, never inline.
  - **pack:**
    - A plan step (`id: plan`).
    - The notes check, against `docs/releases/$FINAL.md`, titled `# HomeFleet $FINAL — `.
    - On `promote`: check `git rev-list -n 1 "$CANDIDATE"` equals `$GITHUB_SHA`, then `gh release download "$CANDIDATE" -p 'homefleet-*' -D candidate`, then `pnpm verify:release candidate/homefleet-*.tgz`, then copy the tgz to `release/`.
    - Otherwise: `pnpm pack:release --tag`, unchanged.
  - **release:**
    - Title and body come from `$FINAL.md`. For a candidate, the title has `$FINAL` replaced by the tag with bash `${title/"$FINAL"/"$TAG"}` (not a sed regex), and the body starts with the line `> **Release candidate for testing on Hugo's rig — not for general use.** Promoted to $FINAL once it passes.`
    - Candidates publish with `--prerelease --latest=false`.
    - On promote, before `gh release create`: with the candidate from the release job's own plan, `gh release download "$CANDIDATE" -p 'homefleet-*' -D "$RUNNER_TEMP/candidate"` and `cmp` both the tgz and the manifest against `release/`, so the run fails if either differs.
- [ ] **Step 4: Run** `pnpm vitest run scripts`. Expected: PASS. Run zizmor locally if available (`zizmor .github/workflows`); otherwise CI's zizmor job is the check.
- [ ] **Step 5: Commit** `release: candidate prereleases and promote-without-rebuild`.

### Task 13: Docs and process

**Files:**
- Modify: `docs/reference/releasing.md` (new "Release candidates" section; Release flow steps 4–6; job list mentions the plan step and modes), `docs/specs/2026-11-12-release-candidates-design.md` (Status: record the deviation that promote re-signs the same digest instead of copying the candidate's signature, and that `release` cmps tarball and manifest), `docs/backlog.md` (deferred items: cache pruning, legacy `upgrades/<version>/` cleanup, stale hash after a manual same-version `npm i -g`, the record is per data dir while the npm install is per machine — workaround: delete `installed-release.json`)
- Note in releasing.md: a v0.7.0 peer still falls back to GitHub on a push (it ignores `candidate`); this is harmless, since GitHub has no candidate bytes under the final tag.
- Create: `docs/adr/0008-release-trust-and-candidates.md`
- Memory: `homefleet-release-flow.md` (cut a candidate unasked when one is required)

- [ ] **Step 1: Write the docs.** Cover when a candidate is required, the commands, how to promote, and why promote re-signs (deterministic Ed25519; identical bytes are checked twice, in `verify` and in `release`). The ADR covers the trust model and the considered-and-rejected list from the spec.
- [ ] **Step 2: Run** `pnpm check:docs && pnpm lint`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: release candidates (releasing.md, ADR 0008, spec status)`.

### After the tasks

1. Open the PR (draft) and get CI green on Ubuntu and Windows.
2. Run the review loop: a fresh `opus` reviewer subagent per round, `/code-review high` on the PR, with `releasing.md`'s risky-change checklist and Review Focus above in the brief. Fix should-fix and above test-first, and repeat until CLEAN. Then do one short check of the follow-up diff.
3. Update this plan's checkboxes and the spec Status.
4. Add Hugo's rig steps to the PR body. The first real candidate is the next release that needs one; this PR ships as an ordinary release.
5. Ask Hugo "merge + release v0.8.0?" with the impact.
