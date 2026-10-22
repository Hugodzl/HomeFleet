# Devlog 022: the first real self-upgrade, and a rollback drill

**2026-10-22**

Fleet upgrade Phases 1–2 shipped as v0.5.0 on 2026-10-20 and were proven on
the rig today. Both machines went 0.5.0 → 0.5.1 with `homefleet upgrade`, and
a forced-rollback drill passed on both. This closes plan Task 17, step 4.

Plan: [2026-09-25-fleet-upgrade-phase-1-2.md](../docs/plans/2026-09-25-fleet-upgrade-phase-1-2.md).
Releases: [v0.5.0](../docs/releases/v0.5.0.md), [v0.5.1](../docs/releases/v0.5.1.md).

## The last manual upgrade (0.4.0 → 0.5.0)

Both machines had to reach 0.5.0 by hand, since 0.4.0 has no
`homefleet upgrade`. It took far more steps than it should have, and every
one of them is now in the backlog entry "Node lifecycle automation":

- `npm i -g` replaced the tower's files but not its running daemon, so HFP
  port 56370 refused connections until Hugo found and restarted homefleetd.
- After the restart, the tower's model was `unreachable`. llama-server
  wasn't running, and model status is probed only at daemon startup.
- After llama-server was started, the model was `not_served`. Without
  `--alias qwen3.6-35b-a3b`, llama-server serves the model under its file
  path, which doesn't match the catalog id.
- Every check needed the control API with its header (versions and model
  status weren't in the CLI), plus delegated `node -e fetch(...)` jobs to
  probe the tower, because its allowlist blocks `curl.exe`. That's the
  allowlist working as designed.
- The laptop's daemon also vanished once, with no log line, crash event or
  reboot: the footprint of a hard `Stop-Process`. Most likely the tower's
  "stop every homefleetd" command also ran on the laptop. It's not
  confirmed, so it's a watch item: if it recurs, collect evidence before
  restarting.

## v0.5.1: make it visible

v0.5.1 exists to be the first upgrade target, so it carries something useful
for watching one. `homefleet nodes` gains a VERSION column, `nodes` and
`status` print each model's probe status (`qwen3.6-35b-a3b (not_served)`
would have explained the problem above at a glance), and `status` prints
`lastUpgrade`. Five new CLI tests; 1057 passing.

## The real upgrades (0.5.0 → 0.5.1)

| | laptop | tower |
| --- | --- | --- |
| `homefleet upgrade` | `Upgraded to 0.5.1.`, exit 0, 21 s | `Upgraded to 0.5.1.` |
| npm install | 14 s | not measured |
| new daemon healthy after launch | 2.6 s | not measured |
| `lastUpgrade` | `0.5.0 → 0.5.1 succeeded` | `0.5.0 → 0.5.1 succeeded` |

Both ran the full production path: GitHub latest-release lookup, download,
signature check against the pinned key, guards, a verified rollback copy of
0.5.0 cached next to 0.5.1, the lock, graceful shutdown, the detached
updater, and the health check. From the laptop afterwards, `homefleet nodes`
showed the tower at `0.5.1` with `qwen3.6-35b-a3b (ok)`, and a delegated
command job succeeded.

## The rollback drill

To test a rollback for real, the node has to install a release whose daemon
won't start. Going through `homefleet upgrade` would mean signing a
deliberately broken build with the real release key, so it doesn't.
[`scripts/rollback-drill.mjs`](../scripts/rollback-drill.mjs) drives the real
updater directly instead:

1. It takes the node's cached, verified `homefleet-<current>.tgz`, repacks
   it as `<current+1>` with a `homefleetd.js` that exits at startup, and
   puts it in `upgrades/drill-<v>/`.
2. It writes the same `upgrade-state.json` the daemon writes, with the
   signed `<current>` tarball as the rollback copy, takes the lock, and
   starts the `updater.mjs` that the daemon left behind during the real
   upgrade.
3. It waits for `upgrade-result.json` and checks for `rolled-back` with the
   daemon back on `<current>`.

The signature and guards don't need covering again here, because the real
upgrades exercised them. What the drill adds is install → failed health
check → reinstall → relaunch, on hardware.

Results, all `PASS: the broken 0.5.2 was rolled back to 0.5.1`:

- **Laptop, run 1:** passed in 96 s, but the script itself then crashed on
  exit with a libuv assertion (`UV_HANDLE_CLOSING`, `src\win\async.c`).
  Calling `process.exit()` while undici's `fetch` sockets are still closing
  trips it on Windows. The fix is to set `process.exitCode` and let the event
  loop drain. The daemon wasn't affected.
- **Laptop, run 2:** passed in 97 s, exit 0.
- **Tower:** passed. `homefleet status` then showed
  `lastUpgrade: 0.5.1 → 0.5.2 rolled-back … (the 0.5.2 daemon did not report
  its version within 60000 ms)`, and the model came back `ok` with no manual
  step, since llama-server was already running.

The 96 s break down as about 5 s for the drill's exit timeout, the broken
install, 60 s of health-check timeout, then reinstalling and relaunching
0.5.1. The daemon log tells the same story:
`homefleetd 0.5.2: rollback drill build, exiting`, then 0.5.1 starting.

## What this doesn't prove

- **The drill hard-kills the daemon** (the updater's exit timeout) instead
  of the graceful `requestShutdown` path. That path is proven by the real
  upgrades.
- **Both upgrades downloaded from GitHub, and `npm i -g` resolved
  dependencies from the registry.** An offline node can't upgrade yet.
- **The failed-install branch** (npm exits non-zero → rollback) and the
  no-rollback-copy branch are covered only by `updater.test.ts`.
- **Windows only.** The drill script finds the daemon through CIM.

## Follow-ups

- Node lifecycle automation (backlog, Hugodzl/HomeFleet#2): `homefleet daemon
  start|stop|restart`, model re-probing, `setup --apply`, supervising
  llama-server.
- Fleet upgrade Phase 3: push an upgrade to peers over HFP. Phase 4: trigger
  it from the dashboard behind the per-boot token.
- Watch item: the unexplained laptop daemon stop.
