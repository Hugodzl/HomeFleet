# Devlog 023: the first fleet push, and the daemon that lived inside an app

**2026-10-23**

Fleet upgrade Phase 3 shipped as v0.5.2 and was proven on the rig:
`homefleet fleet upgrade` on the laptop pushed v0.5.3 to the tower in 14 s.
On the way, the laptop daemon's two silent disappearances got a root cause.
It had been running inside the Claude desktop app's MSIX package all along.

Plan: [2026-10-22-fleet-upgrade-phase-3.md](../docs/plans/2026-10-22-fleet-upgrade-phase-3.md).
Releases: [v0.5.2](../docs/releases/v0.5.2.md), [v0.5.3](../docs/releases/v0.5.3.md).

## The daemon that lived inside an app

The laptop's `homefleetd` vanished twice on 2026-10-22: no log line, no
crash event, no reboot. The first time looked like a stray `Stop-Process`.
The second time, the timing lined up exactly with the Claude desktop app
restarting (every `claude.exe` started at 22:37).

The app is an MSIX package. Every process launched from its terminals runs
in the package context, and that has two effects:

- **Package processes die when the app closes or updates.** The daemon, the
  detached updater and the daemon it relaunches were all descendants of a
  Claude shell, so all of them were in the package.
- **`%LOCALAPPDATA%` is virtualized.** Writes land in
  `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Local\`, and reads from inside
  the package see that copy. The laptop's identity, trust store, known nodes
  and config, and the rig scripts too, had lived there since July. From a
  Claude shell, `C:\Users\hugod\AppData\Local\homefleet` *shows* the package
  copy, so nothing looked wrong.

That came to light when the daemon was moved to Task Scheduler, outside the
package. It came up with a brand-new identity (`ordinateur-HUGO-ceb96969`, no
pairings), because the real folder was empty. It then dutifully upgraded
itself to 0.5.2 against that junk identity.

**Fix on the rig:** a one-shot scheduled task, running outside the package,
renamed the junk folder to a backup and copied the package's `homefleet` and
`homefleet-rig` folders into the real `%LOCALAPPDATA%`. The laptop daemon now
runs from an at-logon task ("HomeFleet Daemon", the shape `homefleet setup`
prints), with svchost as its parent. Identity `6842f1f3…` and its pairings
came back intact. npm's global folder was never virtualized, so there was
only ever one install.

The tower was never affected, because Hugo starts its daemon from his own
PowerShell window. v0.5.3 documents the pitfall (README Install and the
configuration reference's "Data directory"). Detecting it in code would need
a Windows API Node doesn't expose without a native add-on.

## The rig proof

| Step | Result |
| --- | --- |
| Laptop 0.5.1 → 0.5.2 (`homefleet upgrade`, under Task Scheduler) | succeeded, 27 s; the updater survived the daemon exiting the task |
| Tower 0.5.1 → 0.5.2 (`homefleet upgrade --to 0.5.2`) | succeeded. A first attempt never ran on the tower, which still reported 0.5.1 to the laptop, so the second was pinned to 0.5.2 to keep 0.5.3 for the push. |
| **Negative run:** `homefleet fleet upgrade` → 0.5.3 with the tower's `allowRemote` off | the tower stayed on 0.5.2; the laptop upgraded itself last (0.5.2 → 0.5.3, 24 s); exit 1. **But the CLI reported `tower: pushing` instead of `refused`** (see below). |
| **Positive run:** `allowRemote: true` on the tower, `homefleet fleet upgrade` on the laptop | `tower: pushing → restarting → succeeded`, **14 s**, exit 0, "Rollout complete: 1 upgraded"; the laptop skipped itself (already 0.5.3). The tower reports 0.5.3, `lastUpgrade` succeeded, its model `ok`, and a delegated command job still succeeds. |

So the full production path ran across two real machines:

1. control API, then the daemon-side `FleetRollout`;
2. a signed push over mTLS HFP;
3. on the tower: signature and guard checks, then the tarball download;
4. the detached updater and the relaunch;
5. the laptop's `hello` seeing 0.5.3.

## What the negative run showed

The refusal and the laptop's own self-upgrade both happened between two of
the CLI's 2-second polls. The laptop daemon restarted, and its in-memory
rollout status went with it, including the tower's final `refused` with
the UPGRADE_DISABLED reason. The CLI correctly fell back to waiting for
the local restart. But it then summarized from the last status it had seen,
so it printed `tower: pushing` as the problem. The exit code was right (a
peer that wasn't upgraded makes the run exit 1); the reason was wrong.

The fix belongs in the daemon: write the final rollout status to the data
directory just before the self-upgrade hands off, and serve it from
`GET /control/upgrades` after the restart. Recorded in the backlog.

## Not verified

- **Whether the tower pulled the tarball from the laptop or from GitHub.**
  Both are valid. The laptop had 0.5.3 cached and verified, and the tower
  normally knows the laptop's address from UDP discovery. But the tower's
  daemon log wasn't captured, so which source served the bytes is unknown.
- **The fleet-push rollback path on hardware.** It is covered by
  `FleetRollout` unit tests and the Phase 2 drill. No broken build gets a
  real-key signature.

## Follow-ups

- Persist the final rollout status across the requester's own restart
  (backlog, under fleet upgrade).
- Hardening follow-ups from the Phase 3 final review (separate session).
- Fleet upgrade Phase 4: the dashboard trigger and the per-boot control token.

## Addendum: v0.5.4, the second fleet push (2026-10-23)

v0.5.4 ships the Phase 3 hardening (Hugodzl/HomeFleet#8), including the fix
for the stale CLI summary above: the final rollout status now survives the
requester's restart. The second fleet push (`homefleet fleet upgrade` on the
laptop, 0.5.3 → 0.5.4) took 55 s and left both nodes on 0.5.4: the tower
first (`lastUpgrade` succeeded, model `ok`), then the laptop itself last
(`0.5.3 → 0.5.4 succeeded`, daemon restarted under its Task Scheduler task).

The CLI still printed a stale `tower: restarting` and exited 1. **That run
couldn't show the fix:** the rollout ran in the laptop's 0.5.3 daemon and was
watched by the 0.5.3 CLI, and both predate the persisted status. The fix only
applies once the requesting node already runs 0.5.4, so the next push
(0.5.4 → 0.5.5) is the one that proves it on hardware.

Also seen while cutting v0.5.4: a pre-existing Windows CI flake in
`mcp/http-transport.test.ts` (oversized body → 413, the client sees the reset
first). It passed on re-run and is now a backlog item.

## Addendum: v0.5.5, the saved rollout status proven (2026-10-23 evening)

v0.5.5 re-probes the model catalog every 60 s, so a late llama-server turns
`ok` without a daemon restart. It also fixes two flaky tests:

- the Windows 413 test, which now sends headers only;
- a concurrent-push test that assumed the first of two simultaneous pushes
  always wins. Either may win, and the coordinator always accepted exactly
  one; it failed about 1 run in 8.

The third fleet push (`homefleet fleet upgrade` on the laptop, 0.5.4 → 0.5.5)
was the first run with a requester that already had v0.5.4's saved rollout
status. It recreated exactly the situation that misreported twice before:
the CLI's last poll saw `tower: restarting`, and then the laptop restarted
to upgrade itself. This time the CLI read the saved status back and printed
**"Rollout complete: 2 upgraded."**, exit 0, 39 s. Afterwards the restarted
laptop daemon served `GET /control/upgrades` with
`{state: "done", peers: [tower: succeeded], self: {state: "succeeded"}}`.
Both nodes are on 0.5.5, with the tower's model `ok`.

Fleet upgrade Phases 1–3 are now proven end to end on the rig. Next is
Phase 4: the dashboard trigger and the per-boot control token.
