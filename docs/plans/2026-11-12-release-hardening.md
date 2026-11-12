# Release-trust hardening (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the release signing key away from installed dependencies, pin and audit the workflows, attest every release, and make CI gate merges into `main`.

**Architecture:** Signing moves out of the `pack` job into its own `sign` job. That job runs one dependency-free Node script on a runner with no `node_modules`. Every action is pinned to a commit SHA, `zizmor` audits the workflows in CI, and the publish job attests the assets and publishes the Release from a draft.

**Tech Stack:** GitHub Actions, Node 22 (`node:` built-ins only for the signer), TypeScript + vitest for tests, `zizmor`, Dependabot.

**Spec:** `docs/specs/2026-11-12-release-candidates-design.md`, section "PR 1 — release-trust hardening". PR 2 (release candidates) gets its own plan once this PR has merged.

## Global Constraints

- The `sign` job: no `pnpm install`, no `node_modules`, no setup-node `cache:`. It checks out only `scripts/sign-release.mjs` and `packages/protocol/src/version.ts`.
- `scripts/sign-release.mjs` imports only `node:` modules.
- Manifest bytes are exactly `serializeManifest`'s output: `JSON.stringify({ version, file, sha256, size, hfpVersion })` plus `"\n"`. The signature file is base64 plus `"\n"`.
- Every `uses:` that isn't a local `./` path is `owner/repo@<40-hex sha> # vX.Y.Z`. Keep each action's current major; Dependabot handles upgrades.
- Top-level `permissions: contents: read` in both workflows. Write scopes only on the publish job: `contents: write`, `id-token: write`, `attestations: write`.
- `actions/checkout` steps set `persist-credentials: false`.
- Never start, stop or restart a real rig daemon. Tests use temp dirs.
- No product code changes (`packages/` is untouched), so this PR ships no release (`releasing.md`, Release flow).
- The environment approval stays on the `release` environment, now attached to `sign`.

## Review Focus

1. **A `v*` tag on a commit that isn't on `main`:** `pack` fails with a clear error before `sign` asks for approval. Pinned in Task 3's workflow test, which requires that check to exist in `pack`.
2. **A missing, empty or non-Ed25519 `HOMEFLEET_RELEASE_KEY`:** `sign` fails with a one-line error and publishes nothing. Pinned in Task 1.
3. **The signer given zero or several tarballs** (an unmatched or doubled shell glob): it refuses with a usage error and doesn't sign "the first one". Pinned in Task 1.
4. **`version.ts` checked out with CRLF line endings on Windows,** or reformatted: the regex parser still finds `HFP_PROTOCOL_VERSION`. Pinned in Task 1, which parses a CRLF copy.
5. **A publish step that fails after the draft was created,** e.g. an attestation or network error: a re-run of the failed job must not die on "release already exists". Handled in Task 3: the publish step deletes an existing **draft** for the tag before creating, and never touches a published Release. `releasing.md` documents it (Task 5).

---

### Task 1: Dependency-free signer

**Files:**
- Create: `scripts/sign-release.mjs`
- Create: `scripts/sign-release.test.ts`
- Modify: `scripts/lib/sign-release.ts`: delete `signRelease`; keep `versionFromTarball` and `generateReleaseKeyPair`.
- Modify: `scripts/lib/sign-release.test.ts`: move the signing tests to the new file; keep the tests for the two remaining exports.
- Delete: `scripts/sign-release.ts`
- Modify: `package.json`: `"sign:release": "node scripts/sign-release.mjs"`

