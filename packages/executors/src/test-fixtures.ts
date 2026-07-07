/**
 * Shared fixtures for the executors test suite. Unlike the protocol/daemon
 * fixtures this file IS exported from the package: the daemon's M5 job
 * manager tests drive the agent executor through the mock endpoint too.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Creates a fresh temp directory (stands in for a materialized workspace). */
export async function makeTempDir(
  prefix = "homefleet-executors-test-",
): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temp dir, retrying to ride out transient Windows file locking.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
