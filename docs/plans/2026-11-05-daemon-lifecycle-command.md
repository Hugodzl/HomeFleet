# Plan: `homefleet daemon start|stop|restart|status`

Spec: `docs/specs/2026-11-05-daemon-lifecycle-command-design.md`.
TDD: test first for each task. Run `pnpm lint`, `pnpm typecheck`, and
`pnpm test` at the end.

1. **Daemon side.**
   - `ControlStatus.pid` (control-server.ts, filled in daemon.ts).
   - `ControlSurface.shutdown?(): { pid }` plus the `POST /control/shutdown`
     route (control header + per-boot token; 202; 409 when the daemon has no
     shutdown hook). daemon.ts wires it to `requestShutdown` after 250 ms.
   - Tests in control-server.test.ts: token required, 202 with pid, 409
     without the hook.
2. **Client.** `ControlClientLike.shutdown()` in control-client.ts. It maps
   a 404 to a typed `RouteMissingError`, so `stop` can explain that the
   daemon is older.
3. **Real lifecycle deps** in `src/cli/daemon-lifecycle.ts`:
   `spawnDetachedDaemon`, `isPidAlive`, `killPid`, `isPackagedApp`
   (LOCALAPPDATA probe), `queryTask` / `runTask` (schtasks), `tailFile`.
   Tests with temp dirs. The packaged probe gets a fake `localAppData` tree.
4. **CLI.** `src/cli/daemon-command.ts` (`runDaemon(args, deps)`), wired
   into `dispatch` and USAGE. cli.test.ts-style tests with fakes cover every
   branch in the spec: start (already running / packaged refuse / task path
   / direct ok / early exit / timeout), stop (not running / active jobs /
   404 / graceful / force-kill after timeout), restart, status (running /
   old daemon / not running = exit 3).
5. **Bin wiring** in bin/homefleet.ts.
6. **Integration test:** a real homefleetd from source in a temp data dir
   with fixed free ports. Run `daemon status` (exit 3), `daemon start`,
   `status` (0, pid), `stop`, then `status` (3).
7. **Docs:** README (operate section), docs/backlog.md (mark the first
   bullet shipped), and the configuration reference note on packaged apps.
8. Commit, push, open the PR with rig verification steps for Hugo.
