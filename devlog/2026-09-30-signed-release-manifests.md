# Devlog 021: signed release manifests

**2026-09-30**

The first slice of fleet upgrade (Phase 1) is in: strict `X.Y.Z` semver
helpers, a signed release manifest with `verifyRelease`, and the
`release:keygen` / `sign:release` / `verify:release` scripts. Nothing calls
the verifier in production yet, and no key is pinned. `RELEASE_PUBLIC_KEYS`
is empty on purpose, so every verification fails closed until the real key
is generated (plan Task 4, which is waiting on a key-custody decision).

Plan: [2026-09-25-fleet-upgrade-phase-1-2.md](../docs/plans/2026-09-25-fleet-upgrade-phase-1-2.md), Tasks 1–3.
Spec: [fleet upgrade design](../docs/specs/2026-09-25-fleet-upgrade-design.md).

## Why sign manifests at all

A HomeFleet node that runs `homefleet upgrade` downloads a tarball and runs
`npm i -g` on it. That install runs code, and the daemon it starts holds the
node's pairing identity and can run agent jobs with whatever LLM keys and
credentials the machine has. So "which bytes do we trust?" has to be
answered by something stronger than "whatever the release page or registry
serves today."

The June 2026 @mastra compromise
([StepSecurity write-up](https://www.stepsecurity.io/blog/mastra-npm-packages-compromised-using-easy-day-js))
showed exactly this failure. With the org's publish credentials, an attacker
pushed new versions of 140+ @mastra packages. The only change in each was a
dependency on a `dayjs` typosquat whose postinstall dropper fetched a second
stage aimed at environment secrets. Every one of those versions was
"official" as far as the registry could tell, because publish access was the
only trust signal. The target was also the same kind of software as ours:
AI agent tooling installed on machines full of API keys.

Signing the manifest separates "can publish a release" from "can produce a
release nodes will install":

- **The trust root is a pinned public key, not an account.** CI signs
  `homefleet-<v>.manifest.json` (version, file name, sha256, size, HFP
  version) with an Ed25519 key. The daemon trusts a tarball only if that
  signature verifies under a key compiled into the *already installed*
  daemon, and the tarball matches the manifest's hash and size. A hijacked
  GitHub or npm account can upload files, but it can't forge a signature
  without the private key, which lives only in a CI secret plus an offline
  backup.
- **The signature covers the exact received bytes, checked before parsing.**
  `serializeManifest` fixes the key order and the trailing newline, and CI
  and the daemon share that one function. `verifyRelease` checks the
  signature over the raw buffer before `JSON.parse` sees it. Even a
  whitespace-only edit is rejected (the "tampered manifest" test).
- **Same check everywhere.** Online from GitHub, offline from the cache, or
  (Phase 3) from a peer, the node runs the same `verifyRelease`. A peer
  relaying an upgrade is just a transport, so a compromised node can't push a
  bad build to the rest of the fleet.
- **Rotation without a flag day.** `RELEASE_PUBLIC_KEYS` is a list. A new key
  ships next to the old one for at least one release before anything is
  signed with it.

## Decisions

- **Ed25519 via `node:crypto`, no dependency.** Adding a signing library to
  harden the supply chain would add supply chain. Pinned keys are base64 SPKI
  DER. Following review, a pinned key that isn't Ed25519 is refused outright.
  Otherwise a mistakenly pinned RSA/EC key would make `verify(null, …)` fall
  back to that key type's default algorithm.
- **Typed failures, never throws.** `verifyRelease` returns `bad-signature`,
  `bad-manifest`, `version-mismatch`, `file-mismatch`, `size-mismatch`,
  `hash-mismatch` or `missing-tarball`, so the upgrade flow can report
  exactly why a release was refused.
- **The manifest names its file and version, and both are checked.** A
  correctly signed 0.5.1 manifest can't vouch for a tarball named
  `homefleet-0.5.2.tgz`, or be replayed when 0.5.2 was requested.

## What signing does not cover

- **A compromised CI signing step.** If the attacker controls the release
  workflow itself, they can sign whatever it builds. This defends against a
  stolen *publish* credential, not a stolen *signing* key. That's why the
  private key stays out of the repo and scoped to the release job.
- **Our own dependencies at build time.** A poisoned transitive dependency
  that lands in the lockfile gets signed along with everything else. The
  lockfile, `--frozen-lockfile` in CI, and review remain the defense there.
- **Time-of-check to time-of-use.** The installer must install the same
  local file it verified, from a directory only the daemon writes to. That
  is a constraint on the later prepare/updater tasks.

## Follow-ups

- Task 4: generate the real release key and pin it. Blocked on key custody:
  where the private key and its offline backup live.
- Task 5: sign and verify in `release.yml` before publishing, and publish
  the manifest and signature as release assets.
