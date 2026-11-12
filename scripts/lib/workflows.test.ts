/**
 * Structural guards on .github/workflows (spec 2026-11-12, PR 1). Plain text
 * parsing, no YAML dependency: jobs are the 2-space-indented keys under
 * `jobs:`. These pin the properties a future edit could silently undo —
 * above all that the job holding the release key installs nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({
    name: f,
    text: readFileSync(path.join(dir, f), "utf8").replaceAll("\r\n", "\n"),
  }));
const release = workflows.find((w) => w.name === "release.yml")?.text ?? "";

function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const result = new Map<string, string>();
  const header = /^ {2}([a-z][\w-]*):\s*$/gm;
  const marks = [...body.matchAll(header)];
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.index ?? body.length;
    result.set(m[1] as string, body.slice(m.index, end));
  });
  return result;
}

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

describe("the job holding the release environment installs nothing", () => {
  const all = jobs(release);
  const holders = [...all].filter(([, t]) => /environment: release\b/.test(t));

  test("exactly one job, named sign", () => {
    expect(holders.map(([id]) => id)).toEqual(["sign"]);
  });

  test("no install, no dependency cache, no pnpm", () => {
    const sign = all.get("sign") ?? "";
    for (const banned of [
      "pnpm install",
      "npm i",
      "npm ci",
      "pnpm/action-setup",
    ]) {
      expect(sign, banned).not.toContain(banned);
    }
    // No `cache: <pm>`, and setup-node's automatic cache explicitly off.
    expect(sign).not.toMatch(/^\s+cache:/m);
    expect(sign).toContain("package-manager-cache: false");
  });

  test("checks out exactly the signer and version.ts", () => {
    const sign = all.get("sign") ?? "";
    const lines = sign.split("\n");
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
});

test("only the release job can write", () => {
  for (const { name, text } of workflows) {
    expect(text, name).toMatch(/^permissions:\n {2}contents: read$/m);
    for (const [id, body] of jobs(text)) {
      if (name === "release.yml" && id === "release") continue;
      expect(body, `${name} job ${id}`).not.toMatch(/:\s*write\b/);
    }
  }
});

test("pack checks the tag is on main before anything is signed", () => {
  expect(jobs(release).get("pack")).toContain("merge-base --is-ancestor");
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
