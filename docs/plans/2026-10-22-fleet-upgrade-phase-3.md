# Fleet Upgrade, Phase 3 (Fleet Push over HFP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.5.2, where `homefleet fleet upgrade` upgrades every eligible paired peer over HFP (one at a time, stopping at the first failure), then upgrades the local node last.

**Architecture:** Peers gain two HFP routes: `POST /hfp/v0/upgrade` to accept a signed push, and `GET /hfp/v0/upgrade/tarball/:version` to serve a verified cached release. A pushed peer checks the manifest signature and its guards before replying `202`. It then downloads the tarball from the requester (found by device ID in its node directory), falls back to GitHub, and runs the existing Phase 2 local flow. The **requesting daemon** runs the rollout (decision B, 2026-10-22). A `FleetRollout` in the daemon prepares the release, pushes to each selected peer in turn, watches it come back through `hello`, keeps an in-memory status (`GET /control/upgrades`), and finally upgrades itself. The CLI starts a rollout and renders that status, so closing the terminal doesn't stop it, and Phase 4's dashboard reuses it unchanged.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, zod v4, vitest, the existing mTLS `HfpClient`/`NodeServer`.

**Spec:** [docs/specs/2026-09-25-fleet-upgrade-design.md](../specs/2026-09-25-fleet-upgrade-design.md), "Phase 3". Phase 1–2 plan for conventions: [2026-09-25-fleet-upgrade-phase-1-2.md](2026-09-25-fleet-upgrade-phase-1-2.md).

## Global Constraints