**Interfaces:**
- Produces: the CLI `node scripts/sign-release.mjs <tarball> [--key-file <pem>]`. The key comes from `--key-file` or the `HOMEFLEET_RELEASE_KEY` env var. It writes `homefleet-<v>.manifest.json` and `.manifest.sig` next to the tarball, and prints both paths, one per line. On error it prints `sign-release: <message>` to stderr and exits 1.
- The HFP version is read as text from `../packages/protocol/src/version.ts`, resolved relative to the script file with `import.meta.url`. A regex finds `export const HFP_PROTOCOL_VERSION = "X.Y.Z"` and tolerates CRLF. When the constant is absent or isn't `X.Y.Z`, the script exits 1 with `/HFP_PROTOCOL_VERSION/`. There is no override flag.
- The script exports nothing. Tests drive it only as a subprocess, so the `.ts` tests never import a `.mjs` file and `tsc -p scripts` stays unchanged.

- [ ] **Step 1: Write the failing tests** in `scripts/sign-release.test.ts`:
  - `"signs from a copy with no node_modules, and the daemon verifies it"`:
    - Copy `scripts/sign-release.mjs` to `<tmp>/scripts/` and `packages/protocol/src/version.ts` to `<tmp>/packages/protocol/src/`. Write `<tmp>/out/homefleet-0.5.0.tgz` = `"release bytes"`.
    - Run `process.execPath <tmp>/scripts/sign-release.mjs <tgz>` with `HOMEFLEET_RELEASE_KEY` = a `generateReleaseKeyPair()` private key, using `execFileSync` with `cwd: tmp`.
    - Expect `verifyRelease({ ..., publicKeys: [publicKeyBase64], expectedVersion: "0.5.0" })` to give `ok: true`.
    - Expect the manifest bytes to equal `serializeManifest({ version: "0.5.0", file: "homefleet-0.5.0.tgz", sha256, size, hfpVersion: HFP_PROTOCOL_VERSION })` (`hashFile` for the sha and size).
  - `"--key-file works and wins over the env var"`.
  - `"refuses a non-Ed25519 key"`: an RSA PEM gives exit 1, a stderr line matching `/Ed25519/`, and no manifest file.
  - `"refuses a missing or blank key"`: env unset gives exit 1 and stderr matching `/no signing key/`; whitespace-only gives the same.
  - `"refuses zero or several tarballs"`: no positional gives exit 1 with `/usage/`; two positionals give the same.
  - `"refuses a tarball not named homefleet-X.Y.Z.tgz"`.
  - `"reads the HFP version from a CRLF version.ts"`: with the copied `version.ts` converted to CRLF, the manifest's `hfpVersion` still equals `HFP_PROTOCOL_VERSION`.
  - `"refuses a version.ts without a valid HFP_PROTOCOL_VERSION"`: with the copy edited to `"0.4"`, the script exits 1 with stderr matching `/HFP_PROTOCOL_VERSION/`. With the constant removed, the same.

