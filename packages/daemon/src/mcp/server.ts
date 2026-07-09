/**
 * The HomeFleet MCP server factory. Builds an `McpServer` (SDK v1.29.x) with
 * the five HomeFleet tools registered. Deliberately transport-agnostic: the
 * HTTP front (127.0.0.1) and the stdio shim both build a server this way and
 * connect it to their respective transport, so tool logic is defined once.
 *
 * The server is STATELESS by design (no sessions) and uses neither Sampling,
 * Roots, nor MCP Logging (all deprecated in the 2026-07-28 revision).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DAEMON_VERSION } from "../version.js";
import { type McpToolCollaborators, registerHomeFleetTools } from "./tools.js";

/** Advertised MCP server identity. */
export const MCP_SERVER_NAME = "homefleet";
/** Not an independent version: the MCP-advertised version tracks the daemon's. */
export const MCP_SERVER_VERSION = DAEMON_VERSION;

/**
 * Creates an `McpServer` with the HomeFleet tools registered against the given
 * collaborators. A fresh instance is cheap; the HTTP transport builds one per
 * request (stateless isolation), while the stdio shim builds one for its
 * process lifetime.
 */
export function createMcpServer(
  collaborators: McpToolCollaborators,
): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  registerHomeFleetTools(server, collaborators);
  return server;
}
