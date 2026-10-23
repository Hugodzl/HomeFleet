# Fleet Upgrade, Phase 4 (Dashboard Trigger + Per-Boot Control Token) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.6.0, where the dashboard can start a verified fleet upgrade (per node or "Upgrade all"), guarded by a per-boot control token, and follows the requesting node's own restart.

**Architecture:**
- **Token.** At startup the daemon writes a random per-boot token to `<dataDir>/control-token` and embeds it in the dashboard HTML at serve time (a `<meta>` tag). The upgrade POST routes require it in `x-homefleet-control-token`, and the CLI reads the file.
- **New route.** `POST /control/upgrade/prepare` downloads and verifies the target release before the user confirms, so the dialog can show "signature verified". Confirming then starts the existing daemon-side `FleetRollout` through `POST /control/upgrade`, which gains `includeSelf` so a per-node button upgrades only that node.
- **Available-upgrade check.** `GET /control/status?dashboard=1` reports `availableUpgrade` from a 6-hour cached GitHub check.
- **Page logic.** All new page logic lives in `view-model.js` as pure, unit-tested functions. `app.js` only wires the DOM, and it reloads the page once this node comes back on a new version.

**Tech Stack:** TypeScript (ESM), Node ≥ 20 (`node:crypto` `randomBytes` / `timingSafeEqual`), zod v4, vitest (node env; no DOM test env, so the dashboard is tested as pure functions plus static scans), plain browser JS for the dashboard.

**Spec:** [docs/specs/2026-09-25-fleet-upgrade-design.md](../specs/2026-09-25-fleet-upgrade-design.md), "## Phase 4". Dashboard design: [docs/specs/2026-09-24-read-only-dashboard-design.md](../specs/2026-09-24-read-only-dashboard-design.md). Phase 3 plan for conventions: [2026-10-22-fleet-upgrade-phase-3.md](2026-10-22-fleet-upgrade-phase-3.md).

## Global Constraints

- HomeFleet ships as **v0.6.0** (Hugo, 2026-10-23). **No HFP change:** everything is in the loopback control API and the dashboard.
- **Per-boot token:**
  - 32 random bytes as hex (64 chars), generated at every daemon start.
  - Written to **`<dataDir>/control-token`**: remove the file first, then create it with `mode: 0o600` (`mode` only applies on create; Windows ignores it, and the data dir is per-user there).
  - It travels in request header **`x-homefleet-control-token`** and in page meta **`<meta name="homefleet-control-token" content="…">`**.
  - Compared with `crypto.timingSafeEqual` on equal-length buffers; a length mismatch is refused without comparing.
- **The token is required ONLY on `POST /control/upgrade` and `POST /control/upgrade/prepare`.** All other routes are unchanged; requiring it on `pair/*` and `unpair` is out of scope, per the spec. The existing `x-homefleet-control: 1` and Host checks still apply first. A missing or wrong token gets **403** `{ error, code: "bad-token" }`, and **the body is never read**.
- **`availableUpgrade`:** the latest GitHub version, cached for **6 hours**. A failed lookup is cached for **15 minutes** and yields no field. It is refreshed only when **`GET /control/status?dashboard=1`** is called; a plain `GET /control/status` (CLI) never triggers network traffic. The field is present only when that version is newer than this daemon.
- **Progress shape is the shipped `RolloutStatus`** (`peers[]` + `self`, from `upgrade/rollout.ts`), not the spec's older `{target, nodes[]}` sketch. Record this deviation in Task 9.
- Remote pushes still never force (Phase 3 decision). In the dialog, a busy **peer** is listed as "will be refused while busy". Only **this node** can be forced, via an explicit checkbox that maps to `forceLocal`.
- **Dashboard rules that stay:**
  - no inline script, style or `on*=` handlers (CSP `script-src 'self'`);
  - no `innerHTML` or other sinks (the token now sits in the page);
  - every `fetch` is explicit about its method;
  - the only POSTs go to `/control/upgrade` and `/control/upgrade/prepare`, and carry the token header.
- **Ground rules as in Phase 3:**
  - stage only listed files, never `git add -A`;
  - run `pnpm test <file>`, without `--`;
  - run `pnpm typecheck` and `pnpm lint` before each commit;
  - commit trailer per the agent's own attribution reminder;
  - test keys and fakes only.

