# Plan: `homefleet daemon start|stop|restart|status`

Spec: `docs/specs/2026-11-05-daemon-lifecycle-command-design.md`.
TDD: test first for each task. Run `pnpm lint`, `pnpm typecheck`, and
`pnpm test` at the end.

1. **Daemon side.**
   - `ControlStatus.pid` (control-server.ts, filled in daemon.ts).
   - `ControlSurface.shutdown?({ force }): ShutdownResult` plus the
     `POST /control/shutdown` route (control header + per-boot token; body
     `{ force? }`; 202 `{ pid, alreadyStopping }`; 409 `unsupported` / `busy`
     / `upgrading`). The decision is the pure `decideShutdown`
     (control/shutdown.ts); daemon.ts supplies the facts and calls
     `requestShutdown` once, after 250 ms, through a shared
     `shutdownRequested` flag the upgrade coordinator also goes through.
   - Tests: control/shutdown.test.ts (every branch), control-server.test.ts
     (token, codes, force, bad body), daemon.shutdown.test.ts (a real daemon:
     a repeat stop requests the shutdown once).
2. **Client.** `ControlClientLike.shutdown({ force })` in control-client.ts.
   A 404 (older daemon) and the 409 codes arrive as `ControlRequestError`
   with `status` / `code`, which `stop` maps to messages.
3. **Real lifecycle deps** in `src/cli/daemon-lifecycle.ts`:
   `launchDetached`, `isPidAlive`, `identifyProcess` (homefleetd / other / gone / unknown, from the command line via
   Win32_Process, /proc or ps), `killPid`, `isPackagedApp` (LOCALAPPDATA
   probe), `taskExists` / `runTask` (schtasks), `tailFile`. Tests with temp
   dirs and real child processes. The packaged probe gets a fake
   `localAppData` tree.
4. **CLI.** `src/cli/daemon-command.ts` (`runDaemon(args, deps)`), wired
   into `dispatch` and USAGE. cli.test.ts-style tests with fakes cover every
   branch in the spec: start (already running / packaged refuse / task path
   / direct ok / early exit / timeout), stop (not running / busy + --force /
   upgrading / 404 / graceful / kill after timeout / reused pid not killed /
   unreadable pid not killed, exit 1),
   restart, status (running / old daemon / not running = exit 3).
5. **Bin wiring** in bin/homefleet.ts.
6. **Integration test:** build the bins into a private dir under
   packages/daemon/node_modules/.cache (the `?raw` imports need the tsup
   build, and third-party deps stay external), then drive the built
   `homefleet.js daemon` against a real homefleetd in a temp data dir with
   fixed free ports. Run `daemon status` (exit 3), `daemon start`, `status`
   (0, pid), `stop`, then `status` (3).
7. **Docs:** README (operate section), docs/backlog.md (mark the first
   bullet shipped), and the configuration reference note on packaged apps.
8. Commit, push, open the PR with rig verification steps for Hugo.
