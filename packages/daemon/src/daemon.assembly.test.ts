/**
 * Daemon assembly seams that the integration suite cannot reach: the mDNS
 * rename diagnostics ride DiscoveryAggregatorOptions.onDiagnostic, but the
 * real daemon's mDNS channel is the live bonjour backend — deliberately
 * disabled in tests (see daemon.integration.test.ts) because real multicast
 * is non-deterministic in CI. So instead of driving a rename end to end,
 * this pins the wiring line itself: the aggregator must be constructed with
 * the daemon's own onDiagnostic sink. The v0.1 legacy-cache seam bug (commit
 * 60a916e) was exactly a diagnostic emitted into a dropped sink, and the
 * WorkspaceStore leg of this sink is covered end to end by the integration
 * suite; this covers the discovery leg.
 *
 * The mock wraps (not replaces) the real DiscoveryAggregator, recording
 * constructor options — every other test in this FILE-scoped mock still runs
 * the real aggregator. Kept separate from daemon.integration.test.ts so the
 * mock cannot leak into the full-stack tests.
 */
import { afterEach, expect, test, vi } from "vitest";
import { DaemonConfigSchema } from "./config/config.js";
import { resolveDataDir } from "./config/paths.js";
import { Daemon } from "./daemon.js";
import type { DiscoveryAggregatorOptions } from "./discovery/aggregator.js";
import { makeTempDataDir, removeTempDataDir } from "./test-fixtures.js";

const captured = vi.hoisted(() => ({
  options: [] as unknown[],
}));

vi.mock("./discovery/aggregator.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./discovery/aggregator.js")>();
  class RecordingAggregator extends original.DiscoveryAggregator {
    constructor(options: DiscoveryAggregatorOptions) {
      super(options);
      captured.options.push(options);
    }
  }
  return { ...original, DiscoveryAggregator: RecordingAggregator };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

test("the daemon threads its onDiagnostic sink into the DiscoveryAggregator", async () => {
  const dir = await makeTempDataDir("homefleet-daemon-assembly-");
  cleanups.push(() => removeTempDataDir(dir));
  const dataDir = resolveDataDir({ HOMEFLEET_DATA_DIR: dir });

  const diagnostics: string[] = [];
  const daemon = new Daemon({
    dataDir,
    config: DaemonConfigSchema.parse({
      node: { name: "assembly" },
      hfp: { host: "127.0.0.1", port: 0 },
      mcp: { host: "127.0.0.1", port: 0 },
      control: { host: "127.0.0.1", port: 0 },
      discovery: { mdnsEnabled: false, udpEnabled: false },
    }),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());

  expect(captured.options).toHaveLength(1);
  const options = captured.options[0] as DiscoveryAggregatorOptions;
  expect(options.onDiagnostic).toBeDefined();
  // Behavioral identity, not mere presence: a message emitted into the
  // aggregator's sink must come out of the daemon's. Substring, not
  // equality — a future daemon-side prefixing wrapper would still pass
  // the message through, which is all this seam promises.
  options.onDiagnostic?.("assembly-check: discovery diagnostic");
  expect(
    diagnostics.some((m) => m.includes("assembly-check: discovery diagnostic")),
  ).toBe(true);
}, 30_000);