## Decisions taken at plan time (record in the spec, Task 9)

- **Verify before confirm** (Hugo, 2026-10-23): a new `POST /control/upgrade/prepare`. The confirm dialog shows a verified release.
- **`includeSelf?: boolean`** on `POST /control/upgrade` (default `true`, so the CLI's `--nodes` behavior is unchanged). The per-node button sends `targets: [id], includeSelf: false`. "Upgrade all" sends `targets: "fleet"`. This node's own button sends `targets: "self"`.
- **The `?dashboard=1` query flag** gates the GitHub check, honoring the spec's "only while the dashboard is being polled".
- **The page reloads** when `GET /control/status` reports a `daemonVersion` different from the one it loaded with: the new daemon has a new token and new assets. A 403 `bad-token` (stale page after an unseen restart) also triggers a reload.

## Review Focus

1. **A stale page after a daemon restart.** The token rotated, so the page's POSTs 403. The page must reload rather than show a dead button, never loop reloads (at most one reload per 10 s), and say why. Owned by Task 7 (`reloadDecision` tests).
2. **The token leaking.** The token must appear in the HTML response only, never in `app.js`, `/control/status` or logs. `cache-control: no-store` stays on the page. Owned by Task 1 (`token only in the page body`) and Task 8.
3. **Double-clicking Upgrade, or two tabs.** A second start gets 409 `locked`; the page shows "a rollout is already running" and switches to showing its progress, rather than an error dead end. Owned by Task 7 (`startOutcome` tests).
4. **Prepare fails** (GitHub down, verify-failed): the dialog shows the reason and no Confirm button. Nothing starts. Owned by Task 7 (`confirmSummary` with an error).
5. **This node is busy.** Without the force checkbox, self-upgrade is refused (`busy`) after the peers have already gone. The dialog must say so up front. Owned by Task 6 (`confirmSummary` busy-self line).

---

### Task 1: Per-boot control token (daemon + server)

**Files:** Create `packages/daemon/src/control/control-token.ts` + `.test.ts`. Modify `control/control-server.ts` (+ `control-server.test.ts`), `daemon.ts`, `cli/control-client.ts` (+ test). The client-side token option lands here so every existing test that POSTs `/control/upgrade` through `ControlClient` (including `upgrade/routes.integration.test.ts`) can pass the token and the suite stays green after this task.

**Interfaces — Produces:**
```ts
// control-token.ts
export const CONTROL_TOKEN_FILE = "control-token";
export const CONTROL_TOKEN_HEADER = "x-homefleet-control-token";
export function generateControlToken(): string;                       // randomBytes(32).toString("hex")
export async function writeControlToken(dataDir: string, token: string): Promise<void>; // rm then writeFile mode 0o600, mkdir -p
export function readControlTokenSync(dataDir: string): string | undefined;             // trimmed; undefined if absent/empty
export function tokensMatch(expected: string, provided: string | undefined): boolean;  // timingSafeEqual, length-checked
// control-server.ts
ControlServerOptions.token?: string   // absent => the token-protected routes answer 403 bad-token (fail closed)
// cli/control-client.ts
ControlClientOptions.token?: string | (() => string | undefined)
// controlRequest adds CONTROL_TOKEN_HEADER only for POST to paths starting with "/control/upgrade" — never on GETs
```
- **Server.** `serveStatic` injects `<meta name="homefleet-control-token" content="${token}">` right after `<meta charset="utf-8">`, for the `"/"` asset only. `content-length` is computed after the injection. The token is hex, so it needs no escaping, but the function asserts `/^[0-9a-f]{64}$/` before injecting. The two upgrade POST routes check the token BEFORE `readJsonBody`.
- **Daemon.** Generate and write the token just before `startControlServer`, and pass `token`.

- [ ] **Step 1: Failing tests:**
  - `control-token.test.ts`:
    - the generated token matches `/^[0-9a-f]{64}$/`, and two calls differ;
    - write then read round-trips;
    - a rewrite replaces the content;
    - read of an absent file gives `undefined`;
    - `tokensMatch("ab", "ab")` is true, and it is false for a different value, a different length, and `undefined`.
  - `control-server.test.ts` (use `start({ token: T })` and a `withToken` header helper):
    - `GET /` HTML contains the exact meta tag with `T`; `GET /dashboard/app.js` does not contain `T`; HEAD `/` content-length equals the GET body's byte length;
    - `POST /control/upgrade` without a token, with a wrong token, and with a token of a different length each gives 403 `{code:"bad-token"}`, and the fake surface's `upgrade` is never called;
    - `POST /control/upgrade` with `T` gives 202 as before;
    - `GET /control/status` and `GET /control/upgrades` work without a token;
    - a server started with no `token` refuses `POST /control/upgrade` with 403;
    - **`token only in the page body`:** `GET /control/status` body does not contain `T`.
  - Update the existing `POST /control/upgrade` tests to send the token.
  - control-client: an ephemeral real server with `token: T` and a client with `token: T` gets `upgrade()` 202; with no token it rejects `ControlRequestError` with status 403 and code `bad-token`; `status()` sends no token header (record headers on the fake server).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Update the control-server module header: the per-boot token now guards the upgrade routes, and the "read-only dashboard" wording changes. Update every existing test that POSTs `/control/upgrade`, including `upgrade/routes.integration.test.ts`, to construct its `ControlClient` with `token: readControlTokenSync(dataDir)`.
- [ ] **Step 4:** PASS, then the full suite (it must be green), typecheck and lint.
- [ ] **Step 5: Commit** `Control: per-boot token, embedded in the dashboard, required on upgrade POSTs`.

### Task 2: CLI sends the token

**Files:** Modify `cli/cli.ts` (+ test), `bin/homefleet.ts`.

**Interfaces** (the client-side `token` option already exists from Task 1):
- `CliDeps.readControlToken?: (dataDir: string) => string | undefined`. `withControlClient` passes `token: () => deps.readControlToken?.(deps.dataDir)` into `makeControlClient` (whose options gain `token`).
- `bin/homefleet.ts` wires `readControlTokenSync`.
- A 403 `bad-token` on `upgrade` prints: `Refused: the daemon's control token didn't match (${path}). Is homefleetd v0.6.0+ running from this data directory?`, then exits 1. `path` is `<dataDir>/control-token`.

- [ ] **Step 1: Failing tests:**
  - cli: `homefleet upgrade` with `readControlToken` returning `T` passes it through (fake client records the options); a `ControlRequestError(403, …, "bad-token")` prints the message above and exits 1. The same message is used for `homefleet fleet upgrade`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, full suite, typecheck, lint.
- [ ] **Step 5: Commit** `CLI: send the per-boot control token on upgrade requests`.

### Task 3: `includeSelf` on fleet upgrades

**Files:** Modify `control/messages.ts`, `upgrade/rollout.ts` (+ test), `upgrade/fleet-upgrade.ts` (+ test), `cli/control-client.ts` (types only, if needed).

**Interfaces:**
- `UpgradeRequestSchema` gains `includeSelf: z.boolean().optional()`.
- `RolloutStartInput.includeSelf?: boolean` (default `true`). When `false`, the rollout's `self.state` is `"skipped"` from the start, whatever the versions.
- `createFleetUpgradeSurface` passes `includeSelf` through for `"fleet"` and array targets. It is rejected with a 400 (zod refine) when combined with `targets: "self"`.

- [ ] **Step 1: Failing tests:**
  - rollout: `start({..., includeSelf: false})` with this node older than the target gives `self.state === "skipped"`, `upgradeSelf` is never called, and the final state is `done`.
  - fleet-upgrade: `includeSelf` is forwarded.
  - control-server: `{targets:"self", includeSelf:false}` gives 400; `{targets:[id], includeSelf:false}` gives 202.
- [ ] **Step 2–4:** FAIL, implement, PASS, full suite, typecheck, lint.
- [ ] **Step 5: Commit** `Upgrade: includeSelf lets a rollout target peers only`.

### Task 4: `POST /control/upgrade/prepare` (verify before confirm)

**Files:** Modify `upgrade/fleet-upgrade.ts` (+ test), `control/control-server.ts` (+ test), `control/messages.ts`, `cli/control-client.ts` (+ test, method `prepareUpgrade`), `daemon.ts`.

**Interfaces:**
- `PrepareUpgradeRequestSchema = z.strictObject({ version: semver.optional() })`.
- `FleetUpgradeSurface.prepare(input) → Promise<PreparedUpgrade>`:
  - `PreparedUpgrade = { current: string; target: string; verified: true; size: number }`;
  - the target is resolved like `startFleet` (`input.version` or the coordinator's `check().latest`);
  - it calls the same `prepare` (download + `verifyRelease` into the cache).
- Route `POST /control/upgrade/prepare`: token-protected (Task 1), reply `200 PreparedUpgrade`. `UpgradeError` maps as today (`fetch-failed` 502, `verify-failed` 422). If the target isn't newer than this node it is **not** an error: reply `200` with the target. The dialog decides who's eligible.
- `ControlClient.prepareUpgrade(input?)`.

A later `POST /control/upgrade` for the same version reuses the verified cache: `prepareRelease` already reuses a verified copy, so confirming is fast.

- [ ] **Step 1: Failing tests:**
  - fleet-upgrade: `prepare({})` calls `prepare` once with the resolved latest and returns `{current, target, verified: true, size}`; a `verify-failed` from `prepare` rejects with that code; a following `upgrade({targets:"fleet"})` for the same version leaves the fake prepare's "download" count at 1 (cache reuse).
  - control-server: 200 with token, 403 without, 422 on `verify-failed`, 502 on `fetch-failed`.
  - control-client: a round-trip.
- [ ] **Step 2–4:** FAIL, implement, PASS, full suite, typecheck, lint.
- [ ] **Step 5: Commit** `Control: POST /control/upgrade/prepare verifies a release before the user confirms`.

### Task 5: `availableUpgrade` in status (6-hour cache, dashboard-gated)

**Files:** Create `upgrade/available-upgrade.ts` + test. Modify `control/control-server.ts` (status handler reads the `dashboard` query flag; `ControlStatus.availableUpgrade?: string`), `daemon.ts`, and `cli/control-client.ts` (validate the optional string).

**Interfaces:**
```ts
export const AVAILABLE_UPGRADE_TTL_MS = 6 * 60 * 60_000;
export const AVAILABLE_UPGRADE_FAILURE_TTL_MS = 15 * 60_000;
export function createAvailableUpgrade(options: {
  currentVersion: string;
  latestVersion: () => Promise<string>;   // the coordinator's source.latestVersion
  now?: () => number;
}): {
  /** Cached value (never awaits network): the newer version, or undefined. */
  current(): string | undefined;
  /** Kick a background refresh if the cache is stale; never throws, one in flight at a time. */
  refreshIfStale(): void;
};
```
- `ControlSurface.status(opts?: { dashboard?: boolean })`. When `dashboard` is set, the daemon calls `refreshIfStale()`, then includes `availableUpgrade: current()` if it's defined.
- The status route passes `{ dashboard: url.searchParams.get("dashboard") === "1" }`.

- [ ] **Step 1: Failing tests**, with a fake clock and a counting `latestVersion`:
  - the first `refreshIfStale` triggers exactly one lookup, and `current()` returns `"0.6.1"` after it resolves when the current version is `0.6.0`;
  - within 6 h there are no more lookups;
  - after 6 h there is one more lookup;
  - when the latest equals the current version, `current()` is `undefined`;
  - a lookup that throws gives `current()` `undefined`, no retry before 15 min, and a retry after;
  - concurrent `refreshIfStale` calls share one lookup.
  - control-server: `/control/status?dashboard=1` calls the surface with `{dashboard: true}`, and a plain `/control/status` calls it with `{dashboard: false}`.
- [ ] **Step 2–4:** FAIL, implement, PASS, full suite, typecheck, lint.
- [ ] **Step 5: Commit** `Status: availableUpgrade from a 6-hour cached check, only while the dashboard polls`.

### Task 6: Dashboard view model (pure functions)

**Files:** Modify `dashboard/assets/view-model.js`, `dashboard/assets/view-model.d.ts`, `dashboard/view-model.test.ts`.

**Interfaces — Produces** (browser JS, no imports from daemon code):
```js
export function compareVersions(a, b)            // -1|0|1, strict X.Y.Z; non-semver sorts lowest
// nodeRows(nodes, ourVersion, target?) rows gain:
//   fullId, allowRemote: boolean, activeJobs: number,
//   upgrade: { eligible: boolean, label: string }   // label "⬆ <target> available" | "" ; eligible = reachable && allowRemote && older than target
export function selfUpgrade(status)              // { eligible, label } from status.daemonVersion vs status.availableUpgrade
export function confirmSummary({ prepared, error, peers, self, includeSelf, forceSelf })
  // → { title, lines: string[], canConfirm: boolean }
  // lines: "v<target> — signature verified", one line per peer ("<name>: will upgrade" | "<name>: busy (<n> jobs) — will be refused" | "<name>: not eligible (<why>)"),
  //        and for self: "This node: will upgrade last" | "This node: busy (<n> jobs) — will be refused unless forced" | "This node: already on <v>"
  // error → canConfirm false, lines [error]
export function progressRows(rollout)            // [{ name, state, reason }] for peers then "This node"; [] for null
export function startOutcome(error)              // maps a start failure: code "locked" → { kind: "already-running" }, else { kind: "error", message }
export function reloadDecision({ loadedVersion, statusVersion, badToken, lastReloadAt, now })
  // → true when (statusVersion !== loadedVersion || badToken) && now - lastReloadAt >= 10_000
```
- The existing `skew` and "(differs from ours)" behavior stays for display.
- The upgrade badge replaces the suffix only when the node is eligible.

- [ ] **Step 1: Failing tests** (names as the functions):
  - `compareVersions("0.5.9","0.6.0") === -1`, `("0.6.0","0.6.0") === 0`, `("x","0.1.0") === -1`;
  - eligibility: a reachable older peer with `allowRemote` is eligible; `allowRemote` false gives a label of "" with a why of "remote upgrades off"; a peer older than 0.4 (no `upgrade` field) is not eligible ("too old for remote upgrade"); an unreachable peer is not eligible; a peer newer than or equal to the target is not eligible;
  - `confirmSummary`: the verified line; a busy peer line; a busy self without force gives the "unless forced" line; a busy self with force gives "will upgrade last (forced)"; an error gives `canConfirm` false; no eligible targets gives `canConfirm` false;
  - `progressRows` order and reasons;
  - `startOutcome` locked → already-running;
  - `reloadDecision`: a version change gives true; a bad token gives true; within 10 s of the last reload gives false; no change gives false.
- [ ] **Step 2–4:** FAIL, implement (keep the `.d.ts` in sync), PASS, typecheck, lint.
- [ ] **Step 5: Commit** `Dashboard view model: upgrade eligibility, confirm summary, progress, reload logic`.

### Task 7: Dashboard UI wiring + asset scan carve-out

**Files:** Modify `dashboard/assets/index.html`, `dashboard/assets/app.js`, `dashboard/assets/app.css`, `dashboard/assets.scan.test.ts`, `dashboard/static.test.ts`, `dashboard/static.ts` (header comment only).

**Behavior** (logic comes from Task 6; `app.js` only wires it):
- **Token and polling.** Read the token once from `meta[name="homefleet-control-token"]`. Poll `/control/status?dashboard=1` (instead of `/control/status`) along with nodes and jobs. Remember `loadedVersion` from the first status.
- **Header.** An **Upgrade all** button, shown when any node or this node is eligible. Per-node **Upgrade** buttons sit in a new last column; extend `renderTable` with an optional `actions(row)` that returns an element or null, built with `el()` and never `innerHTML`. This node's section gets an **Upgrade this node** button when `selfUpgrade(...).eligible`.
- **Clicking a button:**
  1. Open a `<dialog id="upgrade-dialog">` (markup in `index.html`, styled in `app.css`) showing "Verifying v…".
  2. `POST /control/upgrade/prepare` with the token.
  3. Render `confirmSummary` lines as text nodes, plus a "Force this node even if busy" checkbox when self is busy and included.
  4. Confirm → `POST /control/upgrade` with the per-button targets (all: `"fleet"`; node: `[fullId]` + `includeSelf:false`; self: `"self"` + `force`). Cancel closes the dialog.
- **Progress.** While a rollout is running, poll `/control/upgrades` every 2 s and render `progressRows` into a `#upgrade-progress` section.
- **Errors.** On a start error, use `startOutcome`; if it's already running, switch to progress.
- **Restart.** When a poll fails while `self.state === "restarting"` (or after confirming a self/fleet upgrade), show the banner "Restarting… this page reloads when the node is back". Whenever `reloadDecision(...)` is true, `location.reload()`. Track `lastReloadAt` in `sessionStorage`, inside try/catch.
- **Scan carve-out** (`assets.scan.test.ts`):
  - keep every forbidden-sink rule;
  - replace "exactly one fetch, GET" with: every `fetch(` call names a method explicitly; the only `"POST"` uses are to `/control/upgrade/prepare` and `/control/upgrade`; each POST call site sends `x-homefleet-control-token`;
  - assert `app.js` never contains a 64-hex literal.

  `index.html` still has no inline script, style or handlers, and contains the `<dialog>`.
- `static.test.ts`: `/` contains `id="upgrade-dialog"`, and `app.js` references `/control/upgrade/prepare`.

- [ ] **Step 1: Failing tests:** the scan and static changes above.
- [ ] **Step 2:** FAIL, because the current assets lack the dialog and POST calls.
- [ ] **Step 3: Implement.** Keep `app.js` thin; all decisions call view-model functions.
- [ ] **Step 4:** PASS, typecheck, lint. Manual check: `pnpm build`, run a checkout daemon on alternate ports with a temp `HOMEFLEET_DATA_DIR`, open the dashboard in the in-app browser, and confirm the Upgrade buttons render and the dialog opens and shows a prepare error (no network). Report what was seen. Never run the real rig daemon from a Claude shell (MSIX; devlog 023).
- [ ] **Step 5: Commit** `Dashboard: upgrade buttons, verify-then-confirm dialog, progress, restart reload`.

### Task 8: Daemon integration

**Files:** Extend `packages/daemon/src/daemon.control.integration.test.ts`. Modify `upgrade/routes.integration.test.ts` only if its control-client calls now need the token.

- [ ] **Step 1: Failing tests:**
  - `the dashboard page carries the token written to <dataDir>/control-token`: GET `/`, extract the meta content, and it equals `readControlTokenSync(dataDir)`;
  - `POST /control/upgrade/prepare` without the token gives 403; with it, it reaches the prepare path (use the existing fake release source and test-key seams from Phase 3);
  - `a restarted daemon writes a new token`: stop, start on the same data dir, and the token differs;
  - `token only in the page body`: `/control/status?dashboard=1` and `/control/upgrades` responses don't contain it.
- [ ] **Step 2–4:** FAIL, then fix any seam, then PASS, then the full `pnpm test`.
- [ ] **Step 5: Commit** `Integration: per-boot token and prepare route across an assembled daemon`.

### Task 9: Docs + release prep v0.6.0

**Files:** `docs/specs/2026-09-24-read-only-dashboard-design.md` (status line, "read-only except upgrade", the security section's new POSTs and token, the out-of-scope list, testing); the fleet-upgrade spec's Decisions (a "Plan-time adjustments (Phase 4 plan)" row: RolloutStatus shape, prepare route, includeSelf, the `?dashboard=1` gate, the reload rule); `docs/reference/configuration.md` (the `control-token` file in "Data directory"); README (dashboard section: upgrade from the dashboard; the version references, banner and roadmap mark fleet upgrade done); the version bump in four places plus the RFC example; `docs/releases/v0.6.0.md`.

- [ ] **Step 1:** Write the docs. The release notes are honest: the rig proof (a v0.6.1 pushed from the dashboard, including this node's own restart and reload) follows publishing.
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test`, and `pnpm pack:release --tag v0.6.0 --out release-check` (then delete `release-check/`).
- [ ] **Step 3: Commit** `Release prep: v0.6.0 (dashboard upgrade + per-boot control token)`, push, open the PR, and get green CI. Merging and tagging need Hugo's go-ahead.

### Task 10: Rig proof (after v0.6.0 is published)

- [ ] Both nodes go to 0.6.0 with `homefleet fleet upgrade`. This uses the CLI token path; the laptop CLI reads the token file the Task Scheduler daemon wrote.
- [ ] Ship a small v0.6.1. Open the laptop dashboard and confirm the badges show "⬆ 0.6.1 available". Press **Upgrade all**. The dialog should show "signature verified", the tower first, then this node; after confirming, the progress should show tower `succeeded`, then "Restarting…", then the page reloads on 0.6.1.
- [ ] Negative check: an old dashboard tab left open across the restart reloads instead of failing.
- [ ] Devlog 024, rig notes.
