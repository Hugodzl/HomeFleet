/**
 * Shared fixtures and helpers for the daemon test suite. Not exported from
 * the package.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HFP_PROTOCOL_VERSION, type NodeInfo } from "@homefleet/protocol";
import type {
  MdnsBackend,
  MdnsFoundService,
  MdnsPublishRequest,
} from "./discovery/mdns.js";

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

export interface FakePublication {
  request: MdnsPublishRequest;
  stopped: boolean;
  stop(): Promise<void>;
}

export interface FakeBrowser {
  type: string;
  onUp: (service: MdnsFoundService) => void;
  stopped: boolean;
  stop(): void;
}

/**
 * The one sanctioned fake: stands in for bonjour-service, which cannot be
 * exercised deterministically in CI. Publications are delivered to browsers
 * (existing and late-registered) like an mDNS cache would; the TXT
 * encode/decode under test is the real code in discovery/mdns.ts.
 */
export class FakeMdnsBackend implements MdnsBackend {
  publications: FakePublication[] = [];
  browsers: FakeBrowser[] = [];
  destroyed = false;
  /** Addresses attached to delivered services. */
  addresses: string[] = ["192.168.1.20"];
  /**
   * Opt-in probe-death modeling: a publication matching this predicate is
   * never delivered to any browser — like a bonjour-service publication
   * that silently lost its probe race (no announce, no error event).
   * Defaults to delivering everything.
   */
  suppressDelivery: (request: MdnsPublishRequest) => boolean = () => false;

  publish(request: MdnsPublishRequest): FakePublication {
    const publication: FakePublication = {
      request,
      stopped: false,
      stop: async () => {
        publication.stopped = true;
      },
    };
    this.publications.push(publication);
    for (const browser of this.browsers) {
      this.deliverTo(browser, publication);
    }
    return publication;
  }

  browse(type: string, onUp: (service: MdnsFoundService) => void): FakeBrowser {
    const browser: FakeBrowser = {
      type,
      onUp,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    this.browsers.push(browser);
    for (const publication of this.publications) {
      this.deliverTo(browser, publication);
    }
    return browser;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  /** Delivers an arbitrary service to every live browser. */
  deliver(service: MdnsFoundService): void {
    for (const browser of this.browsers) {
      if (!browser.stopped && browser.type === service.type) {
        browser.onUp(service);
      }
    }
  }

  activePublications(): FakePublication[] {
    return this.publications.filter((publication) => !publication.stopped);
  }

  private deliverTo(browser: FakeBrowser, publication: FakePublication): void {
    if (browser.stopped || publication.stopped) {
      return;
    }
    if (this.suppressDelivery(publication.request)) {
      return;
    }
    if (browser.type !== publication.request.type) {
      return;
    }
    browser.onUp({
      type: publication.request.type,
      name: publication.request.name,
      port: publication.request.port,
      txt: { ...publication.request.txt },
      addresses: [...this.addresses],
    });
  }
}