- [ ] **Step 2: Run to verify it fails**
  Run: `pnpm vitest run scripts/sign-release.test.ts`
  Expected: FAIL (the file `scripts/sign-release.mjs` doesn't exist).

- [ ] **Step 3: Implement `scripts/sign-release.mjs`**
  - Port `signRelease` from `scripts/lib/sign-release.ts` with `node:crypto`, `node:fs/promises`, `node:path`, `node:url` and `node:util` (`parseArgs`).
  - Hash with `createHash("sha256")` over a read stream.
  - Validate the version and file name with the same regexes as `ReleaseManifestSchema` (`/^\d+\.\d+\.\d+$/`, `/^homefleet-\d+\.\d+\.\d+\.tgz$/`). A JSDoc header explains why the script must stay dependency-free and points at the spec.

- [ ] **Step 4: Remove the old signer.** Delete `signRelease` and `scripts/sign-release.ts`, move the old signing tests over, and update `package.json`.

- [ ] **Step 5: Run to verify it passes**
  Run: `pnpm vitest run scripts/ && pnpm lint && pnpm typecheck`
  Expected: PASS, with no reference to `signRelease` left (`git grep -n signRelease` shows only the spec, plans and devlogs).

- [ ] **Step 6: Commit**
  `git commit -m "Dependency-free release signer (scripts/sign-release.mjs)"`

### Task 2: `verify:release` also checks the HFP version

**Files:**
- Create: `scripts/lib/hfp-version-check.ts`
- Create: `scripts/lib/hfp-version-check.test.ts`
- Modify: `scripts/verify-release.ts`

**Interfaces:**
- Consumes: Task 1's signer output.
- Produces: `checkSignedHfpVersion(signed: string, source: string): void`. It throws `Error("hfpVersion <signed> in the manifest is not this source's <source>")` when they differ. `verify-release.ts` calls it with `result.manifest.hfpVersion` and `HFP_PROTOCOL_VERSION` once `verifyRelease` returns `ok`, so a mismatch prints `verify-release: hfpVersion …` and exits 1. Success still prints `verified homefleet-X.Y.Z.tgz`.

This is the safety net for the signer reading `version.ts` as text: the `verify` job checks the signed value against the compiled constant.

- [ ] **Step 1: Write the failing tests:** `"equal versions pass"` (`checkSignedHfpVersion("0.4.0", "0.4.0")` doesn't throw) and `"a different signed version throws, naming both"` (`("9.9.9", "0.4.0")` throws matching `/9\.9\.9.*0\.4\.0/`).
- [ ] **Step 2: Run to verify it fails** (`pnpm vitest run scripts/lib/hfp-version-check.test.ts`): FAIL, module not found.
- [ ] **Step 3: Implement** the function, and call it in `verify-release.ts`.
- [ ] **Step 4: Run to verify it passes**, plus `pnpm lint && pnpm typecheck`.
- [ ] **Step 5: Commit** `"verify:release checks the signed HFP version"`

### Task 3: Restructure `release.yml`, and pin, scope and audit both workflows

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/lib/workflows.test.ts`

**Interfaces:**
- Consumes: Task 1's CLI and Task 2's `verify:release`.
- Produces: the job ids `gate`, `pack`, `sign`, `verify`, `smoke`, `release`. Artifacts are `homefleet-tarball` (the tgz, from `pack`) and `homefleet-release` (tgz + manifest + sig, from `sign`). In `ci.yml`, the job `zizmor` and the existing matrix job `test` produce the PR check names `test (ubuntu-latest)`, `test (windows-latest)` and `zizmor`. PR 2 builds on these ids.

The new release flow, job by job:

| Job | needs | What it does |
|---|---|---|
| `gate` | — | `uses: ./.github/workflows/ci.yml` (unchanged) |
| `pack` | gate | Checkout with `fetch-depth: 0`. On tag runs, `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`, else `::error::tag <tag> is not on main`. Then the notes check (unchanged), install, `pnpm pack:release …`, and upload `homefleet-tarball`. **No `environment`, no secrets.** |
| `sign` | pack | `environment: release`. Sparse checkout of the two files into `src/`, setup-node 22 with no cache, download `homefleet-tarball`, `node src/scripts/sign-release.mjs release/homefleet-*.tgz` with `HOMEFLEET_RELEASE_KEY`, and upload `homefleet-release`. |
| `verify` | sign | Checkout, install, download `homefleet-release`, `pnpm verify:release release/homefleet-*.tgz` |
| `smoke` | sign | Unchanged steps, but it downloads `homefleet-release` |
| `release` | verify, smoke | `if:` tag. Permissions `contents: write`, `id-token: write`, `attestations: write`. Download `homefleet-release`, run `actions/attest-build-provenance` with the tgz and manifest as subjects, then publish (below). |

Publishing works from a draft so it holds up with immutable releases:
1. If `gh release view "$TAG" --json isDraft` reports a draft, delete it (`gh release delete "$TAG" --yes`, keeping the tag). If it reports a published Release, fail with `::error::release <tag> is already published`.
2. `gh release create "$TAG" release/homefleet-* --draft --verify-tag --title … --notes-file …`
3. `gh release edit "$TAG" --draft=false`

- [ ] **Step 1: Write the failing test** `scripts/lib/workflows.test.ts`. It has no YAML dependency: it reads the files as text and splits jobs at lines matching `/^  ([a-z][\w-]*):\s*$/m` under `jobs:`. Tests:
  - `"every remote action is pinned to a commit SHA"`: every `uses:` line in `.github/workflows/*.yml`, except `./` ones, matches `/uses: [\w.-]+\/[\w.\/-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/`.
  - `"the job holding the release environment installs nothing"`: exactly one job contains `environment: release`, and it is `sign`. Its text contains none of `pnpm install`, `npm i`, `npm ci`, `cache:` or `pnpm/action-setup`, and its `sparse-checkout` lists exactly `scripts/sign-release.mjs` and `packages/protocol/src/version.ts`.
  - `"only the release job can write"`: both files have a top-level `permissions:` with `contents: read`, and no job other than `release` mentions `write`.
  - `"pack checks the tag is on main before anything is signed"`: the `pack` job contains `merge-base --is-ancestor`.
  - `"every checkout drops its credentials"`: each `actions/checkout` step block contains `persist-credentials: false`.
- [ ] **Step 2: Run to verify it fails** (`pnpm vitest run scripts/lib/workflows.test.ts`): FAIL on pinning and on the environment job.
- [ ] **Step 3: Resolve the SHAs.** For each action and current major (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`), plus the latest releases of `actions/attest-build-provenance` and `zizmorcore/zizmor-action`:
  - Take the newest `vX.Y.Z` tag in that major: `gh api repos/<owner>/<repo>/releases --jq '.[].tag_name'`.
  - Get its commit with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`, which resolves annotated tags to the commit.
- [ ] **Step 4: Rewrite both workflows** per the job table, the publish sequence and the Global Constraints.
  - In `ci.yml`, add the job `zizmor`: `runs-on: ubuntu-latest`, checkout, then `zizmorcore/zizmor-action` with SARIF/Advanced Security upload turned off, so findings fail the job. Check the action's README for the input name.
  - Keep the existing comments explaining why the key is environment-scoped, updated to name `sign`.
- [ ] **Step 5: Audit locally.** Run `uvx zizmor .github/workflows/`. Expected: no findings.
  - Fix findings rather than suppress them. Likely ones are `artipacked`, already handled by `persist-credentials`, and `cache-poisoning` on setup-node `cache: pnpm` in jobs reachable from a tag run; fix those by dropping the cache in `release.yml`'s jobs.
  - Allow a `# zizmor: ignore[<audit>]` only with a same-line reason, and list each one in the PR description.
- [ ] **Step 6: Create `.github/dependabot.yml`:** `version: 2`, two `updates` entries, each `directory: "/"`, `schedule.interval: weekly`, with one group matching `"*"`:
  - `package-ecosystem: github-actions`, group `actions`;
  - `package-ecosystem: npm`, group `npm`.
  No `cooldown:` block: the default 3 days is intended.
- [ ] **Step 7: Run** `pnpm vitest run scripts/lib/workflows.test.ts && pnpm lint && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 8: Commit** `"release.yml: isolated sign job, provenance, draft publish; pin and audit workflows"`

### Task 4: Push, and check the workflows on GitHub

**Files:** none new.

- [ ] **Step 1:** Push the branch and open a draft PR titled `Release-trust hardening: isolated signing, pinned actions, provenance`. The body summarizes the spec section and lists Hugo's post-merge steps (Task 6). End the body with the attribution line.
- [ ] **Step 2:** Expect CI to show three checks: `test (ubuntu-latest)`, `test (windows-latest)` and `zizmor`, all green. A zizmor failure here that didn't show up locally means the action runs a newer zizmor; fix the finding.
- [ ] **Step 3:** Run `gh workflow run release.yml --ref claude/ci-release-best-practices-8ba8fd`. Expected: `gate`, then `pack` green, then `sign` **rejected by the environment's branch policy**. That rejection is correct: it proves a branch run can't reach the key. Record the run URL for the PR description. Steps 4 to 6 aren't reachable before merge.
- [ ] **Step 4:** Bind the PR with the ccd_pr tools, and leave the CI watching to Auto-fix.

### Task 5: Docs

**Files:**
- Modify: `docs/reference/releasing.md`
- Modify: `README.md` (Install section, around line 99)
- Modify: `docs/backlog.md`
- Modify: `docs/specs/2026-11-12-release-candidates-design.md` (Status line only)

- [ ] **Step 1:** In `releasing.md`:
  - **Opening paragraph:** the new job chain.
  - **Release signing:** the key is read only by `sign`, which installs nothing. Replace the "can never read the key" sentence: a `v*` tag on any commit passes the environment filter, so before approving, check that the run's commit is on `main`. `pack`'s check catches mistakes, but a workflow edited on a branch could drop it.
  - **Local hand-signing:** `node scripts/sign-release.mjs <tgz> --key-file <pem>`, then `pnpm verify:release <tgz>`.
  - **New section "Verifying a release":** `gh attestation verify homefleet-X.Y.Z.tgz -R Hugodzl/HomeFleet`, and what it proves next to the signature.
  - **New section "Branch rule on `main`":** requires a PR (0 approvals) and the checks `test (ubuntu-latest)`, `test (windows-latest)` and `zizmor`; force-push and deletion are blocked for everyone. A rejected direct push to `main` is this rule.
  - **"If the tag was wrong":** with immutable releases, a **published** Release and its tag can't be changed, so a bad published release is fixed by a new patch version. A failed publish leaves at most a draft, which a re-run replaces.
- [ ] **Step 2:** In the README Install section, add one sentence after the `npm i -g` block: anyone can check a downloaded tarball with `gh attestation verify homefleet-<version>.tgz -R Hugodzl/HomeFleet`.
- [ ] **Step 3:** In `docs/backlog.md`, add a section "Release and CI follow-ups (from the 2026-11-12 design)" with the spec's four proposed follow-ups, one line each: `AGENTS.md`, mutation testing, `pnpm release:prep`, Scorecard.
- [ ] **Step 4:** Change the spec's Status line to: `PR 1 (hardening) implemented 2026-11-12, PR <n>; PR 2 (release candidates) not started.`
- [ ] **Step 5:** Run `pnpm lint`, `git grep -n "pnpm sign:release.*--key-file\|tsx scripts/sign-release"` (expected: no hits outside specs, plans and devlogs), then commit `"Docs: isolated signing, attestations, branch rule"` and push.

### Task 6: Independent review, then hand-off

This PR is risky under the independent-review rule: it changes release signing, workflow permissions and the CI gate.

- [ ] **Step 1:** Start a separate review session (`fresh`, `opus`) running `/code-review high` on the PR. The brief names the risky areas:
  - the key only reachable from `sign`, with nothing installed;
  - signer and manifest byte equality;
  - `permissions` scope;
  - draft-publish idempotency;
  - the tag-on-main check;
  - zizmor suppressions, if any.

  Ask for a verdict, findings by severity with `file:line`, a failure scenario and a fix for each, and what was verified versus only reasoned about.
- [ ] **Step 2:** Summarize for Hugo (verdict, must-fix, should-fix, follow-ups). Fix what he picks here, then get a re-review of the fix diff only.
- [ ] **Step 3:** Once the re-review is clean and CI is green, offer the merge. No release follows (no `packages/` change).
- [ ] **Step 4: Hugo's steps after merge,** given in the closing message as 🔵/🟢 walkthrough steps:
  - Run `gh workflow run release.yml --ref main` and approve `sign`. Expect `verify` to print `verified homefleet-0.7.0.tgz` and `smoke` to pass; no Release is created.
  - In Settings → Branches → `main` → Edit, turn on "Require a pull request before merging" (0 approvals) and "Require status checks to pass", adding the three checks.
  - In Settings → General → Releases, turn on immutable releases.
