# Devlog 025: three small releases the rig asked for

**2026-11-03**

v0.6.2, v0.6.3 and v0.6.4 shipped within a day of each other. None of them was
on the roadmap. Each one came from something that went wrong while using the
rig right after [devlog 024](2026-11-02-dashboard-upgrade.md): a dashboard that
looked healthy when it wasn't, a daemon that died without a trace, and a
release that stayed invisible for hours.

Releases: [v0.6.2](../docs/releases/v0.6.2.md),
[v0.6.3](../docs/releases/v0.6.3.md), [v0.6.4](../docs/releases/v0.6.4.md).

## v0.6.2: a healthy-looking tower with no model

After the v0.6.1 proof, the tower's llama-server was down following a reboot.
`homefleet nodes` said so. The dashboard didn't: a peer row listed model ids
only, so a reachable daemon with a dead model server looked fine.

The Models column now uses the `id (status)` form the CLI has had since v0.5.1,
for example `qwen3.6-35b-a3b (unreachable)`, and turns amber when any model is
not `ok`.

## v0.6.3: a daemon that left no trace

The laptop's daemon stopped on 2026-11-02, between about 11:05 and 11:20 local.
This was the third unexplained stop, and the first one the earlier root cause
doesn't cover. [Devlog 023](2026-10-23-first-fleet-push.md) moved the daemon out
of the Claude desktop app's MSIX package, and the app hadn't restarted anyway.
There was no reboot or sleep, and no crash in the Event Log.

The real problem was how little there was to read. A daemon started by the
scheduled task had no stderr redirect, so it logged nowhere. A daemon relaunched
by the updater logged to `homefleetd.err.log`, with no timestamps. That file
held a start line and then nothing, not even "shutting down", which suggests
something killed the process from outside. That's as far as it could go.

So the daemon now always writes `<dataDir>/homefleetd.log` itself, however it
was started:

- Every stderr line is copied there with an ISO-8601 UTC timestamp.
- Each start and each exit gets a line, and an uncaught exception or unhandled
  rejection logs its stack before the process dies. Writes are synchronous, so
  these survive a crash.
- Past 5 MB the file rotates once to `homefleetd.log.1`.

A forced kill still can't be logged, but the last timestamped line now dates it.
**The 2026-11-02 stop remains unexplained.** This release doesn't fix it; it
makes the next one diagnosable.

The same release added hover tooltips to every dashboard header and label.

## v0.6.4: a release nobody could see

v0.6.3 didn't show up on the dashboard for hours after it was published. This
was the design from devlog 024 working as written: the "⬆ available" badge comes
from a lookup the daemon caches for 6 h. That is sensible for a page polling
every 3 s and pointless when you know you just published something.

v0.6.4 adds a **Check for updates** button that calls the existing uncached
`GET /control/upgrade/check`. Any explicit check, from the button or from
`homefleet upgrade --check`, now also stores its answer behind the badge, so the
badge and **Upgrade all** appear on the next poll. Dashboard failure banners also
now include the daemon's error text, not just the HTTP status.

## The rig check

v0.6.4 reached both nodes in one fleet rollout. The laptop daemon's saved record
reads `{target: "0.6.4", state: "done", peers: [tower 0.6.3 → succeeded], self:
succeeded}`. It started at 21:12:50 UTC, 11 minutes after the Release was
published, and `lastUpgrade` on the laptop reads `0.6.3 → 0.6.4 succeeded` at
21:13:15 UTC, so about 25 s. The trigger was most likely `homefleet fleet upgrade`
from the CLI; the record doesn't say which trigger started a rollout.

Afterwards `homefleet nodes` showed the tower on 0.6.4 with its model `ok`, and
`homefleet upgrade --check` said "Up to date (0.6.4; latest release 0.6.4)."

What this does and doesn't prove:

- **Proven on hardware:** the button works on the real dashboard and shows the
  available release.
- **Not proven on hardware:** the badge refresh. **Upgrade all** was already
  visible when the button was clicked, so the click couldn't show it appearing.
  That path is covered by the integration test (after a check, the next
  `status?dashboard=1` shows `availableUpgrade` with exactly one lookup). The
  next release gets the real proof, if the button is clicked before the regular
  lookup finds it.
- **Not recorded:** the hops to v0.6.2 and v0.6.3. The v0.6.2 notes say it was
  pushed from the dashboard and point here. The daemon only keeps its latest
  rollout, so there is no record left to quote for that push.

## Notes for next time

- All three fixes came from operating the rig, not from the plan. That is the
  case for keeping real hardware in the loop even for a project built to be
  testable on one machine.
- If the laptop daemon stops again, read `homefleetd.log` first. From a Claude
  shell the real data folder is virtualized, so copy the file from a normal
  PowerShell.
- The rollout record doesn't say whether the dashboard or the CLI started it.
  That made this entry harder to write, and it would be a small addition.
- To prove the badge refresh, click **Check for updates** right after publishing,
  before the 6 h lookup comes around.
