# @homefleet/daemon

`homefleetd` — the HomeFleet per-machine daemon: device identity, mTLS
transport, LAN discovery, job dispatch, executors, and (M6) the **MCP front
door**.

## MCP front (M6)

The daemon exposes an MCP server so whatever MCP-capable agent you already run
(Claude Code, etc.) becomes the HomeFleet cockpit. The MCP front is the
*delegating* side: its tools use the HFP client to talk to remote worker nodes;
it does not run jobs itself.

Five tools (zod input **and** output schemas; results returned as
`structuredContent`):

| Tool | Purpose |
| --- | --- |
| `list_nodes` | List paired nodes; live capabilities for reachable ones. |
| `delegate_task` | Delegate a `recon` or `command` job to a node → `jobId`. |
| `job_status` | Current status of a delegated job. |
| `job_result` | Full `JobResult` once the job is terminal (else `null`). |
| `cancel_job` | Request cancellation of a delegated job. |

### Transports

- **Streamable HTTP** (`startMcpHttpServer`) bound to **127.0.0.1 only**, in
  stateless mode, with DNS-rebinding protection (Host/Origin allow-list). A
  request whose `Host` points off-localhost or whose `Origin` is a foreign site
  is rejected with `403` before it reaches any tool. This is the security
  boundary that keeps a browser or other origin from driving the daemon.
- **stdio shim** (`src/bin/homefleet-mcp-stdio.ts`) for stdio-only clients. It
  builds a server with the exact same tool registration and connects it over
  `StdioServerTransport`.

### Pointing Claude Code at the stdio shim

There is no build step yet, so the shim runs under `tsx` (a dev dependency).
Add an MCP server to Claude Code (adjust the path to your checkout):

```json
{
  "mcpServers": {
    "homefleet": {
      "command": "npx",
      "args": [
        "tsx",
        "D:\\Git\\LocalAgentCoordinator\\packages\\daemon\\src\\bin\\homefleet-mcp-stdio.ts"
      ],
      "env": {
        "HOMEFLEET_DATA_DIR": "C:\\Users\\<you>\\AppData\\Local\\homefleet"
      }
    }
  }
}
```

Or via the CLI:

```sh
claude mcp add homefleet -- npx tsx packages/daemon/src/bin/homefleet-mcp-stdio.ts
```

Then, in a Claude Code session: `list_nodes` shows your paired machines,
`delegate_task` runs recon/command jobs on them, and `job_status` /
`job_result` poll for completion.

### M6 scope / what is stubbed

The stdio shim assembles a *minimal* set of collaborators from on-disk state
(identity, trust store, known-nodes registry, an HFP client). It does **not**
run live discovery in-process — the endpoint source is the persisted
known-nodes registry only — and `ourNodeInfo` (the capability profile we send
in the `hello` handshake) is a stub with empty roles/executors/models. The full
daemon assembly (live discovery aggregator + real capability profile + a
long-lived HTTP front) lands in **M9**; `buildStdioMcpServer` and
`startMcpHttpServer` are structured so M9 can wire real collaborators without
changing the tools.
