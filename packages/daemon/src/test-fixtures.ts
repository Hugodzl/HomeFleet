/**
 * Shared fixtures and helpers for the daemon test suite. Not exported from
 * the package.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HFP_PROTOCOL_VERSION, type NodeInfo } from "@homefleet/protocol";

/** Builds a minimal valid NodeInfo for a device under test. */
export function makeNodeInfo(deviceId: string, name: string): NodeInfo {
  return {
    deviceId,
    name,
    daemonVersion: "0.1.0",
    protocolVersion: HFP_PROTOCOL_VERSION,
    platform: "win32",
    roles: ["execution"],
    executors: ["command"],
    models: [],
    hardware: { cpu: "test-cpu", ramBytes: 0, gpus: [] },
    maxConcurrentJobs: 1,
    activeJobs: 0,
  };
}

/** Creates a fresh temp data dir (HOMEFLEET_DATA_DIR-style, per test). */
export async function makeTempDataDir(
  prefix = "homefleet-test-",
): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temp dir, retrying to ride out transient Windows file locking.
 */
export async function removeTempDataDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
