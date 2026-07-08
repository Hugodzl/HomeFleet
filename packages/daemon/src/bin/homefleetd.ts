#!/usr/bin/env node
/**
 * homefleetd — the HomeFleet daemon executable. Resolves the data dir, loads
 * (and validates) the config, assembles the {@link Daemon}, and runs until
 * SIGINT/SIGTERM.
 *
 * All operator output goes to STDERR: stdout stays clean so the bin composes
 * with pipelines and supervisors that capture it.
 */
import { fileURLToPath } from "node:url";
import { loadDaemonConfig } from "../config/config.js";
import { resolveDataDir } from "../config/paths.js";
import { Daemon } from "../daemon.js";

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const config = await loadDaemonConfig(dataDir);
  const daemon = new Daemon({
    dataDir,
    config,
    onError: (error) => {
      process.stderr.write(
        `homefleetd background error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    },
  });
  await daemon.start();

  const info = daemon.nodeInfo();
  process.stderr.write(
    `homefleetd started: "${info.name}" (${daemon.deviceId.slice(0, 12)}…) ` +
      `hfp ${config.hfp.host}:${daemon.hfpPort} ` +
      `mcp http://${config.mcp.host}:${daemon.mcpPort}/mcp ` +
      `data ${dataDir}\n`,
  );

  // Graceful shutdown: the first signal stops once and exits 0; a second
  // signal while teardown is still running force-exits 1 (the operator's
  // escape hatch from a hung stop).
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      process.stderr.write("homefleetd: forced exit\n");
      process.exit(1);
    }
    stopping = true;
    process.stderr.write(`homefleetd: ${signal} received, shutting down\n`);
    daemon.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(
          `homefleetd: shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only run when invoked directly (e.g. via tsx), never when imported by a test.
const invokedPath = process.argv[1] === undefined ? undefined : process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `homefleetd failed to start: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
