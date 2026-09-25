# Devlog 019 — the read-only dashboard

**2026-09-24**

The read-only web dashboard is built and served by `homefleetd`.
`homefleet dashboard [--no-open]` prints the loopback URL and opens it; the
page shows this node (identity, versions, ports, roles, executors, and
per-model catalog status), paired nodes (reachable yes/no, and when
reachable their version, executors, models, and load, with a version-skew
badge), and jobs in both directions — worker jobs this node ran for peers,
and delegated jobs this node sent out, each with a last-seen status. It
polls the existing control-server data routes every 3 s while the tab is
visible, never issues a mutating request, and keeps the last good render
behind an "unreachable" banner on fetch failure. `control.dashboard`
(default `true`) can turn the static page off without touching the JSON
routes the CLI depends on.

Plan: [2026-09-24-read-only-dashboard.md](../docs/plans/2026-09-24-read-only-dashboard.md).
Spec: [read-only dashboard design](../docs/specs/2026-09-24-read-only-dashboard-design.md).

## Security model

The dashboard's static routes (`GET /`, `/dashboard/app.js`,
`/dashboard/view-model.js`, `/dashboard/app.css`) sit on the same loopback
control server as the mutating `pair/*` routes, so the existing defenses had
to stay intact rather than be special-cased around. Static routes are
**exact-match GET/HEAD only** — no path is derived from the request, so
there is no filesystem and no traversal surface to test for. They are
**exempt from the `x-homefleet-control: 1` header** a browser navigation
can't set, but they stay behind the readiness guard and the Host-header
allow-list that blocks DNS rebinding. Every static response carries a strict
CSP (`default-src 'none'`, `script-src`/`style-src`/`connect-src 'self'`,
`frame-ancestors 'none'`, no `'unsafe-inline'`, no `'unsafe-eval'`) plus
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store`. The JSON routes (`/control/status`,
`/control/nodes`, and the new `/control/jobs`) keep the header requirement
exactly as before — the page's same-origin `fetch()` sends it and needs no
CORS, and the server still sends none — and `/control/jobs` is metadata-only
by construction: `JobManager.list()` and `DelegationRegistry.list()` copy
only summary fields, never a prompt, instructions, event, or result body.

The client renders every value through `textContent` / `createElement` /
attribute setters, never `innerHTML` or any of its siblings, and only ever
issues `GET`. `assets.scan.test.ts` statically scans every asset source for
the forbidden-sink list and for any non-GET request, so that rule can't
regress silently; the CSP is the second layer if it ever does. The trust
boundary is unchanged from MCP and the CLI — same OS user, no per-boot
token — with the control-server header comment already naming that as the
upgrade path if the boundary is ever judged insufficient.

## The `?raw` spike and where it landed

Task 1 spiked embedding the dashboard assets as strings via `import appJs
from "./assets/app.js?raw"` rather than reading files from disk at runtime
(which would have meant a packaging change and a source/installed path
divergence — see the design doc's rejected alternatives). `?raw` worked in
all three places it needed to: **vitest** natively, **tsc** via an ambient
`declare module "*?raw"` in `dashboard/raw.d.ts`, and **tsup** via a small
custom `rawText` esbuild plugin. The generated-`assets.generated.ts`
fallback the spec allowed for wasn't needed.

The plan's originally-planned assertion — that the built bin embeds the
page — initially failed in the spike, but not because `?raw` itself didn't
work: esbuild tree-shook `static.ts` out of the bin entirely, since nothing
in a bin imported it yet at that point. The assertion moved to Task 3, where
the control server wires in the static routes, and it passes there.

Two plugin fixes came later, once the daemon and its CSS existed:

- The esbuild `Plugin` type is derived from tsup's own `Options` type
  (`NonNullable<Options["esbuildPlugins"]>[number]`), since `esbuild` isn't
  resolvable as a direct import from the daemon package — and
  `tsup.config.ts` sits outside `tsconfig`'s `src`, so `pnpm typecheck`
  never covers it; that's a standing gap noted for future tsup config edits,
  not something this task could close.
- When `app.css` arrived, tsup's own postcss `onLoad` hook claimed `.css`
  paths even inside the raw-text namespace and emitted a stray
  `dist/bin/*.css` — caught by the pack test's exact-file-list assertion
  from S1. Fixed by resolving `?raw` imports to a `.raw`-suffixed virtual
  path (with the real path carried in `pluginData`) instead of letting the
  extension read as CSS; a first attempt suffixed with a literal `\0`,
  which put NUL bytes into the bundle output and had to be replaced with the
  printable `.raw` instead.

## Rig check (2026-09-25)

Ran on the laptop, temporarily, against a checkout build of `7e622b9` via
`hf-daemon.ps1` (the rig's detached-daemon script) — the installed daemon is
still v0.3.1, which predates the dashboard, and no release was cut for this
(Hugo's call, per Task 12 step 4; not asked this session). The installed
v0.3.1 daemon was restored afterward.

`homefleet dashboard --no-open` printed `http://127.0.0.1:56373/`. The page
rendered in the Claude desktop browser pane with no console errors:

- **This node** (laptop): 0.3.1 · protocol 0.3.0, `command`+`agent`
  executors, models `qwen3.5:4b` and `llama3.2:1b` both `ok`.
- **Paired nodes**: tower `192.168.68.73:56370` reachable, 0.3.1, executors
  `command`/`agent`/`write`, model `qwen3.6-35b-a3b`, load `0/2`. A stale
  `laptop-delegator` trusted entry showed as unreachable — a leftover from
  earlier rig setup, not a regression.

Delegated `git rev-parse HEAD` to the tower via `hf-delegate.mjs`: succeeded
in ~2 s (stdout the tower's HEAD; a command job runs against the
*delegator's* bundled workspace, as the S1 rig check on 2026-09-24 already
established). The delegated-jobs table then showed the row
(`f1172904-883…`, `command` → tower, repo `homefleet`) reach status
**succeeded**, last seen, as the MCP driver polled `job_result`. No
screenshots were saved — observations only. The daemon still reports
version `0.3.1` throughout, since no version bump happened for this
temporary build.

## Review

Executed subagent-driven: sonnet implementers per task, opus review per
task, and a fable final review across the whole branch. Verdict **READY**,
no critical or important findings. Its two follow-ups are already applied:
`cancel_job` now records the observed status through the same
`observeStatus` path as `job_status`/`job_result`, and the docs note the
caveat that `homefleet-mcp-stdio` delegations use their own registry and so
don't show up in this dashboard's delegated-jobs table. One cosmetic item
was left as-is: the browser's automatic `/favicon.ico` request 403s against
the static route table (console noise only, no functional effect).

## Follow-ups

- Live job events (the dashboard currently polls; no SSE/event stream yet).
- A tray launcher — a thin native shell that just opens this URL, per the
  design doc's original "tray app + web dashboard" roadmap slot.
- A per-boot control token, if the same-OS-user trust boundary is ever
  judged insufficient — the control-server header comment already names
  this as the upgrade path.
- The stale `laptop-delegator` trust entry surfaced by the rig check could
  be cleaned up.
- The `/favicon.ico` 403 noise, if it's ever worth a dedicated route.
- Next up per the approved sequencing: **S2 + A1** (the mutating half —
  rename, config edits, GUI pairing, cancel).
