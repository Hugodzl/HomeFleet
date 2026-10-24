# Read-only Dashboard — Design

- **Date:** 2026-09-24
- **Status:** implemented (v0.4). **Amended in v0.6.0:** the page is no longer
  strictly read-only. It can start an upgrade through two token-guarded POSTs;
  see [Amendment: upgrade from the dashboard](#amendment-upgrade-from-the-dashboard-v060).
  Everything below describes the v0.4 design; the amendment says what changed.
- **Roadmap slot:** third step of the
  [approved sequencing](2026-07-12-backlog-structuring.md#approved-sequencing)
  (after S1 packaging, before S2 + A1). The
  [design doc](2026-07-06-homefleet-design.md) roadmap calls it "tray app +
  web dashboard"; this release ships the **web dashboard only**.

## Goal

Give a person a live, glanceable view of their fleet from a browser —
this node, its paired peers, and recent jobs in both directions — without
adding any way to change anything. It is the viewing half of the backlog's
A1 "Fleet management GUI"; mutations (rename, config edits, GUI pairing,
cancel) are S2 + A1's job and are deliberately absent.

Success: on the rig laptop, `homefleet dashboard` opens a page that shows
the laptop's own status with per-model catalog status, the tower as a
reachable paired node with its capabilities, and a delegated job's row
moving from `queued` to a terminal status as the front agent polls it —
with no mutating request ever issued by the page.

## Decisions

| Question | Decision |
| --- | --- |
| Web vs tray | **Web page served by `homefleetd`.** Tray is later, as a thin launcher that opens this URL. |
| Where it's served | The existing **loopback control server** (`127.0.0.1:56373` by default), same origin as the control data routes. |
| How it's built | **Vanilla HTML/CSS/ES-module JS, embedded in the daemon bundle** as strings. No new runtime deps, no framework, no runtime file-path lookups; the S1 release tarball needs no change. |
| What it shows | This node, paired nodes, worker jobs, delegated jobs — **metadata only** (no prompts, instructions, output, or result bodies). |
| Freshness | Poll every 3 s while the tab is visible; manual refresh button; "daemon unreachable" banner on fetch failure. |
| Delegated-job status | **Last status the MCP tools observed** — the dashboard poll never triggers LAN calls. Labeled "last seen". |

Rejected alternatives: a native tray app (a GUI toolkit + separate
packaging, far heavier than the page); a CLI TUI (dead end for A1); assets
read from disk next to `dist/` (packaging change + source/installed path
divergence); a `packages/dashboard` Vite + Preact app (build pipeline and
deps a read-only page doesn't need — revisit when A1 adds forms).

## Architecture

```
browser ──GET /──────────────► control server ── static asset (embedded string)
   │                             (loopback, Host-checked)
   └─fetch + x-homefleet-control:1
        GET /control/status ──► ControlSurface.status()       (existing)
        GET /control/nodes  ──► ControlSurface.listNodes()    (existing)
        GET /control/jobs   ──► ControlSurface.listJobs()     (NEW)
                                   ├─ JobManager.list()              (worker side)
                                   └─ DelegationRegistry.list()      (delegator side)
```

### Units

1. **Dashboard assets** — `packages/daemon/src/dashboard/assets/`:
   `index.html`, `app.css`, `app.js` (DOM glue: fetch, poll, render), and
   `view-model.js` (pure functions: API JSON → display rows, badges,
   relative times, version-skew flags). Plain JS so the browser loads it
   unmodified; `view-model.js` has a sibling `.d.ts` so TS tests can import
   it. Embedded into the bundle at build time (mechanism below).
2. **Static route table** — `packages/daemon/src/dashboard/static.ts`: maps
   the fixed paths to `{ body, contentType }` and owns the security headers.
   No path is derived from the request beyond an exact-match lookup (no
   filesystem, no traversal surface).
3. **Control server additions** — `control-server.ts`: static routes,
   `GET /control/jobs`, the `dashboard` enable flag.
4. **Job listing** — `JobManager.list()` and extended `DelegationRegistry`
   (`record` carries `type` + `recordedAt`; `observeStatus(jobId, status)`;
   `list()`).
5. **MCP tools** — `delegate_task` records `type`; `job_status` /
   `job_result` call `observeStatus` with the snapshot's status.
6. **CLI** — `homefleet dashboard [--no-open]`: reads the running daemon's
   control port, prints the URL, opens the default browser unless
   `--no-open`.
7. **Config** — `control.dashboard: boolean`, default `true`.

### Asset embedding

Assets are imported as text with a `?raw` suffix
(`import appJs from "./assets/app.js?raw"`). Vitest (Vite) supports `?raw`
natively; the tsup build gets a small esbuild plugin that resolves `?raw`
imports to their file contents as a string; TypeScript gets an ambient
`declare module "*?raw"`. The plan's first task is a spike proving all
three (vitest, `tsc --noEmit`, `tsup` build + the installed bin serving the
page). If the spike fails, fall back to a generated
`dashboard/assets.generated.ts` (a build-time script writing string
constants, checked for freshness by a test) — same serving code either way.

## Serving and security

The control server's existing defenses are unchanged and load-bearing:
loopback-only bind, Host-header allow-list (DNS rebinding), and the
`x-homefleet-control: 1` header on every data route (browser CSRF, since the
server sends no CORS headers).

- **Static routes** — `GET /` (→ `index.html`), `GET /dashboard/app.js`,
  `/dashboard/view-model.js`, `/dashboard/app.css`. `GET` and `HEAD` only.
  They are **exempt from the control header** (a browser navigation cannot
  set custom headers) but **not from the Host check or the readiness
  guard**. They serve fixed bytes and never carry live data.
- **Every static response** carries:
  - `Content-Security-Policy: default-src 'none'; script-src 'self';
    style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none';
    form-action 'none'; frame-ancestors 'none'`
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, `Cache-Control: no-store`
  - an exact `Content-Type` with `charset=utf-8`.
- **Data routes** keep the header requirement exactly as today. The page's
  `fetch()` is same-origin, sends the header, and needs no CORS.
- **XSS discipline** — the same origin hosts the mutating `pair/*` routes,
  so script injection would be a real escalation. The client renders data
  only via `textContent`, `createElement`, and attribute setters; never
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`,
  `Function`, or string `setTimeout`. The client only ever issues `GET`. A
  test statically scans the asset sources to enforce both rules; the CSP
  (no `'unsafe-inline'`, no `'unsafe-eval'`) is the second layer.
- **`control.dashboard: false`** makes the static routes 404; data routes
  stay (the CLI uses them).
- **Unchanged trust boundary:** same OS user, as for MCP and the CLI. No
  per-boot token in this release (the control-server header comment already
  names the upgrade path if that is ever judged insufficient).

## What the page shows

1. **This node** — name, device ID (short + copyable full), platform,
   daemon/protocol version, HFP/MCP/control ports, roles, executors, models
   with per-model catalog `status`/`label`, `activeJobs / maxConcurrentJobs`.
2. **Paired nodes** — name, short device ID, host:port, reachable yes/no;
   when reachable, daemon version, executors, models, load. A
   **version-skew badge** when a peer's `daemonVersion` differs from ours.
3. **Worker jobs** (this node ran them for peers) — short job ID, type,
   owner (paired name, else short device ID), repoId, status, created /
   started / finished (relative times), error code if failed.
4. **Delegated jobs** (this node sent them out) — short job ID, type, target
   (paired name, else short device ID), repoId, sent-at, last-seen status
   with its observation time, applied `homefleet/<id>` branch if any.

Empty states are explicit ("No jobs since the daemon started"). History is
in-memory only, as today: it resets on daemon restart, and the page says so.

## New endpoint: `GET /control/jobs`

Requires the control header. Response:

```ts
interface ControlJobs {
  worker: WorkerJobSummary[];     // newest first; all retained (≤ 256)
  delegated: DelegatedJobSummary[]; // newest first; latest 100
}
interface WorkerJobSummary {
  jobId: string;
  type: "recon" | "command" | "write";
  ownerDeviceId: string;
  ownerName?: string;             // from the trust store, when paired
  repoId: string;
  status: JobStatus;
  createdAt: number;              // epoch ms
  startedAt?: number;
  terminalAt?: number;
  errorCode?: string;             // from a failed result, when present
}
interface DelegatedJobSummary {
  jobId: string;
  type: "recon" | "command" | "write";
  targetDeviceId: string;
  targetName?: string;
  repoId: string;
  recordedAt: number;
  lastStatus: JobStatus;          // "queued" at record time
  lastStatusAt: number;
  appliedBranch?: string;
}
```

- `JobManager.list()` reads retained records **without owner scoping**.
  That is correct only for this local, same-user admin view; it is never
  exposed over HFP, and the method's doc comment says so.
- `DelegationRegistry` is bounded as today (1024, evict-oldest); `list()`
  returns the newest 100.
- Summaries are built from metadata fields only; no `params` body, prompt,
  instructions, events, or result payload is copied.

## Out of scope

Any mutation other than the v0.6.0 upgrade (rename, config edits, GUI
pairing, cancel), live job-event streaming or output views, a tray app,
remote management, persisted job history, cross-node aggregation (each
daemon's dashboard shows only what *that* daemon knows).

## Amendment: upgrade from the dashboard (v0.6.0)

[Fleet upgrade Phase 4](2026-09-25-fleet-upgrade-design.md) lets the page
trigger an upgrade, so the dashboard is **read-only except upgrade**. Nothing
else changed: still no rename, config edit, pairing or cancel from the page.

**Two POST routes, both token-guarded:**

- `POST /control/upgrade/prepare` downloads and verifies a release into the
  cache without starting anything, so the confirm dialog can say "signature
  verified" before the person confirms (verify, then confirm).
- `POST /control/upgrade` starts the rollout (the same route the CLI uses).
  The page sends `targets: "fleet"` for Upgrade all, `targets: [id],
  includeSelf: false` for a peer's button, and `targets: "self"` for this
  node's button.

**The per-boot control token** (`control/control-token.ts`):

- 32 random bytes, hex (64 chars), **a new token every daemon boot**.
- Written to `<dataDir>/control-token` with mode 0600 (any stale file is
  removed first, because `mode` only applies on creation). The CLI reads it
  from there.
- Embedded in the served page as
  `<meta name="homefleet-control-token" content="...">`; only `GET /` carries
  it. A cross-origin page cannot read that page (same-origin policy, no CORS
  headers), which is the point.
- Sent back in the `x-homefleet-control-token` request header.
- Compared with `crypto.timingSafeEqual` on equal-length buffers; a length
  mismatch is refused without comparing.
- Required **only** on `POST /control/upgrade` and
  `POST /control/upgrade/prepare`. The Host check and the
  `x-homefleet-control: 1` check still run first. A missing or wrong token
  answers 403 `{ error, code: "bad-token" }` and the body is never read.
  Every other route, including the `pair/*` and `unpair` writes, is
  unchanged.

**CSP and the static scan.** The CSP is unchanged (`connect-src 'self'`
covers the POSTs). The asset scan's rule "the client only ever issues GET"
became a carve-out: every `fetch` must name its method as a literal
double-quoted `"GET"` or `"POST"`; there is exactly one POST call site; it
may only target `/control/upgrade` or `/control/upgrade/prepare`; and it
must send the token header. The forbidden-sink list is unchanged, and matters
more now that the token sits in the page: no `innerHTML` and the rest.

**Progress and reload.** While a rollout runs the page polls the shipped
`RolloutStatus` (`GET /control/upgrades`) and shows each peer's step and
this node's. Restarting this node rotates the token and swaps the assets, so
the page reloads once afterwards (see the fleet upgrade spec's decisions).

**The upgrade badge.** `GET /control/status?dashboard=1` adds
`availableUpgrade` (the latest release, when newer than this daemon). The page
marks each node that could take the push; a peer shows no badge when it is
unreachable, too old for remote upgrade, has `allowRemote` off, or is already
current.

## Error handling

- Data-route failures keep the existing `{ error }` shape; `listJobs` has no
  collaborator that can fail, but the route sits under the same 500
  backstop.
- The client treats any non-2xx or network failure as "unreachable": keeps
  the last good render, shows a banner with the time of the last success,
  and keeps polling. Polling pauses while `document.hidden`.
- A node-directory `hello` timeout already yields `reachable: false`; the
  page shows it as such, not as an error.

## Testing

- **Control server** (`control-server.test.ts`): static routes served
  without the control header; still 403 on a bad Host; security headers
  present and exact; `HEAD` works, `POST /` 404; data routes still 403
  without the header; `/control/jobs` shape; `dashboard: false` → static
  404, data 200.
- **Units**: `JobManager.list()` ordering + metadata-only fields;
  `DelegationRegistry` `record`/`observeStatus`/`list` (ordering, cap,
  unknown-id no-op); tools call `observeStatus` on `job_status` /
  `job_result` and record `type` on `delegate_task`.
- **Client**: `view-model.js` unit tests against fixture API responses
  (rows, skew badge, empty states, relative times); a static-scan test over
  every asset for the forbidden-sink list and for any non-GET request.
- **Build**: a test (or the spike's check) that the built `homefleetd.js`
  contains the embedded assets, so an installed tarball serves the page.
- **Integration** (`daemon.control.integration.test.ts`): assembled daemon
  serves `/` and returns a delegated job in `/control/jobs` after a
  delegation between two loopback daemons.
- **CLI**: `homefleet dashboard --no-open` prints the URL; the opener is
  injected so tests never launch a browser.
- **Rig check**: open the dashboard on the laptop with the tower paired and
  run one delegation; record in the devlog.

**Added in v0.6.0:**

- `control/control-token.test.ts`: generation, the file rewritten each boot,
  constant-time compare.
- `control-server.test.ts`: both POSTs answer 403 `bad-token` without or with
  a wrong token and never reach the surface; the token is injected into the
  served page.
- `dashboard/assets.scan.test.ts`: the POST carve-out above (method literal,
  one call site, allowed paths, token header) plus the unchanged sink list.
- `dashboard/view-model.test.ts`: upgrade eligibility, badges, confirm
  summary, progress, reload decision. There is no DOM test environment, so
  the page logic lives in `view-model.js` as pure functions.
- `daemon.control.integration.test.ts`: an assembled daemon serves the token
  in the page, writes the file, and refuses the POST without it.
- **Rig check (after publishing):** push v0.6.1 from the dashboard, including
  this node's own restart and the page reload; record in the devlog.
