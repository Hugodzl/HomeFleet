#!/usr/bin/env node
/**
 * homefleetd — the HomeFleet daemon executable. Resolves the data dir, loads
 * (and validates) the config, assembles the {@link Daemon}, and runs until
 * SIGINT/SIGTERM.
 *
 * All operator output goes to STDERR — stdout stays clean so the bin composes
 * with pipelines and supervisors that capture it — with one exception:
 * `--version` prints its version line to stdout and exits without starting
 * the daemon.
 */
import { loadDaemonConfig } from "../config/config.js";
import { resolveDataDir } from "../config/paths.js";
import { Daemon } from "../daemon.js";
import { DAEMON_VERSION } from "../version.js";
import { isInvokedDirectly } from "./invoked-directly.js";
import { asciiPunctuation } from "./log-line.js";

/**
 * Writes one line to stderr, passed through {@link asciiPunctuation} first —
 * see log-line.ts for why. This is the ONE place homefleetd writes to stderr
 * so every operator-facing line (the started line, onError, onDiagnostic, the
 * shutdown messages, the startup-failure handler) gets the same treatment.
 */
function writeStderrLine(line: string): void {
  process.stderr.write(`${asciiPunctuation(line)}\n`);
}

/**
 * `--version`'s exact stdout line, if `argv` requests it — `undefined`
 * otherwise (the normal case, where the daemon starts as usual). Checked as
 * the very first thing at startup, before `resolveDataDir`/`loadDaemonConfig`/
 * `Daemon` assembly, so it never depends on a data dir or config existing and
 * never starts the daemon. Exported (rather than inlined in the
 * invoked-directly guard below) so homefleetd.test.ts can verify the string
 * without spawning the built bin.
 */
export function versionOutput(argv: string[]): string | undefined {
  return argv.includes("--version")
    ? `homefleetd ${DAEMON_VERSION}`
    : undefined;
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const config = await loadDaemonConfig(dataDir);
  const daemon = new Daemon({
    dataDir,
    config,
    onError: (error) => {
      writeStderrLine(
        `homefleetd background error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
    // Informational component diagnostics (e.g. the WorkspaceStore's
    // legacy-cache-layout warning) — operator-facing, so they go to stderr
    // like every other line this bin emits.
    onDiagnostic: (message) => {
      writeStderrLine(`homefleetd: ${message}`);
    },
  });
  await daemon.start();

  const info = daemon.nodeInfo();
  writeStderrLine(
    `homefleetd started: "${info.name}" (${daemon.deviceId.slice(0, 12)}…) ` +
      `hfp ${config.hfp.host}:${daemon.hfpPort} ` +
      `mcp http://${config.mcp.host}:${daemon.mcpPort}/mcp ` +
      `control http://${config.control.host}:${daemon.controlPort} ` +
      `data ${dataDir}`,
  );

  // Graceful shutdown: the first signal stops once and exits 0; a second
  // signal while teardown is still running force-exits 1 (the operator's
  // escape hatch from a hung stop).
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      writeStderrLine("homefleetd: forced exit");
      process.exit(1);
    }
    stopping = true;
    writeStderrLine(`homefleetd: ${signal} received, shutting down`);
    daemon.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        writeStderrLine(
          `homefleetd: shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only run when invoked directly (bare node, tsx, or an npm -g symlink/shim),
// never when imported by a test.
if (isInvokedDirectly(import.meta.url, process.argv[1])) {
  const version = versionOutput(process.argv.slice(2));
  if (version !== undefined) {
    process.stdout.write(`${version}\n`);
  } else {
    main().catch((error: unknown) => {
      writeStderrLine(
        `homefleetd failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    });
  }
}
