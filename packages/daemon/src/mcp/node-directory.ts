/**
 * Node directory: the read model the MCP tools query for "which nodes can I
 * delegate to." It joins the paired set (the trust store) with a source of
 * host/port hints (live discovery candidates and/or the persisted known-nodes
 * registry) and, for reachable endpoints, a best-effort `hello` that fills in
 * live capability info.
 *
 * Invariants:
 * - Only PAIRED devices appear. A paired device with no discovered endpoint is
 *   listed as `reachable: false` (we have no host/port to reach it).
 * - Capabilities are never invented: `nodeInfo` is present only when a `hello`
 *   to the node succeeds. A hello failure (node asleep, wrong identity, refused
 *   connection) yields `reachable: false` with no `nodeInfo` — and never fails
 *   the whole listing (one down node must not hide the others).
 *
 * Everything is injected so the directory is unit-testable without real
 * discovery or a live peer (tests supply a fake source and hello client).
 */
import type { HelloResponse, NodeInfo } from "@homefleet/protocol";
import type { DiscoveryAggregator } from "../discovery/aggregator.js";
import type { KnownNodesRegistry } from "../discovery/known-nodes.js";
import type { HfpTarget } from "../transport/client.js";

/**
 * A short per-node hello timeout: `list_nodes` fans out to every discovered
 * paired node in parallel, so a single asleep machine must not stall the call.
 */
export const DEFAULT_HELLO_TIMEOUT_MS = 2000;

/** A host/port hint for a device, from discovery or the known-nodes file. */
export interface NodeEndpoint {
  host: string;
  port: number;
  /** Human-readable name from the discovery source, when it carried one. */
  name?: string;
}

/** Where the directory gets host/port for a paired device (injectable). */
export interface NodeEndpointSource {
  /** Best-known endpoint for a device, or `undefined` if never discovered. */
  endpointFor(deviceId: string): NodeEndpoint | undefined;
}

/** One entry of the node directory, as the tools surface it. */
export interface NodeDirectoryEntry {
  deviceId: string;
  /** Name from the trust store (the name the user paired under). */
  name: string;
  host?: string;
  port?: number;
  /** True only when a `hello` to the node just succeeded. */
  reachable: boolean;
  /** Live capabilities from `hello`; present only when `reachable`. */
  nodeInfo?: NodeInfo;
}

/** A paired node resolved to a routable endpoint (no `hello` performed). */
export interface ResolvedNode {
  deviceId: string;
  name: string;
  host?: string;
  port?: number;
}

/** A paired device, narrowed to the fields the directory reads. */
interface PairedDevice {
  deviceId: string;
  name: string;
}

/**
 * The trust-store surface the directory reads (paired set). Deliberately
 * structural (not `Pick<TrustStore>`): the directory needs only the device id
 * and name, so a test fake — or any future paired-set source — satisfies it.
 */
interface TrustSource {
  list(): PairedDevice[];
}

/** The hello surface the directory needs (HfpClient satisfies it). */
interface HelloClient {
  hello(target: HfpTarget, ourNodeInfo: NodeInfo): Promise<HelloResponse>;
}

export interface NodeDirectoryOptions {
  trustStore: TrustSource;
  source: NodeEndpointSource;
  hfpClient: HelloClient;
  /** This node's own NodeInfo, sent in the `hello` handshake. */
  ourNodeInfo: () => NodeInfo;
  /** Per-node hello timeout; defaults to {@link DEFAULT_HELLO_TIMEOUT_MS}. */
  helloTimeoutMs?: number;
}

export class NodeDirectory {
  private readonly trustStore: TrustSource;
  private readonly source: NodeEndpointSource;
  private readonly hfpClient: HelloClient;
  private readonly ourNodeInfo: () => NodeInfo;
  private readonly helloTimeoutMs: number;

  constructor(options: NodeDirectoryOptions) {
    this.trustStore = options.trustStore;
    this.source = options.source;
    this.hfpClient = options.hfpClient;
    this.ourNodeInfo = options.ourNodeInfo;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  /**
   * The full directory: one entry per paired device, with live `nodeInfo` for
   * every node that answers `hello`. Hellos run in parallel and failures are
   * swallowed per-node, so the listing always resolves.
   */
  async list(): Promise<NodeDirectoryEntry[]> {
    const paired = this.trustStore.list();
    return Promise.all(
      paired.map(async (device): Promise<NodeDirectoryEntry> => {
        const endpoint = this.source.endpointFor(device.deviceId);
        if (endpoint === undefined) {
          // Paired but never discovered: no way to reach it.
          return {
            deviceId: device.deviceId,
            name: device.name,
            reachable: false,
          };
        }
        const base: NodeDirectoryEntry = {
          deviceId: device.deviceId,
          name: device.name,
          host: endpoint.host,
          port: endpoint.port,
          reachable: false,
        };
        try {
          const { nodeInfo } = await this.hfpClient.hello(
            {
              host: endpoint.host,
              port: endpoint.port,
              expectedDeviceId: device.deviceId,
              timeoutMs: this.helloTimeoutMs,
            },
            this.ourNodeInfo(),
          );
          return { ...base, reachable: true, nodeInfo };
        } catch {
          // Down, asleep, refused, or identity mismatch — not reachable, but
          // the node still appears (with its discovered endpoint) so the user
          // sees it exists. Never rethrow: one bad node can't hide the rest.
          return base;
        }
      }),
    );
  }

  /**
   * Resolves a paired device to its endpoint without a `hello` — for
   * `delegate_task`, whose HFP call itself proves reachability. Returns
   * `undefined` for an unpaired/unknown device; for a paired-but-undiscovered
   * device returns the entry with no `host`/`port` (the tool then reports it
   * as unreachable).
   */
  resolve(deviceId: string): ResolvedNode | undefined {
    const device = this.trustStore.list().find((d) => d.deviceId === deviceId);
    if (device === undefined) {
      return undefined;
    }
    const endpoint = this.source.endpointFor(deviceId);
    if (endpoint === undefined) {
      return { deviceId, name: device.name };
    }
    return {
      deviceId,
      name: device.name,
      host: endpoint.host,
      port: endpoint.port,
    };
  }
}

/**
 * Builds an endpoint source from the discovery layer: live aggregator
 * candidates take priority (freshest host/port), falling back to the persisted
 * known-nodes registry. Either may be omitted (e.g. the stdio shim, which has
 * only the on-disk registry).
 */
export function endpointSourceFromDiscovery(sources: {
  aggregator?: Pick<DiscoveryAggregator, "candidates">;
  knownNodes?: Pick<KnownNodesRegistry, "list">;
}): NodeEndpointSource {
  return {
    endpointFor(deviceId: string): NodeEndpoint | undefined {
      const live = sources.aggregator
        ?.candidates()
        .find((c) => c.deviceId === deviceId);
      if (live !== undefined) {
        return live.name !== undefined
          ? { host: live.host, port: live.port, name: live.name }
          : { host: live.host, port: live.port };
      }
      const known = sources.knownNodes
        ?.list()
        .find((n) => n.deviceId === deviceId);
      if (known !== undefined) {
        return known.name !== undefined
          ? { host: known.host, port: known.port, name: known.name }
          : { host: known.host, port: known.port };
      }
      return undefined;
    },
  };
}
