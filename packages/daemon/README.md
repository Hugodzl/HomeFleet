# @homefleet/daemon

`homefleetd` — the HomeFleet per-machine daemon: device identity, mTLS
transport, LAN discovery, job dispatch, executors, workspace sync, and the MCP
front door — assembled into one runnable process (`src/daemon.ts`), plus the
`homefleet` operator CLI and a loopback control API it talks to.

See the root README's [Quickstart](../../README.md#quickstart) for the
end-to-end "clone to running daemon" path and the
[Two-machine demo](../../README.md#two-machine-demo) for pairing two real
machines. This document covers the daemon package specifically: its bins, the
MCP front's transports, and the CLI's subcommands.

## Bins

Three executables, built from `src/bin/*.ts` by `tsup` into `dist/bin/*.js`
(`pnpm build` at the repo root, or `pnpm --filter @homefleet/daemon build`
here). They're plain, bare-`node`-runnable ESM files — no `tsx` needed at run
time — with first-party `@homefleet/*` code bundled in and third-party
dependencies + Node builtins left external, resolved from `node_modules`
(run this installed, not copied out standalone).

| Bin | Built entry | Purpose |
| --- | --- | --- |
| `homefleetd` | `dist/bin/homefleetd.js` | The daemon itself. |
| `homefleet` | `dist/bin/homefleet.js` | The operator CLI (below). |
| `homefleet-mcp-stdio` | `dist/bin/homefleet-mcp-stdio.js` | The stdio MCP shim (below). |

Installed from a [release tarball](../../README.md#install), the three bins are
on PATH directly (npm generates the Windows `.cmd`/`.ps1` shims and Linux
symlinks). The release manifest is generated from this package.json by
`scripts/lib/publish-manifest.ts` — workspace deps are dropped because tsup
bundles them.

After building, invoke them directly via `node` — this always works, needs no
linking step, and has no side effects on this or any other project:

```sh
node packages/daemon/dist/bin/homefleetd.js
node packages/daemon/dist/bin/homefleet.js status
```

If you'd rather have bare `homefleetd`/`homefleet`/`homefleet-mcp-stdio`
commands, `pnpm link --global <absolute path to packages/daemon>` can
register them (it needs `pnpm setup` run once, so pnpm's global bin directory
is on `PATH`). Verified caveat: on the pnpm version this repo pins
(`pnpm@11.10.0`), that command also adds a `link:` dependency entry to
whichever directory's `package.json` is nearest to wherever you run it from —
including this repo's own root `package.json`/`pnpm-workspace.yaml` if you run
it inside the repo. Run it from a directory outside any project you care
about, or just use the `node ...` form above; the rest of this document and
the root README's Quickstart use `node ...` throughout for that reason.

## MCP front

The daemon exposes an MCP server so whatever MCP-capable agent you already run
(Claude Code, etc.) becomes the HomeFleet cockpit. The MCP front is the
*delegating* side: its tools use the HFP client to talk to remote worker
nodes; it does not run jobs itself.

Five tools (zod input **and** output schemas; results returned as
`structuredContent`):

| Tool | Purpose |
| --- | --- |
| `list_nodes` | List paired nodes; live capabilities for reachable ones. |
| `delegate_task` | Delegate a `recon` or `command` job to a node → `jobId`. Syncs the named repo to the worker first. |
| `job_status` | Current status of a delegated job. |
| `job_result` | Full `JobResult` once the job is terminal (else `null`). |
| `cancel_job` | Request cancellation of a delegated job. |

### Transports

- **Streamable HTTP** (`startMcpHttpServer`) bound to **127.0.0.1 only** (see
  `mcp.host`/`mcp.port` in the
  [configuration reference](../../docs/reference/configuration.md#mcp),
  default port `56372`), in stateless mode, with DNS-rebinding protection
  (Host/Origin allow-list). A request whose `Host` points off-localhost or
  whose `Origin` is a foreign site is rejected with `403` before it reaches
  any tool. This is the security boundary that keeps a browser or other
  origin from driving the daemon.
- **stdio shim** (`src/bin/homefleet-mcp-stdio.ts`, built to
  `dist/bin/homefleet-mcp-stdio.js`) for stdio-only clients. It builds a
  server with the exact same tool registration and connects it over
  `StdioServerTransport`.

### Pointing Claude Code at the daemon

Once `homefleetd` is running (see the root README's Quickstart), point Claude
Code at the **Streamable HTTP** endpoint — no extra process, no data-dir env
var to set (the daemon already resolved it):

```sh
claude mcp add --transport http homefleet http://127.0.0.1:56372/mcp
```

or, as a manual `.mcp.json` entry:

```json
{
  "mcpServers": {
    "homefleet": {
      "type": "http",
      "url": "http://127.0.0.1:56372/mcp"
    }
  }
}
```

If your MCP client only speaks stdio, use the shim instead (after `pnpm
build`; adjust the path and `HOMEFLEET_DATA_DIR` to your checkout/OS):

```sh
claude mcp add --env HOMEFLEET_DATA_DIR=C:\Users\<you>\AppData\Local\homefleet --transport stdio homefleet -- node D:\Git\HomeFleet\packages\daemon\dist\bin\homefleet-mcp-stdio.js
```

or as `.mcp.json`:

```json
{
  "mcpServers": {
    "homefleet": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\Git\\HomeFleet\\packages\\daemon\\dist\\bin\\homefleet-mcp-stdio.js"],
      "env": {
        "HOMEFLEET_DATA_DIR": "C:\\Users\\<you>\\AppData\\Local\\homefleet"
      }
    }
  }
}
```

The stdio shim is a narrower assembly than the full daemon (see below), so
prefer the HTTP form when `homefleetd` is already running — which it needs to
be anyway for the LAN side (discovery, pairing, HFP) to work.

Then, in a Claude Code session: `list_nodes` shows your paired machines,
`delegate_task` runs recon/command jobs on them, and `job_status` /
`job_result` poll for completion.

### Stdio shim scope

The stdio shim assembles a *minimal* set of collaborators from on-disk state
(identity, trust store, known-nodes registry, config, an HFP client) rather
than reusing the full `Daemon` assembly. Two differences from a running
`homefleetd`:

- It does **not** run live discovery in-process — the endpoint source for
  `list_nodes`/`delegate_task` is the persisted known-nodes registry only,
  not a live mDNS/UDP aggregator.
- No `JobManager` runs in this process, so the delegating-front defaults
  apply for its own advertised profile (`maxConcurrentJobs: 1, activeJobs:
  0`) — irrelevant to delegating, since this process never executes jobs
  itself.

Everything else (tool registration, repo resolution, workspace sync on
delegate) is identical to the HTTP front — `buildStdioMcpServer` and
`startMcpHttpServer` share the same `createMcpServer` call, so there is no
duplicated tool logic.

## The `homefleet` CLI

```
homefleet setup
    Scaffold this machine: print this node's identity, the firewall/
    autostart commands to run (in an elevated PowerShell), and a
    network-profile check. Does not require the daemon to be running.

homefleet pair begin
    Open a pairing window on THIS node's running daemon and print the code.

homefleet pair connect <host> <port> <code> [--expect <deviceId>]
    Pair THIS node's running daemon with a peer at <host>:<port> using the
    code shown by that peer's "pair begin". --expect pins the expected
    peer device ID.

homefleet nodes
    List this node's paired peers (from the running daemon).

homefleet unpair <name|deviceId> [--yes]
    Revoke THIS node's trust in a paired peer, on the running daemon: the
    peer's requests are refused from now on and its jobs here are
    canceled. <deviceId> may be a unique prefix (8+ hex chars). Without
    --yes, prints what it would unpair and changes nothing. One-sided:
    run it on the peer too to end trust both ways.

homefleet status
    Show this node's live status (from the running daemon).

homefleet dashboard [--no-open]
    Print the running daemon's read-only dashboard URL and open it in
    the default browser (--no-open: print only).

homefleet upgrade [--to <version>] [--check] [--force]
    Upgrade THIS node's running daemon to the latest signed release (or
    --to <version>), restart it in the background, and wait until it is
    back. Rolls back automatically if the new version fails to start.
    --check only reports whether an upgrade is available; --force
    upgrades even while jobs are running.

homefleet fleet upgrade [--to <version>] [--nodes <name|id>...] [--force-local]
    Roll the latest signed release (or --to <version>) out across the
    fleet: paired peers one at a time, THIS node last, stopping at the
    first failure. --nodes limits it to the named peers (names or id
    prefixes); --force-local upgrades this node even while jobs run.
    Peers must have "upgrade.allowRemote" enabled.

homefleet daemon start [--allow-packaged]
    Start THIS data dir's daemon in the background and wait until it
    answers. On Windows it runs the "HomeFleet Daemon" autostart task when
    one is registered (and HOMEFLEET_DATA_DIR is unset); otherwise it
    launches homefleetd detached. Refuses inside a packaged (MSIX) app
    such as the Claude desktop app unless --allow-packaged.

homefleet daemon stop [--force]
    Shut the running daemon down gracefully and wait until it has exited.
    Refuses while jobs are running unless --force.

homefleet daemon restart [--force] [--allow-packaged]
    stop, then start.

homefleet daemon status
    Whether a daemon answers for this data dir, its pid and version, and
    where its logs are. Exit code 3 when it is not running.

homefleet --help
    Show this usage text.

homefleet --version
    Print the CLI version and exit.
```

`setup` only prints commands and reads local config/identity — no daemon
needed. Every other command talks to the **running daemon's control API**
(below), because pairing state, live status, node data, jobs and upgrades only
exist in that running process. `daemon start` is the exception that launches
one: it starts the daemon, then polls the control API until it answers.

This block is the CLI's own `--help` text. `pnpm check:docs` (and `pnpm test`)
fails when the two drift, so a new command has to land here too.

## Control API

The CLI reaches the daemon over a small loopback-only HTTP API
(`control.host`/`control.port`, default `127.0.0.1:56373` — see
[ADR-0006](../../docs/adr/0006-daemon-assembly-and-control-channel.md) for why
this is a separate channel from MCP and HFP). It is not meant to be called
directly; the CLI is its only intended client, and every request must carry
the `x-homefleet-control: 1` header (CSRF defense — see `src/control/control-server.ts`).
