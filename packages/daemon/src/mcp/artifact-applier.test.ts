/**
 * Unit tests for the delegator-side artifact applier: the fetch-then-apply
 * plumbing `job_result` drives. `applyWriteArtifact` is mocked here to pin
 * the CALL CONTRACT — most importantly that the production path never sets
 * the TEST-SEAM-ONLY `testHookBeforeFetch` — while the real apply gate stays
 * covered by artifact-apply.test.ts and the end-to-end wiring by
 * daemon.integration.test.ts.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WriteArtifact } from "@homefleet/protocol";
import { expect, test, vi } from "vitest";
import type { HfpTarget } from "../transport/client.js";
import {
  ApplyError,
  type ApplyWriteArtifactInput,
} from "../workspace/artifact-apply.js";
import {
  type ArtifactFetchClient,
  createArtifactApplier,
} from "./artifact-applier.js";

const applyCalls = vi.hoisted(() => ({
  inputs: [] as unknown[],
  nextResult: { branchName: "homefleet/abcdefabcdef" },
  nextError: undefined as Error | undefined,
}));

vi.mock("../workspace/artifact-apply.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../workspace/artifact-apply.js")>();
  return {
    ...original,
    applyWriteArtifact: async (input: unknown) => {
      applyCalls.inputs.push(input);
      if (applyCalls.nextError !== undefined) {
        throw applyCalls.nextError;
      }
      return applyCalls.nextResult;
    },
  };
});

const TARGET: HfpTarget = {
  host: "127.0.0.1",
  port: 1,
  expectedDeviceId: "d".repeat(64),
};

const ARTIFACT: WriteArtifact = {
  branchName: "homefleet/abcdefabcdef",
  baseCommit: "b".repeat(40),
  headCommit: "c".repeat(40),
  diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
  commitMessage: "test change",
};

/** A fetch client that records its call and "downloads" a stub bundle. */
function fakeFetch(headerCommit: string): {
  client: ArtifactFetchClient;
  calls: Array<{ jobId: string; destPath: string; maxBytes: number }>;
} {
  const calls: Array<{ jobId: string; destPath: string; maxBytes: number }> =
    [];
  return {
    calls,
    client: {
      fetchJobArtifact: async (_target, jobId, destPath, options) => {
        calls.push({ jobId, destPath, maxBytes: options.maxBytes });
        await writeFile(destPath, "stub-bundle-bytes");
        return { headCommit: headerCommit };
      },
    },
  };
}

test("apply fetches with the configured maxBytes, applies WITHOUT the test seam, and cleans its temp dir", async () => {
  applyCalls.inputs.length = 0;
  applyCalls.nextError = undefined;
  const { client, calls } = fakeFetch(ARTIFACT.headCommit);
  const apply = createArtifactApplier({ client, maxBundleBytes: 12345 });

  const result = await apply({
    target: TARGET,
    jobId: "job-1",
    artifact: ARTIFACT,
    repoPath: "/src/repo",
  });
  expect(result).toEqual({ branchName: "homefleet/abcdefabcdef" });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.jobId).toBe("job-1");
  expect(calls[0]?.maxBytes).toBe(12345);

  expect(applyCalls.inputs).toHaveLength(1);
  const input = applyCalls.inputs[0] as ApplyWriteArtifactInput;
  expect(input.sourceRepoPath).toBe("/src/repo");
  expect(input.artifact).toEqual(ARTIFACT);
  expect(input.bundlePath).toBe(calls[0]?.destPath);
  // The TEST-SEAM-ONLY hook must never be set by the production path — not
  // even as an explicit `undefined` property.
  expect("testHookBeforeFetch" in input).toBe(false);
  // The hooks dir handed to git existed (empty) at apply time; both it and
  // the fetched bundle live in a temp dir that is removed afterwards.
  expect(path.dirname(input.hooksPathDir)).toBe(path.dirname(input.bundlePath));
  expect(existsSync(path.dirname(input.bundlePath))).toBe(false);
});

test("a header tip disagreeing with the artifact's claimed headCommit refuses before any apply, as a typed REF_MISMATCH", async () => {
  applyCalls.inputs.length = 0;
  applyCalls.nextError = undefined;
  const { client, calls } = fakeFetch("e".repeat(40));
  const apply = createArtifactApplier({ client, maxBundleBytes: 1024 });

  const thrown = await apply({
    target: TARGET,
    jobId: "job-2",
    artifact: ARTIFACT,
    repoPath: "/src/repo",
  }).then(
    () => null,
    (error: unknown) => error,
  );
  // Same failure taxonomy as every other apply refusal: a typed ApplyError,
  // so the MCP surface renders the uniform "CODE: message" reason.
  expect(thrown).toBeInstanceOf(ApplyError);
  expect((thrown as ApplyError).code).toBe("REF_MISMATCH");
  expect((thrown as ApplyError).message).toMatch(/head/i);
  expect(applyCalls.inputs).toHaveLength(0);
  // The temp download is cleaned up on the failure path too.
  expect(existsSync(path.dirname(calls[0]?.destPath ?? ""))).toBe(false);
});

test("an apply failure propagates and still cleans the temp dir", async () => {
  applyCalls.inputs.length = 0;
  applyCalls.nextError = new Error("NON_FAST_FORWARD: ref exists");
  const { client, calls } = fakeFetch(ARTIFACT.headCommit);
  const apply = createArtifactApplier({ client, maxBundleBytes: 1024 });

  await expect(
    apply({
      target: TARGET,
      jobId: "job-3",
      artifact: ARTIFACT,
      repoPath: "/src/repo",
    }),
  ).rejects.toThrow(/NON_FAST_FORWARD/);
  expect(existsSync(path.dirname(calls[0]?.destPath ?? ""))).toBe(false);
  applyCalls.nextError = undefined;
});
