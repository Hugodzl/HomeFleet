/**
 * Daemon configuration: a zod-validated `config.json` in the data dir.
 *
 * A missing file yields all defaults (a fresh install needs no config), but
 * a file that exists and cannot be read or does not validate throws — fail
 * closed, same rationale as the trust store: config governs
 * security-adjacent behavior (which discovery channels run, which interface
 * they bind), and silently substituting defaults could re-enable a channel
 * the user deliberately disabled.
 *
 * v0 shape: discovery only. Later milestones extend this object.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DeviceIdSchema,
  DISCOVERY_MULTICAST_GROUP,
  DISCOVERY_UDP_PORT,
} from "@homefleet/protocol";
import { z } from "zod";

/** A config-provided discovery entry for a node mDNS/UDP cannot see. */
export const StaticNodeSchema = z.object({
  host: z.string().min(1),
  /** The node's HFP HTTPS port. */
  port: z.int().min(1).max(65535),
  /**
   * The device ID expected at `host:port`, when known. Like every discovery
   * datum this is a hint — trust still comes from pairing + the mTLS pin.
   */
  expectedDeviceId: DeviceIdSchema.optional(),
});
export type StaticNode = z.infer<typeof StaticNodeSchema>;

export const DiscoveryConfigSchema = z.object({
  mdnsEnabled: z.boolean().default(true),
  udpEnabled: z.boolean().default(true),
  /**
   * UDP discovery port. `0` binds an ephemeral port (tests, multiple
   * daemons on one machine); note that multicast discovery only works when
   * all nodes listen on the same port, so production stays on the default.
   */
  udpPort: z.int().min(0).max(65535).default(DISCOVERY_UDP_PORT),
  multicastGroup: z.string().min(1).default(DISCOVERY_MULTICAST_GROUP),
  /** How often to re-announce over UDP (it is lossy). */
  announceIntervalMs: z.int().min(1).default(60_000),
  /**
   * Interface-selection override: the local address to bind discovery to.
   * VPN/virtual adapters grabbing multicast traffic are the known Windows
   * failure mode; this applies to the UDP socket bind and is passed to
   * bonjour-service's interface option. Default: all interfaces.
   */
  bindAddress: z.string().min(1).optional(),
  staticNodes: z.array(StaticNodeSchema).default([]),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export const DaemonConfigSchema = z.object({
  // prefault: a config file without a `discovery` key gets the sub-object's
  // field-level defaults applied, same as an empty file.
  discovery: DiscoveryConfigSchema.prefault({}),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

const CONFIG_FILE = "config.json";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Loads `config.json` from `dataDir`. A missing file (ENOENT) yields all
 * defaults; any other read error and any file that does not parse or
 * validate throws.
 */
export async function loadDaemonConfig(dataDir: string): Promise<DaemonConfig> {
  const filePath = path.join(dataDir, CONFIG_FILE);
  let text: string | null = null;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw new Error(
        `Failed to read daemon config ${filePath}; refusing to start with ` +
          "default settings (they may re-enable behavior this file disables).",
        { cause: error },
      );
    }
    // ENOENT: no config file — run on defaults.
  }
  if (text === null) {
    return DaemonConfigSchema.parse({});
  }
  try {
    return DaemonConfigSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw new Error(
      `Invalid daemon config: ${filePath} is not a valid config file. ` +
        "Fix it or remove it to run on defaults.",
      { cause },
    );
  }
}
