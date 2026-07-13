/**
 * Unit pin for the artifact download route's stream cleanup (v0.2 Task 8
 * follow-up): a client disconnect mid-download MUST destroy the server-side
 * bundle read stream, or its fd leaks for the daemon's lifetime.
 *
 * This cannot be pinned from the loopback integration suite: Node opens
 * files with FILE_SHARE_DELETE and libuv unlinks with POSIX delete
 * semantics, so on Windows (and trivially on POSIX) a bundle held open by a
 * leaked read stream still deletes cleanly — `rm` success does not
 * discriminate. So this test wraps `createReadStream` to capture the route's
 * stream and asserts `destroyed` directly.
 */
import type { ReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { expect, test, vi } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import type { NodeServer, StreamRouteHandler } from "../transport/server.js";
import { ArtifactStore } from "../workspace/artifact-store.js";
import type { JobManager } from "./job-manager.js";
import { registerJobRoutes } from "./routes.js";

const captured = vi.hoisted(() => ({ streams: [] as unknown[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      captured.streams.push(stream);
      return stream;
    },
  };
});

/** A discarding Writable that looks enough like a ServerResponse to pipe to. */
class FakeResponse extends Writable {
  headersSent = false;

  writeHead(): this {
    this.headersSent = true;
    return this;
  }

  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil timed out");
}

test("a response closed mid-download destroys the bundle read stream (no fd leak)", async () => {
  const dir = await makeTempDataDir("homefleet-artifact-route-");
  try {
    const bundlePath = path.join(dir, "job.bundle");
    // Large enough that the pipe cannot complete before we destroy the
    // response (FakeResponse consumes lazily via the event loop anyway).
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    await writeFile(bundlePath, bytes);

    const jobId = "0b294587-2342-4718-b6bb-2b3c837e2a9c";
    const artifacts = new ArtifactStore();
    artifacts.register(jobId, {
      bundlePath,
      headCommit: "f".repeat(40),
      byteLength: bytes.length,
    });

    // Capture the artifact stream-route handler off a stub server; the
    // manager stub answers the ownership gate for our owner.
    const streamRoutes = new Map<string, StreamRouteHandler>();
    const server = {
      route: () => {},
      routeStream: (
        _method: string,
        routePath: string,
        _options: unknown,
        handler: StreamRouteHandler,
      ) => {
        streamRoutes.set(routePath, handler);
      },
    } as unknown as NodeServer;
    const manager = { snapshot: () => ({}) } as unknown as JobManager;
    registerJobRoutes(server, manager, artifacts);
    const handler = streamRoutes.get("/jobs/:id/artifact");
    if (handler === undefined) {
      throw new Error("artifact route was not registered");
    }

    const res = new FakeResponse();
    handler({
      peer: { deviceId: "owner-device", paired: true },
      params: { id: jobId },
      req: {} as never,
      res: res as never,
    });

    // The handler opened the bundle and started piping.
    await waitUntil(() => captured.streams.length === 1);
    const stream = captured.streams[0] as ReadStream;
    await waitUntil(() => res.headersSent);

    // Client disconnect: destroying the response emits 'close'; the route
    // must destroy the read stream, releasing the bundle's fd.
    res.destroy();
    await waitUntil(() => stream.destroyed);
    expect(stream.destroyed).toBe(true);
  } finally {
    await removeTempDataDir(dir);
  }
});
