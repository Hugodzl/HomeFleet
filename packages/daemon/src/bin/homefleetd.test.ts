/**
 * homefleetd is a bin with no dispatch layer (unlike homefleet/cli.ts) — its
 * `main()` unconditionally resolves the data dir, loads config, and starts the
 * real {@link Daemon}, so it can't be driven end-to-end without a live agent.
 * `versionOutput` is the one piece of argv-handling pulled out into a pure,
 * exported function precisely so `--version` can be verified here without
 * spawning the built bin or starting a daemon (mirrors how
 * homefleet-mcp-stdio.test.ts exercises `buildStdioMcpServer` in isolation).
 */
import { expect, test } from "vitest";
import { DAEMON_VERSION } from "../version.js";
import { versionOutput } from "./homefleetd.js";

test("--version yields 'homefleetd <DAEMON_VERSION>'", () => {
  expect(versionOutput(["--version"])).toBe(`homefleetd ${DAEMON_VERSION}`);
});

test("normal argv (no --version) yields undefined, so the daemon starts as usual", () => {
  expect(versionOutput([])).toBeUndefined();
  expect(versionOutput(["--some-other-flag"])).toBeUndefined();
});
