/**
 * Structural guards on the real .github/workflows files (spec 2026-11-12,
 * PR 1). The guards live in workflow-guards.ts and are tested on bad text in
 * workflow-guards.test.ts. These pin the properties a future edit could
 * silently undo — above all that the job holding the release key installs
 * nothing and is the only one that can read it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  parseJobs,
  releaseEnvironmentHolders,
  releaseKeyUsers,
  signJobViolations,
  topLevelPermissions,
} from "./workflow-guards.js";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({
    name: f,
    text: readFileSync(path.join(dir, f), "utf8").replaceAll("\r\n", "\n"),
  }));
const release = workflows.find((w) => w.name === "release.yml")?.text ?? "";
const ci = workflows.find((w) => w.name === "ci.yml")?.text ?? "";

/** The lines of a `- uses:` step block, up to the next sibling step or key. */
function stepBlocks(text: string, action: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)- uses: (\S+)@/.exec(line);
    if (m?.[2] !== action) return;
    const indent = (m[1] as string).length;
    const block = [line];
    for (const next of lines.slice(i + 1)) {
      const lead = next.length - next.trimStart().length;
      if (next.trim() !== "" && lead <= indent) break;
      block.push(next);
    }
    blocks.push(block.join("\n"));
  });
  return blocks;
}

test("every remote action is pinned to a commit SHA", () => {
  for (const { name, text } of workflows) {
    for (const line of text.split("\n")) {
      const m = /^\s*(?:- )?uses: (\S+)/.exec(line);
      if (m === null || /^(\.|\$)\//.test(m[1] as string)) continue;
      expect(line, `${name}: ${line.trim()}`).toMatch(
        /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/,
      );
    }
  }
});

test("only release.yml's sign job uses the release environment", () => {
  expect(releaseEnvironmentHolders(workflows)).toEqual(["release.yml#sign"]);
});

test("only release.yml's sign job can reach the release key", () => {
  expect(releaseKeyUsers(workflows)).toEqual(["release.yml#sign"]);
});

test("the sign job is minimal: allowed actions, one signer command, no cache", () => {
  expect(signJobViolations(parseJobs(release).get("sign") ?? "")).toEqual([]);
});

test("the sign job checks out exactly the signer and version.ts", () => {
  const lines = (parseJobs(release).get("sign") ?? "").split("\n");
  const at = lines.findIndex((l) => /sparse-checkout: \|/.test(l));
  expect(at).toBeGreaterThan(-1);
  const indent = (lines[at] as string).search(/\S/);
  const paths: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "" || l.search(/\S/) <= indent) break;
    paths.push(l.trim());
  }
  expect(paths.sort()).toEqual([
    "packages/protocol/src/version.ts",
    "scripts/sign-release.mjs",
  ]);
});

test("workflow-level permissions are exactly contents: read", () => {
  for (const { name, text } of workflows) {
    expect(topLevelPermissions(text), name).toEqual(["contents: read"]);
  }
});

test("only the release job can write", () => {
  for (const { name, text } of workflows) {
    for (const [id, body] of parseJobs(text)) {
      if (name === "release.yml" && id === "release") continue;
      expect(body, `${name} job ${id}`).not.toMatch(/:\s*write\b|write-all/);
    }
  }
});

test("pack checks the tag is on main before anything is signed", () => {
  expect(parseJobs(release).get("pack")).toContain("merge-base --is-ancestor");
});

test("only a tag push publishes; release runs never overlap", () => {
  const job = parseJobs(release).get("release") ?? "";
  expect(job).toMatch(
    /^ {4}if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)$/m,
  );
  expect(release).toMatch(
    /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m,
  );
});

test("publish treats only 'release not found' as no release", () => {
  const job = parseJobs(release).get("release") ?? "";
  expect(job).toContain("release not found");
  expect(job).not.toMatch(/gh release view[^\n]*2>\/dev\/null/);
});

test("the zizmor gate runs a pinned zizmor version", () => {
  const job = parseJobs(ci).get("zizmor") ?? "";
  expect(job).toMatch(/^\s+version: \d+\.\d+\.\d+$/m);
});

test("every checkout drops its credentials", () => {
  for (const { name, text } of workflows) {
    const blocks = stepBlocks(text, "actions/checkout");
    expect(blocks.length, name).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block, name).toContain("persist-credentials: false");
    }
  }
});
