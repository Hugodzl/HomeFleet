#!/usr/bin/env node
/**
 * homefleet-mcp-stdio — a thin executable for stdio-only MCP clients.
 *
 * It builds an MCP server with the SAME tool registration the HTTP front uses
 * (via {@link createMcpServer}) and connects it over a {@link
 * StdioServerTransport}. There is no duplicated tool logic.
 *
 * M6 scope note (what is stubbed): there is no full daemon assembly yet — that
 * is M9. So this shim constructs a MINIMAL set of collaborators from on-disk
 * state:
 *  - identity, trust store, and known-nodes registry are loaded from the data
 *    dir (real);
 *  - the endpoint source is the persisted known-nodes registry only (no live
 *    discovery aggregator is running in this process);
 *  - `ourNodeInfo` is a STUB capability profile (empty roles/executors/models)
 *    used solely to identify this node in the `hello` handshake. M9 will supply
 *    the real, daemon-assembled NodeInfo.
 *
 * Because a stdio bin cannot be driven by a live agent in CI, its assembly is
 * covered by an in-memory smoke test (see homefleet-mcp-stdio.test.ts). The
 * live "point Claude Code at it" test is the human's to run — see the daemon
 * README.
 */
import os from "node:os";
import { fileURLToPath } from "node:url";
import { HFP_PROTOCOL_VERSION, type NodeInfo } from "@homefleet/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDataDir } from "../config/paths.js";
import { KnownNodesRegistry } from "../discovery/known-nodes.js";
import { loadOrCreateIdentity } from "../identity/identity.js";
import { DelegationRegistry } from "../mcp/delegation-registry.js";
import {
  endpointSourceFromDiscovery,
  NodeDirectory,
} from "../mcp/node-directory.js";
import { createMcpServer } from "../mcp/server.js";
import { HfpClient } from "../transport/client.js";
import { TrustStore } from "../trust/trust-store.js";

/** Node's platform coerced into the protocol's supported set. */
function currentPlatform(): NodeInfo["platform"] {
  const platform = process.platform;
  return platform === "win32" || platform === "darwin" ? platform : "linux";
}

/**
 * A minimal, valid NodeInfo for the delegating MCP front. STUB: capabilities
 * are empty because the MCP front does not itself run jobs; this identifies us
 * to workers during `hello`. M9 replaces it with the assembled daemon profile.
 */
function stubNodeInfo(deviceId: string): NodeInfo {
  const hostname = os.hostname().slice(0, 64);
  return {
    deviceId,
    name: hostname === "" ? "homefleet" : hostname,
    daemonVersion: "0.1.0",
    protocolVersion: HFP_PROTOCOL_VERSION,
    platform: currentPlatform(),
    roles: [],
    executors: [],
    models: [],
    hardware: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      ramBytes: os.totalmem(),
      gpus: [],
    },
    maxConcurrentJobs: 1,
    activeJobs: 0,
  };
}

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
  const [trustStore, knownNodes] = await Promise.all([
    TrustStore.load(dataDir),
    KnownNodesRegistry.load(dataDir),
  ]);
  const hfpClient = new HfpClient(identity);
  const nodeInfo = stubNodeInfo(identity.deviceId);
  const nodeDirectory = new NodeDirectory({
    trustStore,
    source: endpointSourceFromDiscovery({ knownNodes }),
    hfpClient,
    ourNodeInfo: () => nodeInfo,
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
