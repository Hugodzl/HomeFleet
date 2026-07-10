import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Many daemon tests are real-I/O integration tests: they spawn real git
    // subprocesses and bind real UDP sockets. Their wall-time is dominated by
    // OS process/socket latency, which balloons on slow CI (Windows runners)
    // and when the parallel suite starves the event loop. The underlying git
    // operations already carry their own 30s timeouts, so aligning vitest's
    // per-test and per-hook timeouts to 30s means a real operation failure
    // surfaces with its own error instead of a generic "Test timed out" — and
    // a merely-slow-but-correct test is no longer flaky. These bounds are
    // headroom, not latency assertions (see udp.test.ts DELIVERY_TIMEOUT_MS).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
