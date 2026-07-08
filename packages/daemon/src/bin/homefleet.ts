#!/usr/bin/env node
/**
 * homefleet — the operator's command-line tool. A thin wrapper: resolves the
 * data dir, loads config, wires up the real collaborators (a real
 * `ControlClient` against the loaded control host/port, real
 * `loadOrCreateIdentity`), and hands off to `runCli` for everything else.
 *
 * All the actual logic — argument parsing, subcommand dispatch, output
 * formatting — lives in `../cli/cli.ts`, which is fully unit-tested against
 * fakes. This file exists only to supply the real, un-fakeable pieces
 * (process.argv, real fs via the config/identity loaders, a real network
 * client) and to translate `runCli`'s returned exit code into an actual
 * process exit — mirroring the invoked-directly guard + stderr-output house
 * pattern used by homefleetd.ts / homefleet-mcp-stdio.ts.
 */
import { fileURLToPath } from "node:url";
import { type CliDeps, runCli } from "../cli/cli.js";
import { ControlClient } from "../cli/control-client.js";
import { loadDaemonConfig } from "../config/config.js";
import { resolveDataDir } from "../config/paths.js";
import { loadOrCreateIdentity } from "../identity/identity.js";

async function main(): Promise<number> {
  const dataDir = resolveDataDir();
  const deps: CliDeps = {
    dataDir,
    loadConfig: loadDaemonConfig,
    ensureIdentity: loadOrCreateIdentity,
    makeControlClient: (options) => new ControlClient(options),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
  return runCli(process.argv.slice(2), deps);
}

// Only run when invoked directly (e.g. via tsx), never when imported by a test.
const invokedPath = process.argv[1] === undefined ? undefined : process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      // `runCli` itself never throws (it catches internally and returns a
      // nonzero code) — reaching this means something failed OUTSIDE runCli
      // (e.g. resolveDataDir). Same never-leak-a-stack posture as elsewhere.
      process.stderr.write(
        `homefleet failed to start: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    },
  );
}
