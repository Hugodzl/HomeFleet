/**
 * The real bonjour-service adapter behind {@link MdnsBackend}. Kept apart
 * from discovery/mdns.ts so that file holds only protocol logic and the
 * backend interface; everything here is a thin, library-facing shim (and the
 * one part of the mDNS channel that unit tests do not execute — the fake
 * backend stands in for it).
 */
import { Bonjour, type ServiceConfig } from "bonjour-service";
import type {
  MdnsBackend,
  MdnsFoundService,
  MdnsPublishRequest,
} from "./mdns.js";

/** The slice of a browsed bonjour-service `Service` this adapter reads. */
export interface BonjourBrowsedService {
  name: string;
  port: number;
  txt?: unknown;
  addresses?: string[];
  /** The mDNS responder the answer came from. */
  referer?: { address: string };
}

/**
 * Maps a browsed bonjour-service result onto {@link MdnsFoundService}:
 * missing `addresses` fall back to the responder's source address (some
 * responders omit A/AAAA records), a missing/non-object `txt` becomes an
 * empty record — downstream zod validation rejects what does not decode.
 */
export function toFoundService(
  type: string,
  service: BonjourBrowsedService,
): MdnsFoundService {
  const addresses =
    service.addresses !== undefined && service.addresses.length > 0
      ? [...service.addresses]
      : service.referer !== undefined
        ? [service.referer.address]
        : [];
  const txt =
    typeof service.txt === "object" && service.txt !== null
      ? (service.txt as Record<string, unknown>)
      : {};
  return { type, name: service.name, port: service.port, txt, addresses };
}

/**
 * Creates the production backend.
 *
 * @param options.bindAddress Interface-selection override (config
 *   `discovery.bindAddress`); passed to bonjour-service's underlying
 *   multicast-dns `interface` option. VPN/virtual adapters grabbing
 *   multicast traffic are the known Windows failure mode.
 * @param options.onError Receives async mDNS socket errors. Discovery is
 *   best-effort — a dead mDNS channel must not crash the daemon (the UDP
 *   fallback and static entries still work) — so errors are reported, not
 *   thrown.
 */
export function createBonjourBackend(
  options: { bindAddress?: string; onError?: (error: unknown) => void } = {},
): MdnsBackend {
  // bonjour-service types its constructor options as Partial<ServiceConfig>,
  // but they are actually forwarded to multicast-dns, whose `interface`
  // option selects the bind interface — hence the cast.
  const multicastDnsOptions =
    options.bindAddress !== undefined
      ? ({
          interface: options.bindAddress,
        } as unknown as Partial<ServiceConfig>)
      : undefined;
  const bonjour = new Bonjour(multicastDnsOptions, (error: unknown) => {
    options.onError?.(error);
  });
  return {
    publish(request: MdnsPublishRequest) {
      const service = bonjour.publish({
        name: request.name,
        type: request.type,
        port: request.port,
        txt: request.txt,
      });
      // Without a listener, a Service 'error' event would crash the process.
      service.on("error", (error: unknown) => {
        options.onError?.(error);
      });
      return {
        stop: () =>
          new Promise<void>((resolve) => {
            service.stop?.(() => resolve());
          }),
      };
    },
    browse(type: string, onUp: (service: MdnsFoundService) => void) {
      const browser = bonjour.find({ type }, (service) => {
        onUp(toFoundService(type, service));
      });
      return { stop: () => browser.stop() };
    },
    destroy: () =>
      new Promise<void>((resolve) => {
        bonjour.destroy(() => resolve());
      }),
  };
}
