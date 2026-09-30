# Fleet Upgrade — Design

## Goal

Upgrading HomeFleet today means visiting every machine (or briefing its Claude
session through the rig mailbox) and running `npm i -g <tarball URL>` plus a
manual daemon restart. This design replaces that with:

- a verified, self-restarting **local upgrade** (`homefleet upgrade`);
- an opt-in **fleet push** over HFP (`homefleet fleet upgrade`), so one node
  upgrades its paired peers;
- a **dashboard trigger** for the same push.

Every path installs only a **signed** release, never downgrades, and rolls
back automatically if the new daemon fails to come up.

## Decisions

| Question | Decision |
| --- | --- |
| Where does a node get the new version? | From **GitHub or the requesting peer**. A remote upgrade pulls the tarball from the requesting peer first (LAN) and falls back to GitHub. |
| How is a tarball trusted? | **Release signing key.** CI signs a manifest (version, sha256, size) with an Ed25519 key. Installed packages pin the public key(s). One check covers both sources and works offline. |
| Is remote upgrade on by default? | **No.** `upgrade.allowRemote` defaults to `false` (fail closed, like `executors.*`). |
| How does a node replace and restart itself? | A **detached updater** script, copied out of the install dir, does install → restart → health check → rollback. It works however the daemon was started. |
| Rollout order | **Sequential**, peers first, the node that started it last. The rollout stops at the first failure. |
| Delivery | Four phases, each with its own implementation plan: (1) signed releases, (2) local upgrade, (3) fleet push, (4) dashboard trigger. |

## Architecture

```
 dashboard ──POST /control/upgrade──┐
 homefleet upgrade ─────────────────┤ (loopback control API)
 homefleet fleet upgrade ───────────┘
                                     ▼
                          UpgradeCoordinator (daemon)
               ┌───────────────┼────────────────────────┐
               ▼               ▼                        ▼
      ReleaseSource      verifyRelease()        peers: POST /hfp/v0/upgrade
  (GitHub | peer HFP)   (sig + sha256 + size)   ◄── GET /hfp/v0/upgrade/tarball/:v
               └──────► <dataDir>/upgrades/<v>/ (verified cache)
                                     ▼
                     spawn detached updater.mjs → daemon.stop()
                                     ▼
          npm i -g <tgz> → relaunch → poll /control/status → rollback?
                                     ▼
                        <dataDir>/upgrade-result.json → NodeInfo.lastUpgrade
```

### Units

All new code is in `packages/daemon/src/upgrade/` unless stated otherwise.

- **`release-keys.ts`**: the pinned Ed25519 public keys (an array, so a key can
  be rotated), raw 32-byte keys encoded as base64.
- **`manifest.ts`**: `ReleaseManifestSchema`
  (`{ version, file, sha256, size }`, strict) and `verifyRelease({ manifestBytes,
  signature, tarballPath, expectedVersion })`. The function checks the
  signature against any pinned key, then that `version === expectedVersion`,
  then the tarball's size and sha256. It returns a typed result, never throws
  on bad input, and uses `node:crypto` only.
- **`release-source.ts`**: two sources behind one interface,
  `fetchRelease(version) → { manifestBytes, signature, tarballPath }`:
  - `GitHubReleaseSource` resolves `latest` via
    `https://api.github.com/repos/Hugodzl/HomeFleet/releases/latest` and
    downloads assets from `.../releases/download/v<v>/`;
  - `PeerReleaseSource` streams from a peer's
    `GET /hfp/v0/upgrade/tarball/:version` over the existing mTLS client.

  Both write into `<dataDir>/upgrades/<v>/` and delete the files if
  verification fails.
- **`guards.ts`**: pure checks that return a reason code:
  - the target is newer than `DAEMON_VERSION` (semver compare, strictly
    greater);
  - the target manifest's HFP major equals ours, which needs `hfpVersion` in
    the manifest (see Phase 1);
  - `activeJobs === 0`, unless forced;
  - no upgrade lock is held.
- **`coordinator.ts`**: `UpgradeCoordinator`, owned by the `Daemon`. It runs
  the local flow (prepare → guards → hand off to the updater) and the fleet
  flow (prepare locally → upgrade each peer in turn → self last). It keeps an
  in-memory status map for `/control/upgrades`.
