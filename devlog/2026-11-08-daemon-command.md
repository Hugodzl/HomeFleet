# Devlog 026: a command for the daemon, and a review that found what CI didn't

**2026-11-08**

v0.7.0 adds `homefleet daemon start|stop|restart|status`. The feature is small. The
interesting part of this release is how it was checked: green CI, then an
independent review that still found two must-fix bugs, then a release shipped
before any rig test.

Release: [v0.7.0](../docs/releases/v0.7.0.md). PR:
[22](https://github.com/Hugodzl/HomeFleet/pull/22).

## Why a daemon command

Keeping a node running used to take three hand-written PowerShell lines:

- a long `Start-Process node "…\homefleetd.js"` to start it;
- a `Get-CimInstance Win32_Process` query to find which `node.exe` was the daemon;
- `Stop-Process` to stop it. On Windows that is TerminateProcess, so none of the
  daemon's shutdown code ran.

[Devlog 025](2026-11-03-three-small-fixes.md) added a log file so the next
unexplained stop could be read. This release adds the other half: a way to
start and stop the daemon that the log can describe.

- `status` asks the daemon for its own pid through `GET /control/status`, so no
  pid file can go stale across a reboot.
- `start` runs the "HomeFleet Daemon" scheduled task when it is registered.
  That keeps the daemon outside the Claude desktop app's MSIX package, which is
  what killed it in [devlog 023](2026-10-23-first-fleet-push.md).
- `stop` calls a new `POST /control/shutdown`, which needs the per-boot control
  token like the upgrade POSTs. It waits up to 30 s and kills the process only if
  its command line still names `homefleetd`.

## The review

PR 22 was about 2,500 lines. CI passed on Ubuntu and Windows with 1332 tests,
and the author session reported it ready. Because it kills processes and adds a
control route, a separate session that hadn't written it reviewed it with
`/code-review high`. It found nine items, three of which mattered:

- **A second stop forced an exit mid-teardown.** homefleetd treats a second
  shutdown request as "force exit now". A repeated `stop`, or a `stop` during an
  upgrade's own restart, hit that path. Shutdown now has one shared
  `shutdownRequested` flag, and a repeat answers `alreadyStopping`.
- **The "jobs are running" refusal lived only in the CLI.** Anything calling the
  route directly could stop a busy daemon. The daemon now refuses with 409
  `busy`, or 409 `upgrading` during a self upgrade or fleet rollout.
- **The kill fallback could hit a reused pid.** It now checks the process's
  command line first.

The fixes went back to the author session. A re-review of just the fix diff
found three more gaps, and they were fixed too:

- A pid whose command line couldn't be read was reported as stopped, so
  `restart` could start a second daemon.
- A Ctrl+C during the stop's 250 ms delay still reached the forced exit.
- Upgrades weren't refused while the daemon was stopping.

The second re-review came back clean. One more first-round item was a docs fix;
the other five went into the [backlog](../docs/backlog.md#node-lifecycle-automation-daemon--model-server).

None of these were exotic. They were the same request twice, a check and an
action racing, and an id reused, all scenarios nobody had written a test for.
The pattern is now written down twice: a review checklist in
[releasing.md](../docs/reference/releasing.md#reviewing-a-risky-change), and a
rule that risky PRs get an independent review before a merge is offered. The
same session also wrote the
[release flow](../docs/reference/releasing.md#release-flow), so release prep
happens without being asked.

## Released before it was tested

v0.7.0 went out before any rig test. HomeFleet has no pre-release channel:
versions are strict `X.Y.Z` and `homefleet upgrade` follows GitHub's
`releases/latest`. So the only way onto the rig through the normal path is a
real Release. The alternative was to install the packed tarball by hand on the
laptop first. Hugo chose to release. The risk was bounded: `stop` only works
against a v0.7.0 daemon, and `Start-ScheduledTask` stayed a manual way back.

## The rig check

The Release was published at 20:57 UTC on 2026-11-06. The laptop's
`lastUpgrade` reads `0.6.4 → 0.7.0 succeeded` at 20:59:35 UTC, about two
minutes later. By the 2026-11-08 check, `homefleet nodes` showed the tower on
0.7.0 too.

Hugo then ran `status`, `stop`, `start` and `restart` from his own PowerShell on
the laptop and reported that each worked as intended. The output wasn't saved,
so this entry has his report rather than a transcript.

One part could only be checked from a Claude shell. From there,
`homefleet daemon status` printed:

```
homefleetd is running (pid 13884, v0.7.0)
  ...
  autostart:  task "HomeFleet Daemon" registered
Note: this shell runs inside a packaged (MSIX) app, such as the Claude desktop
app. It sees a private copy of %LOCALAPPDATA%, ...
```

So the packaged-app check works on real hardware: a shell inside the app is told
it is inside the app.

What this does and doesn't prove:

- **Proven on hardware:** the upgrade from 0.6.4 on both nodes, the four
  lifecycle commands on the laptop through the scheduled task, and the
  packaged-app note.
- **Not checked:** the commands on the tower, and `stop` refusing with `busy`
  while a job runs.
- **Not recorded:** whether **Check for updates** made the badge appear before
  the upgrade. That proof from devlog 025 is still open.

## Notes for next time

- Paste expected output on its own line, never after the command. Step 2.1 of
  the rig steps first read `homefleet daemon status → running (pid N, …)`.
  PowerShell ran the whole line and failed with "pid is not recognized".
- At the check the tower's model showed `(unreachable)`: llama-server was down
  again. HomeFleet was fine, but the dashboard and `homefleet nodes` are still
  the only place that shows it.
- Save the output of rig checks, or run them through a command that records
  them. A report that it worked is weaker evidence than the lines themselves.
- A pre-release channel (`-rc.N` versions and `homefleet upgrade --pre`) would
  let the next risky release reach one node before it is Latest.
