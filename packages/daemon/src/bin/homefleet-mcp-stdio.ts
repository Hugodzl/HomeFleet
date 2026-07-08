#!/usr/bin/env node
/**
 * homefleet-mcp-stdio — a thin executable for stdio-only MCP clients.
 *
 * It builds an MCP server with the SAME tool registration the HTTP front uses
 * (via {@link createMcpServer}) and connects it over a {@link
 * StdioServerTransport}. There is no duplicated tool logic.
 *
 * Scope note (M6, narrowed by M9): this shim is still not the full daemon
 * assembly — it constructs a MINIMAL set of collaborators from on-disk state:
 *  - identity, trust store, known-nodes registry, and the daemon config are
 *    loaded from the data dir (real);
 *  - the endpoint source is the persisted known-nodes registry only (no live
 *    discovery aggregator is running in this process);
 *  - `ourNodeInfo` is the REAL config-driven profile (M9's node-info
 *    builder). No JobManager runs in this process, so the delegating-front
 *    defaults apply (`maxConcurrentJobs: 1, activeJobs: 0`).
 *
 * Because a stdio bin cannot be driven by a live agent in CI, its assembly is
 * covered by an in-memory smoke test (see homefleet-mcp-stdio.test.ts). The
 * live "point Claude Code at it" test is the human's to run — see the daemon
 * README.
 */
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDaemonConfig } from "../config/config.js";
import { resolveDataDir } from "../config/paths.js";
import { KnownNodesRegistry } from "../discovery/known-nodes.js";
import { loadOrCreateIdentity } from "../identity/identity.js";
import { DelegationRegistry } from "../mcp/delegation-registry.js";
import {
  endpointSourceFromDiscovery,
  NodeDirectory,
} from "../mcp/node-directory.js";
import { createMcpServer } from "../mcp/server.js";
import { createNodeInfoProvider } from "../node/node-info.js";
import { HfpClient } from "../transport/client.js";
import { TrustStore } from "../trust/trust-store.js";

/**
 * Assembles the MCP server the stdio shim serves, from on-disk daemon state in
 * `dataDir`. Exposed (and returned rather than immediately connected) so the
 * smoke test can drive the exact same assembly over an in-memory transport.
 */
export async function buildStdioMcpServer(dataDir: string): Promise<{
  server: McpServer;
  close(): Promise<void>;
}> {
  const identity = await loadOrCreateIdentity(dataDir);
  // A missing config file yields all defaults (empty executors/models — the
  // shim runs no jobs anyway); an INVALID one throws, refusing to start.
  const [trustStore, knownNodes, config] = await Promise.all([
    TrustStore.load(dataDir),
    KnownNodesRegistry.load(dataDir),
    loadDaemonConfig(dataDir),
  ]);
  const hfpClient = new HfpClient(identity);
  const nodeDirectory = new NodeDirectory({
    trustStore,
    source: endpointSourceFromDiscovery({ knownNodes }),
    hfpClient,
    // The real config-driven profile; no `jobs` source, so the
    // delegating-front defaults (1 slot, 0 active) apply.
    ourNodeInfo: createNodeInfoProvider({
      deviceId: identity.deviceId,
      config,
      daemonVersion: "0.1.0",
    }),
  });
  const server = createMcpServer({
    hfpClient,
    nodeDirectory,
    delegations: new DelegationRegistry(),
  });
  return {
    server,
    // Nothing holds an OS handle here today; kept for a symmetric lifecycle
    // and so M9 can attach real teardown without changing callers.
    async close(): Promise<void> {},
  };
}

async function main(): Promise<void> {
  const { server } = await buildStdioMcpServer(resolveDataDir());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process now lives for the transport's lifetime; the SDK ends it when
  // stdin closes (the client disconnected).
}

// Only run when invoked directly (e.g. via tsx), never when imported by a test.
const invokedPath = process.argv[1] === undefined ? undefined : process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `homefleet-mcp-stdio failed to start: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