- **`updater.mjs`**: a zero-dependency, standalone Node script. It is **copied**
  to `<dataDir>/upgrades/updater.mjs` before each run, so `npm i -g` never
  replaces the file that is running. Its only input is
  `<dataDir>/upgrades/upgrade-state.json`.
- **`result.ts`**: reads and writes `<dataDir>/upgrade-result.json`, and maps it
  to the optional `NodeInfo.lastUpgrade` field.

## Phase 1: Signed releases

- **One-time setup** (documented in `docs/reference/releasing.md`): generate an
  Ed25519 key pair with a small `scripts/release-keygen.mjs`. Store the private
  key (PKCS#8 PEM) as the repo secret `HOMEFLEET_RELEASE_KEY`, and add the
  public key to `release-keys.ts`.
- **`release.yml`**: a new `sign` job after `smoke` (which needs `pack`) runs
  `node scripts/sign-release.mjs release/homefleet-<v>.tgz`. It writes:
  - `homefleet-<v>.manifest.json`:
    `{ version, file, sha256, size, hfpVersion }`, with keys in a fixed order;
  - `homefleet-<v>.manifest.sig`: a base64 detached Ed25519 signature over the
    exact manifest bytes.

  The `release` job attaches all three files. The `sign` job fails the release
  if the secret is missing.
- **Smoke test addition:** verify the fresh signature with the package's own
  `verifyRelease`, so a key mismatch is caught before publishing.
- **Bootstrap:** releases ≤ v0.4.0 have no manifest, so they can never be
  targets. The first signed release is **v0.5.0**, which ships phases 1 and 2.
  Moving 0.4.0 → 0.5.0 is the last manual `npm i -g`.

## Phase 2: Local upgrade

### CLI

`homefleet upgrade [--to <version>] [--check] [--force]`

- `--check`: resolve the target and print `current → available`, or "up to
  date". Changes nothing.
- Otherwise the CLI sends `POST /control/upgrade { targets: "self", version? }`
  and streams progress by polling `GET /control/upgrades`. The CLI never
  installs anything itself; the running daemon owns the flow.
- If the daemon isn't running, the CLI says so and exits non-zero. Upgrading
  a stopped node is a plain `npm i -g`.

### Flow (daemon)

1. **Resolve the target:** `version` from the request, or the latest GitHub
   release.
2. **Prepare:** fetch and verify into `upgrades/<v>/`. If a verified copy is
   already cached, reuse it.
3. **Run the guards.** If any fails, reply with the reason. Nothing has stopped
   at this point.
4. **Cache a rollback copy:** make sure `upgrades/<current>/` holds the running
   version's tarball. Use the existing copy if there is one; otherwise fetch it
   from GitHub (best effort). If it can't be cached, record
   `rollback: "unavailable"` in the state file.
5. **Take the lock** `upgrades/upgrade.lock`, which holds the PID and a
   timestamp. A lock older than 10 minutes whose PID is dead counts as stale.
6. **Write `upgrade-state.json`:**
   `{ from, to, tgz, rollbackTgz?, nodePath: process.execPath, argv:
   process.argv.slice(1), env: { HOMEFLEET_DATA_DIR?, … }, controlPort,
   startedAt }`. Only HomeFleet-relevant env vars are recorded; everything else
   is inherited.
7. **Hand off:** spawn `node <dataDir>/upgrades/updater.mjs` detached
   (`detached: true, stdio: "ignore", windowsHide: true`, then `unref()`),
   reply `202`, and run the normal graceful `daemon.stop()`, then exit 0.

### Updater

1. Wait for the old daemon PID to exit (up to 30 s; kill it after that).
2. `npm i -g <tgz>`, with output appended to `upgrades/updater.log`. On Windows,
   run `npm.cmd` through the shell.
3. Relaunch `nodePath argv…` detached, with stderr going to
   `<dataDir>/homefleetd.err.log`.
4. **Health check:** poll `GET /control/status` (with the control header) until
   `daemonVersion === to`, for up to 60 s.
5. **If the health check fails** and there is a rollback tarball: kill the new
   PID, `npm i -g <rollbackTgz>`, relaunch, and health-check for `from`.
6. Write `upgrade-result.json`:
   `{ from, to, outcome: "succeeded" | "rolled-back" | "failed", reason?, at }`,
   then delete the lock.

A daemon that was running in a terminal comes back **detached**; the CLI
prints this before handing off. Service-manager integration is out of scope.

## Phase 3: Fleet push over HFP

The protocol goes from HFP **0.3.0 to 0.4.0**, a minor bump: new optional
fields and new routes only, per the RFC's versioning rules. The RFC gains an
"Upgrade" section.

### Config

```jsonc
"upgrade": { "allowRemote": false }   // optional block; strictObject + .prefault({})
```

`homefleet setup` prints a one-line hint for turning it on. It is not enabled
automatically.

### Protocol additions (`packages/protocol`)

- `UpgradeRequestSchema`:
  `{ version, manifest: base64, signature: base64 }`.
  `UpgradeAcceptedSchema`: `{ accepted: true, version }`.
- Error codes in `HfpErrorCodeSchema`:
  - `UPGRADE_DISABLED`: `allowRemote` is false;
  - `UPGRADE_REJECTED`: bad signature, not newer, HFP major mismatch, or
    manifest/version mismatch. Carries a `reason`;
  - `UPGRADE_BUSY`: jobs are running, or an upgrade is already in progress.
- `NodeInfo.lastUpgrade?`: `{ version, outcome, reason?, at }`, optional.
- `NodeInfo.upgrade?`: `{ allowRemote: boolean }`, so a requester can show
  which nodes are eligible before trying.

### Routes (daemon, `auth: "paired"`)

- **`POST /hfp/v0/upgrade`:**
  1. Verify the manifest signature and run the guards before replying.
  2. Reply `202` with `UpgradeAccepted`.
  3. Asynchronously:
     - fetch the tarball with `PeerReleaseSource` from the requester (its
       address is the connection's peer, and it must be a trusted node);
     - if that fails, fall back to `GitHubReleaseSource`;
     - verify, then run the Phase 2 flow from step 3 onward (guards again,
       rollback cache, lock, hand off).
- **`GET /hfp/v0/upgrade/tarball/:version`:** streams `upgrades/<v>/<file>`
  only if that version is in the local cache **and** verified. Otherwise 404.
  It never serves arbitrary paths; `version` must be valid semver.

### CLI

`homefleet fleet upgrade [--to <v>] [--nodes <deviceId…>] [--force-local]`

1. Prepare the target locally (resolve and verify).
2. Select peers: `--nodes`, or every reachable trusted peer whose
   `daemonVersion` is older than the target.
3. For each peer in turn:
   1. `POST /upgrade`; report a refusal and continue to the next peer;
   2. on `202`, wait for the peer to drop off and come back reporting
      `daemonVersion === target` (success), or a `lastUpgrade` for the target
      with `rolled-back` / `failed`, or a 3-minute timeout;
   3. **stop the rollout** on a rollback, failure or timeout.
4. Upgrade the local node last, using the Phase 2 flow, unless it's already
   current.

**Peers on HFP 0.3.x** return 404 for `/upgrade`. That is reported as "too old
for remote upgrade; run `npm i -g` there" and the rollout moves to the next
peer.

## Phase 4: Dashboard trigger

### Control API

- `POST /control/upgrade { targets: "self" | deviceId[], version? }` runs the
  fleet sequence, restricted to the targets given. Only one fleet run happens
  at a time; a second request gets `409`.
- `GET /control/upgrades` returns
  `{ target, nodes: [{ deviceId, state: "pending" | "preparing" | "requested" |
  "restarting" | "succeeded" | "rolled-back" | "failed" | "refused",
  reason? }] }`. The state is held in memory and cleared on restart. The
  node's own `lastUpgrade` covers the time after a restart.
- `GET /control/status` gains `availableUpgrade?`: the latest GitHub version,
  checked at most once every 6 hours and only while the dashboard is being
  polled (no background traffic otherwise).

### Per-boot control token

- At startup the daemon generates 32 random bytes and writes them to
  `<dataDir>/control-token`, readable by the current user only (`0600`; on
  Windows the data dir is already per-user).
- **The dashboard HTML** is served with the token embedded
  (`<meta name="homefleet-control-token">`). Other origins can't read the page:
  there are no CORS headers, and the Host allow-list blocks DNS-rebinding
  attacks.
- **`POST /control/upgrade` requires `x-homefleet-control-token`**, on top of
  the existing header and Host checks. The CLI reads the token file.
- **Existing routes are unchanged.** Requiring the token on `pair/*` is a
  possible follow-up and is out of scope here.

### UI

- The nodes table's existing version-skew badge becomes **"⬆ <v> available"**
  when the node is older than the target, and it is eligible
  (`upgrade.allowRemote`, or it is this node).
- An **Upgrade** button on each node, and **Upgrade all** in the header.
- A confirm dialog lists: the target version, "signature verified" (after
  prepare), and each node's running jobs. Busy nodes are marked and skipped
  unless you confirm.
- Progress per node, from `/control/upgrades`.
- When this node restarts, polling fails. The page shows **"Restarting…"**
  and keeps retrying, then reloads once `daemonVersion` changes. The reload
  is needed because the new daemon serves a new token and new assets.
- The dashboard design doc is updated from "read-only" to "read-only except
  upgrade."

## Error handling

| Failure | Result |
| --- | --- |
| Download, signature, hash or size mismatch | The cached files are deleted and the reason reported. Nothing stops. |
| A guard fails | `UPGRADE_REJECTED` / `UPGRADE_BUSY` (remote) or a CLI/dashboard error. Nothing stops. |
| The requester disappears mid-transfer | The peer falls back to GitHub. If that fails too, the peer stays on the current version and records `failed` with the reason. |
| `npm i -g` fails | Roll back if possible. Outcome `rolled-back` or `failed`. |
| The new daemon fails the health check | Roll back to the previous tarball. Outcome `rolled-back`. |
| No rollback tarball | The new install is left in place. Outcome `failed`, reason `rollback unavailable`. |
| A peer never returns within 3 minutes | Marked `failed` ("unknown — check the node"). The rollout stops. |
| Two upgrades at once | The lock file makes the second one `UPGRADE_BUSY` / `409`. |
| Updater crashes | A stale lock is detected on the next attempt. `homefleet status` shows the last `upgrade-result.json`. |

## Testing

- **`manifest.ts`:**
  - accepts a valid signature under a pinned key, and under a rotated
    second key;
  - rejects a tampered manifest, a tampered tarball, a wrong size, a version
    mismatch and an unknown key.
- **`guards.ts`:** newer, equal, older, pre-release ordering, HFP major
  mismatch, busy, lock held, stale lock.
- **Config:** the `upgrade` block defaults to `allowRemote: false`, and unknown
  keys are rejected.
- **Updater:** run against a fake `npm` (a script recording its arguments) and
  a fake daemon (a tiny HTTP server that reports a chosen version), covering:
  - success;
  - health-check timeout leading to rollback;
  - a failed install leading to rollback;
  - no rollback tarball leading to `failed`;
  - a stale lock.
- **HFP routes:** two in-process nodes:
  - the refusal codes;
  - the tarball route serves only verified cached versions;
  - peer download, and the GitHub fallback against a mocked fetch;
  - a 0.3.x peer (404) handled as "too old."
- **Control:** `POST /control/upgrade` is refused without the token and allowed
  with it; `GET /control/upgrades` has the expected shape; a second concurrent
  run gets `409`.
- **Dashboard view model:** the badge, button eligibility, the "Restarting…"
  state and the reload trigger.
- **CI signing:** the `sign` job's output passes `verifyRelease` in `smoke`.
- **Rig test (devlog):**
  - laptop and tower on 0.5.0 → 0.5.1 via `homefleet fleet upgrade`;
  - then 0.5.1 → 0.5.2 via the dashboard's **Upgrade all**;
  - then a deliberately broken 0.5.3-rc whose daemon exits at startup,
    proving the rollback on the tower.

## Out of scope

- Automatic background upgrades with no one triggering them.
- Release channels (beta/stable) and pinning a fleet to a version.
- Upgrading nodes in parallel.
- Native service-manager integration (Windows service, systemd, launchd); the
  updater itself is cross-platform.
- Requiring the per-boot token on the existing `pair/*` routes.
- Publishing to the npm registry.