- HFP goes **0.3.0 → 0.4.0** (minor: new optional fields and new routes only). HomeFleet ships as **v0.5.2** (Hugo's call, 2026-10-22).
- Config: `"upgrade": { "allowRemote": false }`, `strictObject` + `.prefault({})`, **default `false`** (fail closed). `homefleet setup` prints a one-line hint; nothing enables it automatically.
- Only **signed** releases are installed, never a downgrade, and a failed new daemon is rolled back. These are the Phase 2 guarantees, unchanged.
- Rollout is **sequential, peers first, the requesting node last**, and **stops at the first** rollback, failure or timeout. A refusal (`UPGRADE_*`) or a too-old peer (404) is reported and the rollout **continues**.
- Peer wait: **3 minutes** (`UPGRADE_WAIT_MS = 180_000`, already exported from `cli.ts`; move it to `upgrade/rollout.ts` and re-export).
- The tarball route serves only a version that is **cached and verified**; `version` must be strict `X.Y.Z`. It never derives a path from anything else.
- Timestamps on the wire (`NodeInfo.lastUpgrade.at`) are **ISO 8601 UTC strings** (RFC convention). The on-disk `upgrade-result.json` keeps epoch ms.
- Ground rules from the Phase 1–2 plan still hold:
  - stage only listed files, never `git add -A`;
  - run `pnpm test <file>`, without `--`;
  - run `pnpm typecheck` and `pnpm lint` before each commit;
  - commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - test keys and fakes only, never the real release key.

## Decisions taken at plan time (record in the spec, Task 12)

- **Rollout runs in the requesting daemon**, not the CLI (2026-10-22): it survives the terminal closing and is what Phase 4's dashboard triggers.
- **Requester lookup:** the peer resolves the requester's HFP host/port with `NodeDirectory.resolve(deviceId)` (live discovery, then known-nodes) and falls back to GitHub. No extra protocol field.
- **Control API:** `POST /control/upgrade` gains `targets: "self" | "fleet" | deviceId[]` plus `forceLocal`, and there's a new `GET /control/upgrades`. These are the routes the spec lists for Phase 4, landed early because the CLI needs them. The per-boot token stays in Phase 4.
- **`--nodes`** accepts names, full IDs or unique 8+ hex prefixes, resolved in the CLI with the existing `resolveUnpairTarget`.
- **Remote pushes never force:** a busy peer replies `UPGRADE_BUSY`. `--force-local` applies only to the requester's own final step.
- `NodeInfo.lastUpgrade` = `{ version, outcome, reason?, at }`, where `version` is the result's `to`.

## Review Focus

1. **The requesting daemon restarts mid-rollout** (its own final step, or a crash). The CLI loses `/control/upgrades` while it restarts and must fall back to the local `lastUpgrade`, as `waitForUpgrade` does today. Owned by Task 10 (`rollout survives the local restart`).
2. **A peer that was never discovered by the requester** (no host/port in its directory) shows up in `--nodes` or as a paired peer. It must be reported as `unreachable` and skipped, not crash the rollout. Owned by Task 8 (`unreachable selected peer is skipped`).
3. **A stale `lastUpgrade` on a peer** from an earlier attempt at the same target must not be read as this rollout's failure. Only results with `at ≥` push time count. Owned by Task 8 (`ignores a lastUpgrade older than the push`).
4. **Two rollouts at once** (a second `fleet upgrade` while one runs) must get `409` with code `locked`, and leave the first untouched. Owned by Task 9.
5. **The tarball route asked for `../x`, `latest`, or a cached but corrupted version** must return 404 without reading outside `upgrades/<v>/`. Owned by Task 7 (`tarball route refuses unverified or non-semver versions`).

---

### Task 1: Protocol 0.4.0 — upgrade schemas, error codes, NodeInfo fields

**Files:**
- Create: `packages/protocol/src/upgrade.ts`, `packages/protocol/src/upgrade.test.ts`
- Modify: `packages/protocol/src/version.ts` (`HFP_PROTOCOL_VERSION = "0.4.0"`), `errors.ts` (+3 codes), `errors.test.ts` (`ALL_CODES`), `node.ts` (+2 optional fields), `index.ts` (`export * from "./upgrade.js"`), `test-fixtures.ts:25` (protocolVersion), `docs/rfc/hfp-v0.md`

**Interfaces — Produces:**
```ts
UpgradeRequestSchema   // z.object({ version: SemverSchema, manifest: z.base64(), signature: z.base64() }) — `POST /hfp/v0/upgrade`
UpgradeAcceptedSchema  // z.object({ accepted: z.literal(true), version: SemverSchema })
UpgradeInfoSchema      // z.object({ allowRemote: z.boolean() })
LastUpgradeSchema      // z.object({ version: SemverSchema, outcome: z.enum(["succeeded","rolled-back","failed"]), reason: z.string().optional(), at: z.iso.datetime() })
// + types UpgradeRequest, UpgradeAccepted, UpgradeInfo, LastUpgrade
// HfpErrorCodeSchema += "UPGRADE_DISABLED" | "UPGRADE_REJECTED" | "UPGRADE_BUSY"
// NodeInfoSchema += upgrade: UpgradeInfoSchema.optional(), lastUpgrade: LastUpgradeSchema.optional()
```
`manifest` is the base64 of the exact signed manifest bytes, and `signature` is the base64 detached signature (the `.sig` file's content). `UPGRADE_REJECTED` carries `details: { reason: UpgradeErrorCode }`.

- [ ] **Step 1: Write failing tests** in `upgrade.test.ts`:
  - `UpgradeRequestSchema` accepts `{version:"0.5.2", manifest:"eyJ9", signature:"c2ln"}`, and rejects `version:"latest"` and non-base64 `manifest`.
  - `LastUpgradeSchema` accepts `at:"2026-10-22T18:09:49.982Z"` and rejects `at: 1761156589982`.
  - `NodeInfoSchema.parse(fixtureNodeInfo)` still passes with neither new field (a 0.3 peer). Use the fixture from `test-fixtures.ts`.
  - `NodeInfoSchema.parse({...fixture, upgrade:{allowRemote:true}, lastUpgrade:{version:"0.5.2", outcome:"rolled-back", reason:"x", at:"2026-10-22T18:00:00.000Z"}})` keeps both fields.
  - Extend `ALL_CODES` in `errors.test.ts` with the three codes.
- [ ] **Step 2:** `pnpm test packages/protocol/src/upgrade.test.ts packages/protocol/src/errors.test.ts`. Expected: FAIL, because `./upgrade.js` can't be resolved and the codes are rejected.
- [ ] **Step 3: Implement.** Follow `rpc.ts` style: a doc comment per schema naming its route, then `export type X = z.infer<…>`. Bump the version.
- [ ] **Step 4: RFC.** In `docs/rfc/hfp-v0.md`:
  - Status/Versioning say **0.4.0**, with a changelog bullet "0.4.0: fleet upgrade — `POST /upgrade`, `GET /upgrade/tarball/{version}`, `NodeInfo.upgrade`/`lastUpgrade`, three `UPGRADE_*` error codes — additive".
  - Add both route rows to the Endpoints table, and the two NodeInfo fields to its table.
  - Add the three codes to the Errors table, along with the already-missing `MODEL_NOT_OFFERED` and `NO_MODEL_SPECIFIED`.
  - Add a new `## Upgrade` section between Workspace Sync and Discovery. It covers the request and accepted bodies, "verify the signature and guards before replying; 202 then asynchronous", the tarball rule (cached + verified + strict semver, else 404), and "a 0.3.x peer answers 404 `INVALID_REQUEST` 'unknown endpoint' to `POST /upgrade`".
- [ ] **Step 5:** `pnpm test packages/protocol` and `pnpm typecheck` pass. Fix any test that pinned `protocolVersion` to the constant's old value (the agent's survey: fixtures only).
- [ ] **Step 6: Commit** `Protocol 0.4.0: upgrade push schemas, UPGRADE_* codes, NodeInfo upgrade fields`.

### Task 2: Config `upgrade.allowRemote` + setup hint

**Files:** Modify `packages/daemon/src/config/config.ts` (schema + header comment), `config/config.test.ts`, `cli/cli.ts` (`runSetup`), `cli/cli.test.ts`, `docs/reference/configuration.md` (new `## upgrade` section after `## control`).

**Interfaces — Produces:** `UpgradeConfigSchema = z.strictObject({ allowRemote: z.boolean().default(false) })`, type `UpgradeConfig`, `DaemonConfig.upgrade` (via `upgrade: UpgradeConfigSchema.prefault({})` after `jobs`).

- [ ] **Step 1: Failing tests:**
  - `config.test.ts`: `DaemonConfigSchema.parse({}).upgrade` equals `{ allowRemote: false }`; `{upgrade:{allowRemote:true}}` parses to true; `{upgrade:{allowRemote:true, extra:1}}` throws.
  - `cli.test.ts` "setup": stdout contains the line `Remote upgrades are off. To let a paired node upgrade this one, add "upgrade": { "allowRemote": true } to config.json.` when `config.upgrade.allowRemote` is false, and does not contain it when true. `fakeConfig` gains `upgrade: { allowRemote: false }`.
- [ ] **Step 2:** Run both files; they FAIL.
- [ ] **Step 3: Implement.** Print the hint just before `runSetup`'s `return 0`.
- [ ] **Step 4:** The tests pass. Run `pnpm typecheck`, which surfaces every hand-built `DaemonConfig` that now needs `upgrade`, and fix those fixtures.
- [ ] **Step 5: Commit** `Config: upgrade.allowRemote (default false) + setup hint`.

### Task 3: NodeInfo advertises `upgrade` and `lastUpgrade`

**Files:** Modify `packages/daemon/src/node/node-info.ts`, `node/node-info.test.ts`, `upgrade/files.ts` (+ mapper), `upgrade/files.test.ts`, `daemon.ts` (pass the options).

**Interfaces:**
- Consumes: `UpgradeResult`/`readUpgradeResultSync` (files.ts), `LastUpgrade` (Task 1), `DaemonConfig.upgrade` (Task 2).
- Produces:
  - `toLastUpgrade(result: UpgradeResult): LastUpgrade` in `files.ts`, mapping `to → version` and `at → new Date(at).toISOString()`.
  - `NodeInfoConfig = Pick<DaemonConfig, "node" | "executors" | "upgrade">`.
  - `NodeInfoProviderOptions.lastUpgrade?: () => LastUpgrade | undefined`, re-read on every `build()`.

- [ ] **Step 1: Failing tests:**
  - `toLastUpgrade({from:"0.5.1", to:"0.5.2", outcome:"rolled-back", reason:"r", at: Date.UTC(2026,9,22,18)})` returns `{version:"0.5.2", outcome:"rolled-back", reason:"r", at:"2026-10-22T18:00:00.000Z"}`, and without `reason` the key is absent.
  - The provider emits `upgrade: {allowRemote: false}`.
  - With a `lastUpgrade` option returning a value, the provider includes it. A second call sees an updated value, which proves it's re-read.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** In `daemon.ts`, pass `lastUpgrade: () => { const r = readUpgradeResultSync(dataDir); return r && toLastUpgrade(r); }`.
- [ ] **Step 4:** PASS, then `pnpm typecheck`.
- [ ] **Step 5: Commit** `NodeInfo: advertise upgrade.allowRemote and lastUpgrade`.

### Task 4: Upgrade building blocks — signature-only check, verified-cache read, result writer, fallback source

**Files:** Modify `upgrade/manifest.ts` + test, `upgrade/prepare.ts` + test, `upgrade/files.ts` + test, `upgrade/release-source.ts` + test.

**Interfaces — Produces:**
```ts
// manifest.ts — checks signature + schema + version WITHOUT a tarball (the push is verified before the tarball exists)
verifyManifestSignature(input: { manifestBytes: Buffer; signature: string; expectedVersion: string; publicKeys?: readonly string[] }): VerifyResult
// prepare.ts — the old private verifyCached, exported under a clear name
readVerifiedCache(upgradesDir: string, version: string, publicKeys?: readonly string[]): Promise<PreparedRelease | undefined>
// files.ts — the daemon now records failures that happen before the updater runs
writeUpgradeResult(dataDir: string, result: UpgradeResult): Promise<void>
// release-source.ts — tries each source in order; empties destDir between attempts
class FallbackReleaseSource implements ReleaseSource { constructor(sources: readonly ReleaseSource[]) }
```
`verifyManifestSignature` reuses the private signature check. Its failure reasons are the `VerifyFailure` values `bad-signature`, `bad-manifest` and `version-mismatch`. `FallbackReleaseSource.latestVersion()` delegates to the **last** source (GitHub), and `fetchRelease` throws the last error if every source fails.

- [ ] **Step 1: Failing tests:**
  - **Signature-only check:** for a `writeSignedRelease` output, `verifyManifestSignature` is ok with the test key; a flipped manifest byte gives `bad-signature`; `expectedVersion:"9.9.9"` gives `version-mismatch`; and the call never touches the tarball (delete it first, still ok).
  - **Cache read:** `readVerifiedCache` returns the release after `prepareRelease` and `undefined` after truncating the cached tgz.
  - **Result writer:** a `writeUpgradeResult` round-trip through `readUpgradeResultSync`.
  - **Fallback source:** a first source whose `fetchRelease` throws, then a `FakeReleaseSource`. It resolves, and `destDir` holds only the second source's three files. When both throw, it rejects with the second error's message.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS, then lint and typecheck.
- [ ] **Step 5: Commit** `Upgrade: signature-only manifest check, verified-cache read, result writer, fallback source`.

### Task 5: Download a tarball from a peer — `HfpClient.fetchUpgradeTarball` + `PeerReleaseSource`

**Files:** Modify `transport/client.ts` + `transport/client.test.ts`. Create `upgrade/peer-release-source.ts` + `.test.ts`.

**Interfaces:**
- Produces:
  - `HfpClient.fetchUpgradeTarball(target: HfpTarget, version: string, destPath: string, options: { maxBytes: number; idleTimeoutMs?: number }): Promise<void>`. It sends `GET ${HFP_PATH_PREFIX}/upgrade/tarball/${version}`. A non-2xx response throws `HfpRequestError` (404 → `.status === 404`), an oversize body throws `HfpResponseTooLargeError`, and the partial file is removed on failure.
  - `class PeerReleaseSource implements ReleaseSource`, with `constructor(options: { client: Pick<HfpClient, "fetchUpgradeTarball">; target: HfpTarget; manifestBytes: Buffer; signature: string })`. `fetchRelease(version, destDir)` writes the manifest and signature it was given (the push's bytes) under the standard names, then downloads the tarball with `maxBytes: MAX_RELEASE_ASSET_BYTES`. `latestVersion()` throws `ReleaseFetchError("a peer source has no latest version")`.
- Consumes: the `manifestFileName`, `signatureFileName` and `releaseFileName` helpers.

- [ ] **Step 1: Failing tests:**
  - `client.test.ts`: use the file's existing in-process pinned server helpers to register a `routeStream("GET", "/upgrade/tarball/:version", …)`. The client writes the served bytes to `destPath`. A 404 route makes it throw `HfpRequestError` with status 404 and leaves no file. A body over `maxBytes` throws `HfpResponseTooLargeError` and leaves no file.
  - `peer-release-source.test.ts`, with a fake client that writes `writeSignedRelease`'s tarball bytes: after `fetchRelease`, `verifyRelease` on `destDir` is ok with the test key.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Model it on `fetchJobArtifact` minus the head-commit header, reusing `connectPinned`, `streamResponseToFileCapped`, `readCappedBody` and `buildRequestError`.
- [ ] **Step 4:** PASS, then lint and typecheck.
- [ ] **Step 5: Commit** `HFP client + PeerReleaseSource: download a release tarball from a peer`.

### Task 6: Coordinator accepts a remote push

**Files:** Modify `upgrade/coordinator.ts` + `coordinator.test.ts`, `upgrade/errors.ts` (+ `"disabled"`).

**Name clash:** `UpgradeRequest` exists in BOTH `@homefleet/protocol` (the HFP push body) and `control/messages.ts` (the control API body). In daemon code import the protocol one as `type UpgradeRequest as HfpUpgradeRequest`. Every `UpgradeRequest` in Tasks 6–8 means the HFP one; Tasks 9–10 mean the control one.

**Interfaces:**
- Consumes: Task 4 `verifyManifestSignature`, `FallbackReleaseSource`, `writeUpgradeResult`; Task 5 `PeerReleaseSource`.
- Produces:
  - `UpgradeSelfInput` gains `source?: ReleaseSource`, which overrides the coordinator's source for this call (target and rollback).
  - `UpgradeErrorCode` gains `"disabled"`.
  - New options: `allowRemote: boolean`, and `resolvePeer: (deviceId: string) => HfpTarget | undefined`.
  - `acceptRemote(input: { request: UpgradeRequest; requesterDeviceId: string; client: Pick<HfpClient, "fetchUpgradeTarball"> }): Promise<{ version: string }>`. It runs these checks **synchronously before resolving**, throwing `UpgradeError` in this order:
    1. `disabled` (`!allowRemote`);
    2. `locked` (in progress or lock held);
    3. `verify-failed` (`verifyManifestSignature`);
    4. the `checkUpgradeGuards` result, with `targetHfpVersion` from the verified manifest and `force: false`.

    It then starts, without awaiting:

    `upgradeSelf({ version, source: new FallbackReleaseSource([peer?, this.options.source]) })`

    where `peer` is a `PeerReleaseSource` built only when `resolvePeer(requesterDeviceId)` returns a target. If the background run throws, it calls `writeUpgradeResult(dataDir, { from, to: version, outcome: "failed", reason: error.message, at: Date.now() })`, so the requester sees `lastUpgrade` `failed` (spec: "records failed with the reason").

- [ ] **Step 1: Failing tests** in `coordinator.test.ts`, reusing `setup()`; extend it with `allowRemote: true`, `resolvePeer`:
  - `acceptRemote refuses when allowRemote is false` gives code `disabled`, and `spawned` stays empty.
  - `acceptRemote rejects a manifest signed by an unknown key` gives `verify-failed`, before any fetch (`source.fetchCount === 0`).
  - `acceptRemote rejects a not-newer push` gives `not-newer`.
  - `acceptRemote downloads from the requester first`: `resolvePeer` returns a target and the fake client serves the tarball. Resolves `{version:"0.5.1"}`. Then `vi.waitFor` sees `spawned.length === 1`, and the fake GitHub `source.fetchCount` for `0.5.1` is 0. The rollback copy `0.5.0` may still come from `source`.
  - `acceptRemote falls back to GitHub when the requester is unknown`: `resolvePeer` returns `undefined`, and the updater still spawns.
  - `a background failure is recorded as a failed lastUpgrade`: both sources fail, `vi.waitFor` sees `readUpgradeResultSync(root)` with `outcome:"failed"`, `to:"0.5.1"`, and nothing spawned.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS, then lint and typecheck.
- [ ] **Step 5: Commit** `Upgrade coordinator: accept a signed remote push (peer first, GitHub fallback)`.

### Task 7: HFP routes + daemon wiring + two-node integration

**Files:** Create `upgrade/routes.ts` + `upgrade/routes.integration.test.ts`. Modify `jobs/routes.ts` (`statusForCode`), `daemon.ts` (register routes, coordinator options, test seams, `knownNodes` getter).

**Interfaces:**
- Produces:
  - `registerUpgradeRoutes(server: NodeServer, deps: { coordinator: UpgradeCoordinator; client: HfpClient; upgradesDir: string; publicKeys?: readonly string[] }): void`.
  - `statusForCode` gains `UPGRADE_DISABLED → 403`, `UPGRADE_REJECTED → 422`, `UPGRADE_BUSY → 409`.
  - `DaemonOptions.upgradeSeams?: Pick<UpgradeCoordinatorOptions, "runtime" | "spawnUpdater" | "publicKeys" | "shutdownDelayMs">`. These are test-only, documented as such, and passed straight to the coordinator.
  - `DaemonOptions.daemonVersion?: string`, a test-only override of `DAEMON_VERSION` for BOTH `createNodeInfoProvider` and the coordinator's `currentVersion`. Without it a test daemon runs the real version, and a push of a fixture release is `not-newer`. Tests run daemons at `"0.5.0"` and push `"0.5.1"`.
  - `Daemon.knownNodes` getter, for tests to seed endpoints, next to the existing `trustStore` getter.
- Route behavior:
  - **`POST /upgrade`** (`{schema: UpgradeRequestSchema}`, auth paired) calls `coordinator.acceptRemote({request: body, requesterDeviceId: peer.deviceId, client})`, which returns `202 {accepted:true, version}`. Each `UpgradeError` is mapped:
    - `disabled` → `UPGRADE_DISABLED`;
    - `locked` and `busy` → `UPGRADE_BUSY`;
    - every other code → `UPGRADE_REJECTED` with `details: {reason: code}` and the error's message.
  - **`GET /upgrade/tarball/:version`** (`routeStream`): if `!isSemver(version)` or `await readVerifiedCache(upgradesDir, version, publicKeys)` is undefined, it answers JSON 404 `INVALID_REQUEST` "release not cached". Otherwise it streams `prepared.tarballPath` with `content-type: application/octet-stream` and `content-length: prepared.manifest.size`, copying `handleArtifactDownload`'s open/error/close handling.
  - **Daemon wiring:** register the routes right after the coordinator is constructed (routes are live-registered). Construct the coordinator with `allowRemote: config.upgrade.allowRemote` and `resolvePeer: (id) => { const n = nodeDirectory.resolve(id); return n?.host !== undefined && n.port !== undefined ? { host: n.host, port: n.port, expectedDeviceId: id } : undefined; }`.
- Integration test setup:
  - Use `createDaemonHarness`, two `new Daemon({…})`: A is the requester and B the peer with `upgrade:{allowRemote:true}`, both with `releaseSource: FakeReleaseSource` and `upgradeSeams: {publicKeys:[testKey], runtime:{…installed argv…}, spawnUpdater: record, shutdownDelayMs: 0}`.
  - B gets `requestShutdown: record`.
  - Pair them with `harness.pair(a, b)`.
  - Seed B's `knownNodes.record({deviceId: a.deviceId, host: HOST, port: a.hfpPort, lastSeenAt: new Date().toISOString(), source: "static"})`.
  - Prepare `0.5.1` into A's `upgrades/`, then push with `a.hfpClient.request({…, method:"POST", path:"/upgrade", body, responseSchema: UpgradeAcceptedSchema})`.

- [ ] **Step 1: Failing integration tests:**
  - `push to a peer with allowRemote false → 403 UPGRADE_DISABLED`.
  - `push with a tampered manifest → 422 UPGRADE_REJECTED reason verify-failed`.
  - `push → 202, peer downloads the tarball from the requester, writes its upgrade state and spawns the updater`. Assert that B's `upgrade-state.json` has `to:"0.5.1"` and B's fake GitHub source `fetchCount` for 0.5.1 is 0.
  - `peer with no endpoint for the requester falls back to GitHub` (no `knownNodes` seed; B's fake source `fetchCount ≥ 1`, updater spawned).
  - `tarball route refuses unverified or non-semver versions`: `GET /upgrade/tarball/latest`, `/upgrade/tarball/0.9.9` (not cached) and `/upgrade/tarball/0.5.1` after corrupting A's cached tgz all give 404. `/upgrade/tarball/0.5.1` intact gives 200 with the exact bytes. Use `a`'s cache, fetched by `b.hfpClient.fetchUpgradeTarball`.
  - `B advertises upgrade.allowRemote in hello`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS, then the full `pnpm test`, lint and typecheck.
- [ ] **Step 5: Commit** `Daemon: HFP upgrade routes (accept push, serve verified tarball)`.

### Task 8: `FleetRollout` — sequential push, watch, stop on failure, self last

**Files:** Create `upgrade/rollout.ts` + `upgrade/rollout.test.ts`. Move `UPGRADE_WAIT_MS` here and re-export it from `cli.ts`.

**Interfaces — Produces:**
```ts
export type PeerRolloutState = "pending" | "pushing" | "restarting" | "succeeded" | "refused" | "too-old" | "unreachable" | "rolled-back" | "failed" | "timeout";
export interface PeerRolloutStatus { deviceId: string; name: string; from?: string; state: PeerRolloutState; reason?: string }
export interface RolloutStatus {
  id: string; target: string; startedAt: string /* ISO */; state: "running" | "stopped" | "done";
  peers: PeerRolloutStatus[];
  self: { state: "pending" | "skipped" | "restarting" | "refused"; reason?: string };
}
export interface RolloutPeers {          // narrow seam over NodeDirectory + HfpClient, faked in tests
  list(): Promise<NodeDirectoryEntry[]>;
  push(entry: NodeDirectoryEntry, request: UpgradeRequest): Promise<void>; // throws HfpRequestError
  hello(entry: NodeDirectoryEntry): Promise<NodeInfo | undefined>;          // undefined while unreachable
}
export class FleetRollout {
  constructor(options: { peers: RolloutPeers; currentVersion: string; upgradeSelf: (input: UpgradeSelfInput) => Promise<UpgradeStarted>; now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number /* 2000 */; waitMs?: number /* UPGRADE_WAIT_MS */ });
  /** Selects peers synchronously-ish and returns the initial status; the loop continues in the background. */
  start(input: { prepared: PreparedRelease; manifestBytes: Buffer; signature: string; nodes?: string[]; forceLocal?: boolean }): Promise<RolloutStatus>;
  status(): RolloutStatus | undefined;
}
```
Selection:
- With `nodes`, use exactly those paired entries; one without a host is marked `unreachable` immediately.
- Otherwise use every `reachable` entry whose `nodeInfo.daemonVersion` is older than the target (`compareSemver < 0`).
- If `currentVersion` is older than the target, `self` is `pending`; otherwise `skipped`.

Per peer:
1. Set `pushing` and call `push`.
2. A 404 `HfpRequestError` gives `too-old` with reason `too old for remote upgrade; run npm i -g there`. Another `HfpRequestError` gives `refused` with reason `hfpError.message`. A network error gives `unreachable`. All three **continue**.
3. On success, set `restarting` and poll `hello` every `pollMs`:
   - `daemonVersion === target` gives `succeeded`.
   - A `lastUpgrade` with `version === target`, `Date.parse(at) >= pushedAt` and outcome `rolled-back` or `failed` gives that state with its reason, and **stops**.
   - Passing `waitMs` gives `timeout` with reason `unknown — check the node` and **stops**.

On stop, `state = "stopped"`, and later peers stay `pending` and self stays `pending`. After all peers, if self is `pending`, call `upgradeSelf({version: target, force: forceLocal})` and set `self = restarting`, with `state` staying `running` because the daemon is about to exit. If that throws an `UpgradeError`, set `self = refused` with the message and `state = "done"`. If there's no self step, `state = "done"`.

- [ ] **Step 1: Failing tests**, all with fake `peers`, a fake clock and `sleep` that advances it, using the names below:
  - `selects reachable older peers only` (a peer on the target and an unreachable one are excluded).
  - `pushes peers one at a time, then upgrades self last` (record call order: `push(p1)`, `p1 succeeded`, `push(p2)`, …, `upgradeSelf`).
  - `continues past a refused and a too-old peer`.
  - `stops the rollout when a peer rolls back`: `p2` is never pushed, `self.state === "pending"`, and the rollout's `state === "stopped"`.
  - `times out after waitMs and stops`.
  - `ignores a lastUpgrade older than the push` (a stale `failed` for the target, then the version flips: `succeeded`).
  - `unreachable selected peer is skipped` (`--nodes` names a paired peer with no host).
  - `self already current → skipped, state done`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS, then lint and typecheck.
- [ ] **Step 5: Commit** `Upgrade: FleetRollout (sequential, stops at first failure, self last)`.

### Task 9: Control API — start a fleet rollout, read its status

**Files:** Modify `control/messages.ts`, `control/control-server.ts` + test, `cli/control-client.ts` + test, `daemon.ts` (surface wiring: build a `FleetRollout` with a `RolloutPeers` over `nodeDirectory` + `hfpClient`).

**Interfaces — Produces:**
- `UpgradeRequestSchema` becomes `targets: z.union([z.literal("self"), z.literal("fleet"), z.array(z.string().min(1)).min(1)]).default("self")`, plus `forceLocal: z.boolean().optional()`. `targets` arrays are full device IDs; the CLI resolves names.
- `ControlSurface.upgrade(input)` returns `UpgradeStarted | RolloutStatus`: self keeps today's `{from,to}`, while `fleet` or an array returns the initial `RolloutStatus`.
- `ControlSurface.upgrades(): RolloutStatus | undefined`, backing `GET /control/upgrades` (`200 {rollout: RolloutStatus | null}`).
- The client gains `ControlClient.upgrades(): Promise<RolloutStatus | null>`, and `upgrade()` returns the union. The validator distinguishes them by the presence of `peers`.
- The daemon surface handles a fleet request in this order:
  1. resolve the target (`input.version` or the coordinator's `check().latest`);
  2. `prepareRelease` locally;
  3. read the manifest and sig bytes from the cache;
  4. call `rollout.start(…)`.

  A second start while `status()?.state === "running"` throws `UpgradeError("locked")`, which maps to 409.

- [ ] **Step 1: Failing tests:**
  - `control-server.test.ts`:
    - `POST /control/upgrade {targets:"fleet"}` gives 202 with a body that has `peers`;
    - `GET /control/upgrades` gives `{rollout: …}`, and `{rollout: null}` when the surface returns undefined;
    - `targets: []` gives 400;
    - a `locked` UpgradeError gives `409 {code:"locked"}`.
  - `control-client.test.ts`: round-trips for `upgrades()` and the fleet `upgrade()`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** The `daemon.ts` wiring is covered by Task 10's tests.
- [ ] **Step 4:** PASS, then lint and typecheck.
- [ ] **Step 5: Commit** `Control API: start a fleet rollout, GET /control/upgrades`.

### Task 10: CLI `homefleet fleet upgrade`

**Files:** Modify `cli/cli.ts` + `cli/cli.test.ts`.

**Interfaces:**
- Consumes: the Task 9 client methods, `resolveUnpairTarget`, and the existing `waitForUpgrade`/`reportUpgradeFailure`.
- Produces: `homefleet fleet upgrade [--to <version>] [--nodes <name|id>…] [--force-local]`. `--nodes` takes the following non-flag arguments, and each must resolve to exactly one paired node, otherwise exit 2 with the resolver's message.

Output contract:
- On start: `Rolling out <target> to: <name> (<from>), …; this node last.`, or `…; this node is already on <target>.`
- Once per state change, one line per peer: `  <name>: <state>[ (<reason>)]`.
- When self becomes `restarting`, switch to `waitForUpgrade` with `{from: current, to: target}`.
- Final summary: `Rollout complete: <n> upgraded.`, or `Rollout stopped at <name>: <state>.`, plus refusals.

Exit codes: 0 only if every selected peer `succeeded` and self succeeded or was skipped; otherwise 1. Bad arguments exit 2.

**If `/control/upgrades` becomes unreachable** (`DaemonUnreachableError`) while self is `restarting`, that's expected. Defer to `waitForUpgrade`, which already handles the restart.

- [ ] **Step 1: Failing tests**, using `upgradeHarness` from the existing upgrade tests:
  - `fleet upgrade prints the plan and per-peer progress, then waits for self`: the fake `upgrades()` returns pending, then restarting, then succeeded, then self restarting; then `status()` reports the target; exit 0.
  - `fleet upgrade stops and exits 1 when a peer rolls back`.
  - `--nodes resolves names and prefixes to full ids` (assert the `targets` array sent).
  - `--nodes with an ambiguous prefix exits 2`.
  - `rollout survives the local restart`: `upgrades()` throws `DaemonUnreachableError` once self is restarting, and `status()` then returns the target; exit 0.
  - `nothing to do`: no eligible peers and self current prints `Everything is already on <target>.` and exits 0.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Add `case "fleet"` in `dispatch` with a `runFleet` sub-dispatcher (`pair`-style) and a USAGE entry.
- [ ] **Step 4:** PASS, then lint and typecheck.
- [ ] **Step 5: Commit** `CLI: homefleet fleet upgrade [--to] [--nodes] [--force-local]`.

### Task 11: End-to-end rollout integration (two daemons)

**Files:** Extend `upgrade/routes.integration.test.ts`.

- [ ] **Step 1: Failing test** `fleet rollout through the control API pushes the peer, then hands off self`:
  - A and B as in Task 7, both with `allowRemote` and `requestShutdown: record`.
  - Seed both directions with `knownNodes`.
  - Call `controlClientFor(a).upgrade({targets:"fleet", version:"0.5.1"})`.
  - Both daemons run with `daemonVersion: "0.5.0"` (Task 7 seam). B's HFP port is fixed after its first start: read `b.hfpPort`, then restart with `hfp: { port }`.
  - Assert that B spawns its updater with `to:"0.5.1"`, and that A's `upgrades()` shows B `restarting`.
  - Simulate B coming back, since its updater is fake: `stop()` B, and start a new `Daemon` on B's data dir with the same `hfp.port` and `daemonVersion: "0.5.1"`. A's directory reaches it through the seeded known-nodes entry.
  - Assert that A's `upgrades()` eventually shows B `succeeded` and self `restarting`, and that A's recorded `spawnUpdater` was called with `to:"0.5.1"` (A upgraded itself last).
- [ ] **Step 2–4:** FAIL, then implement, then PASS. No new seams beyond Task 7's. Run the full `pnpm test`.
- [ ] **Step 5: Commit** `Integration: fleet rollout across two assembled daemons`.

### Task 12: Docs + release prep v0.5.2

**Files:**
- `README.md`: Install section, `homefleet fleet upgrade` paragraph, status banner, and the "currently v0.5.2" note.
- `docs/reference/configuration.md` (Task 2 done) and `docs/reference/releasing.md` (no change unless needed).
- The spec's Decisions table: add a "Plan-time adjustments (Phase 3 plan)" row with the decisions above.
- Version bump in the four places plus the RFC example `daemonVersion`, and `docs/releases/v0.5.2.md`.

- [ ] **Step 1:** Write the docs. The release notes say peers need `"upgrade": { "allowRemote": true }`, that nodes on ≤ 0.5.1 must reach 0.5.2 with local `homefleet upgrade` first, and that the real-hardware proof (0.5.2 → 0.5.3 pushed laptop → tower) follows publishing.
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test`, and `pnpm pack:release --tag v0.5.2 --out release-check` succeeds (then delete `release-check/`).
- [ ] **Step 3: Commit** `Release prep: v0.5.2 (fleet upgrade over HFP)`, push, open the PR, and wait for green CI on both OSes. Merging and tagging need Hugo's go-ahead.

### Task 13: Rig proof (after v0.5.2 is published)

- [ ] Both nodes go 0.5.1 → 0.5.2 with local `homefleet upgrade`.
- [ ] Enable `"upgrade": { "allowRemote": true }` on the tower and restart its daemon.
- [ ] Ship a small v0.5.3, then run `homefleet fleet upgrade` on the laptop. Expect the tower `succeeded`, then the laptop self-upgraded, with both on 0.5.3 per `homefleet nodes`.
- [ ] Negative check: with `allowRemote` false on a node, the rollout reports `refused (UPGRADE_DISABLED …)` and continues.
- [ ] Devlog 023 and rig notes. Rollback under a push is covered by Task 8's unit tests plus the Phase 2 drill. No broken build gets a real-key signature.
