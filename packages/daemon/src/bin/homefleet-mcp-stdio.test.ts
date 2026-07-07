/**
 * Stdio shim smoke test. A live agent cannot exercise a stdio bin in CI, so we
 * drive the SHIM'S assembled server (built exactly as the bin builds it, from a
 * temp data dir) through a real MCP `Client` over an in-memory linked
 * transport. This proves the shim's collaborator assembly + the shared tool
 * registration work end-to-end.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { buildStdioMcpServer } from "./homefleet-mcp-stdio.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

test("the stdio shim server registers all five tools and answers list_nodes", async () => {
  const dataDir = await makeTempDataDir("homefleet-stdio-");
  const { server, close } = await buildStdioMcpServer(dataDir);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stdio-smoke", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await close();
    await removeTempDataDir(dataDir);
  });

  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual([
    "cancel_job",
    "delegate_task",
    "job_result",
    "job_status",
    "list_nodes",
  ]);

  // Fresh data dir -> empty trust store -> no paired nodes.
  const result = await client.callTool({ name: "list_nodes", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ nodes: [] });
});
