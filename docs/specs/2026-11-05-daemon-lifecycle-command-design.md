# `homefleet daemon start|stop|restart|status` — design

**Status:** implemented (2026-11-05, PR #22; review fixes 2026-11-06). First slice of the backlog item "Node
lifecycle automation (daemon + model server)" (`docs/backlog.md`).

## Why

Keeping a node running is still hand work. Starting the installed daemon
detached is a long `Start-Process node "<npm root -g>\homefleet\dist\bin\homefleetd.js"`
line, finding the live process is a `Get-CimInstance` query, and the rig's
`hf-daemon.ps1` (which does both) is not shipped. Stopping a daemon on
Windows from a shell is worse: `Stop-Process` / `process.kill` is
`TerminateProcess`, so the daemon's graceful shutdown never runs. Every
release since v0.6.2 came out of operating the rig by hand.

## Goals

- One shipped command, `homefleet daemon <start|stop|restart|status>`, that
  works from the installed bin with no extra scripts.
- `start` launches the daemon detached and waits until it answers.
- `stop` shuts the daemon down **gracefully** and waits until the process is
  gone.
- `status` reports whether a daemon is live for this data directory, its pid,
  version and ports, and where its logs are.
- Everything testable on one machine with temp data dirs and test daemons.

## Non-goals (later slices of the same backlog item)

- Registering or verifying the at-logon task (`setup --apply`).
- Supervising llama-server or any model server.
- Restarting a peer remotely.
- A Windows service.

## Anti-goals

- Never kill a process that is not, demonstrably, this data dir's daemon.
- Never launch a daemon inside an MSIX package without saying so: it would
  write to a private `%LOCALAPPDATA%` copy (a fresh identity, no pairings)
  and die with the app.

## Design

### Finding the live process (`status`)

No pid file. A pid file goes stale across reboots and the pid can be reused,
so it can never be the basis for a kill.

The source of truth is the daemon itself: `GET /control/status` gains a `pid`
field (the daemon's `process.pid`). A daemon that answers on the configured
control host/port is running, and it states its own pid. A daemon that
doesn't answer is reported as not running. That is also correct when it is
hung, since a hung daemon can't be operated either.

A daemon older than this change answers without a `pid`. `status` then
reports it as running with "pid unknown (daemon predates `homefleet daemon`)".

Port collision (a daemon for *another* data dir on the same control port)
can't be told apart by `status`. `stop` is safe anyway, because the shutdown
route requires this data dir's per-boot control token.

`status` output: `running (pid N, vX)` or `not running`, then the control
URL (only the control port; HFP and MCP ports are in `homefleet status`),
the data dir, the `homefleetd.log` / `homefleetd.err.log` paths, the last
log line when not running, and on Windows whether the `HomeFleet Daemon`
task is registered, plus a note when the shell runs inside a packaged app. Exit 0 when
running, 3 when not (the LSB convention for "not running"), so scripts can
branch on it.

### Graceful stop (`stop`)

New route `POST /control/shutdown`, body `{ force? }`. It requires the
control header and the per-boot token, like the upgrade POSTs. The daemon
decides (`decideShutdown`, in order):

1. `409 unsupported`: not started by `homefleetd` (embedders, tests).
2. `409 upgrading`: a self upgrade is starting or has handed off to the
   updater, or a fleet rollout is running. The upgrade restarts the daemon
   itself, and a stop would race the updater's relaunch.
3. Already stopping: `202 { pid, alreadyStopping: true }`, and nothing is
   requested again. homefleetd treats a *second* shutdown request as "force
   exit now", which would cut teardown short. "Stopping" means the shared
   `shutdownRequested` flag (set by a stop or an upgrade) or the daemon's
   own `stopped` state. `stop()` sets that state synchronously, which covers
   SIGINT/SIGTERM: they reach homefleetd's shutdown directly. The stop's
   delayed request checks the state again before it fires. While stopping,
   the upgrade coordinator refuses new upgrades (local or pushed) as
   `locked`.
4. `409 busy`: jobs are running and `force` is not set. The daemon enforces
   this, like `checkUpgradeGuards`, so a CLI-side status read can't race it.
5. Otherwise `202 { pid, alreadyStopping: false }`, then the same
   `requestShutdown` that SIGINT uses, after 250 ms so the reply goes out
   first.

`stop`:

1. If the daemon doesn't answer, print `not running`, exit 0 (idempotent).
2. POST `/control/shutdown` with `force` from `--force`. The CLI explains
   `busy` and `upgrading`. A 404 means an older daemon: print a hint
   (`homefleet upgrade` restarts it into a version that has the route, or
   stop it by hand once) and exit 1.
3. Wait up to 30 s for the reported pid to exit.
4. If the pid is still alive, it may no longer be the daemon: the daemon
   could have exited near the deadline and the OS reused the number. So
   before killing, `stop` reads the process's command line (Win32_Process on
   Windows, `/proc` on Linux, `ps` elsewhere) and acts on one of four
   answers:
   - `homefleetd`: kill it, wait 5 s, and report.
   - `other` (a different program has the number): the daemon is gone.
     Report it stopped, kill nothing, exit 0.
   - `gone`: the process exited during the check. Report it stopped.
   - `unknown` (alive, but the command line can't be read: the lookup was
     blocked or timed out, or the daemon runs elevated and the shell
     doesn't): kill nothing and exit 1, telling the user to end pid N
     themselves. `restart` then doesn't start a second daemon.

### Detached launch (`start`)

1. If a daemon already answers, print `already running (pid N)`, exit 0.
2. **Packaged-app check (Windows only).** Write a uniquely named probe file
   to `%LOCALAPPDATA%`, then look for it under
   `%LOCALAPPDATA%\Packages\*\LocalCache\Local\`. If it shows up there, this
   process runs inside an MSIX package with virtualized AppData. (Verified
   2026-11-05 from a Claude desktop shell: the probe appeared under
   `Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\`.) The probe is always
   removed. Any error counts as "not packaged" (fail open: the check is a
   warning device, not a security boundary).
3. **Launch path.**
   - **Task path:** on Windows, when the `HomeFleet Daemon` task exists
     (`schtasks /Query /TN`) **and** the data dir is the default one
     (`HOMEFLEET_DATA_DIR` unset; the task passes no environment), run
     `schtasks /Run /TN "HomeFleet Daemon"`. The node then runs exactly what
     autostart runs, and Task Scheduler's "Running" state stays true. The
     process is created by the Task Scheduler service, so it is *outside*
     any MSIX package even when `start` runs inside one.
   - **Direct path** otherwise: `spawn(process.execPath, [<homefleetd.js>],
     { detached, windowsHide, stdio: [ignore, ignore, homefleetd.err.log] })`
     with the CLI's environment, so `HOMEFLEET_DATA_DIR` carries through.
     This is the same launch `updater.mjs` does.
   - **Packaged and no usable task:** refuse (exit 1). Explain why (the
     v0.5.3 pitfall) and print the `schtasks /Create` line `setup` prints,
     plus "or run this from your own terminal". `--allow-packaged` overrides,
     for someone who knows what they're doing.
4. Wait up to 30 s for `/control/status` to answer. On the direct path, the
   answer must carry the child's pid. If the child exits first, or the wait
   times out, exit 1 and print the last 10 lines of `homefleetd.log` (and of
   `homefleetd.err.log` if it isn't empty).

### `restart`

`stop` (passing `--force` through), then `start`. If the stop fails, the
start never runs.

### Logs

Nothing new. The daemon already writes a timestamped `homefleetd.log` itself,
however it was launched. The direct path redirects stderr to
`homefleetd.err.log` (same file the updater uses) to catch output from before
the daemon's code runs.

## Testability

`runCli` stays a function of `(argv, deps)`. The lifecycle side effects are
new optional `CliDeps` fields under `lifecycle` (spawn detached, pid alive,
kill, packaged probe, task query/run, log tail), so `cli.test.ts` drives
every branch with fakes. The real implementations live in
`src/cli/daemon-lifecycle.ts`, with their own tests against real temp dirs.
One integration test starts a real `homefleetd` from source (temp data dir,
loopback ports, discovery off) through the real deps, then checks `status`,
`stop` and `status` again.

The real laptop daemon is never touched from a Claude shell. Rig
verification is Hugo's step (see the PR).

## Calls made by the builder (not discussed with Hugo)

- Exit code 3 for "not running" in `status`.
- The task path is taken automatically when it applies. There is no
  `--direct` flag yet.
- `stop` refuses with active jobs unless `--force`, enforced by the daemon.
- `--allow-packaged` escape hatch.
- No pid file at all (rather than a pid file that is cross-checked).
