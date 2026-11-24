/**
 * Runs the release job's own "Plan" step (the bash in release.yml, as
 * written) through real bash, with `gh` and `jq` replaced by stubs that
 * serve a fixture of Releases. The release job re-derives the plan instead
 * of trusting pack's, so its bash is a second copy of the rules in
 * release-plan.ts and gets the same cases.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { parseJobs } from "./workflow-guards.js";

const workflow = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.github/workflows/release.yml",
  ),
  "utf8",
);
const releaseJob = parseJobs(workflow).get("release") as {
  steps: Array<{ id?: string; run?: string }>;
};
const planScript = releaseJob.steps.find((s) => s.id === "plan")?.run ?? "";

const stubDir = mkdtempSync(path.join(tmpdir(), "hf-release-plan-"));
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

// gh: `api --paginate --slurp .../releases` prints the fixture;
// `api .../commits/<tag> --jq .sha` prints that tag's commit from FAKE_COMMITS.
const GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require("node:fs");
const url = args.find((a) => a.startsWith("repos/"));
if (url.endsWith("/releases")) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_RELEASES, "utf8"));
} else if (url.includes("/commits/")) {
  const tag = url.split("/commits/")[1];
  const sha = JSON.parse(process.env.FAKE_COMMITS)[tag];
  if (!sha) process.exit(1);
  console.log(sha);
} else {
  process.exit(2);
}
`;
// jq: only the one filter the plan step uses (non-draft releases as
// "tag<TAB>prerelease" lines); anything else fails loudly.
const JQ = `#!/usr/bin/env node
const filter = process.argv.slice(2).join(" ");
const expected = "-r add | .[] | select(.draft | not) | [.tag_name, (.prerelease | tostring)] | @tsv";
if (filter !== expected) { console.error("jq stub: unexpected filter " + filter); process.exit(3); }
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  for (const r of JSON.parse(s).flat()) {
    if (!r.draft) console.log(r.tag_name + "\\t" + String(r.prerelease));
  }
});
`;
writeFileSync(path.join(stubDir, "gh"), GH, { mode: 0o755 });
writeFileSync(path.join(stubDir, "jq"), JQ, { mode: 0o755 });

interface Release {
  tag_name: string;
  prerelease: boolean;
  draft?: boolean;
}

const SHA = "1".repeat(40);

function runPlan(
  tag: string,
  releases: Release[][],
  commits: Record<string, string> = {},
): { code: number; out: Record<string, string>; stderr: string; log: string } {
  const dir = mkdtempSync(path.join(stubDir, "run-"));
  const fixture = path.join(dir, "releases.json");
  const output = path.join(dir, "output");
  writeFileSync(
    fixture,
    JSON.stringify(
      releases.map((page) => page.map((r) => ({ draft: false, ...r }))),
    ),
  );
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-c", planScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
      GITHUB_REF_NAME: tag,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: SHA,
      GITHUB_OUTPUT: output,
      FAKE_RELEASES: fixture,
      FAKE_COMMITS: JSON.stringify(commits),
    },
  });
  const out = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=", 2) as [string, string]),
  );
  // ::error:: lines go to stdout, as Actions wants them.
  return {
    code: result.status ?? -1,
    out,
    stderr: result.stderr,
    log: `${result.stdout}${result.stderr}`,
  };
}

const pre = (tag_name: string, extra: Partial<Release> = {}): Release => ({
  tag_name,
  prerelease: true,
  ...extra,
});
const fin = (tag_name: string): Release => ({ tag_name, prerelease: false });

describe("the release job's plan step, in real bash", () => {
  test("the step exists", () => {
    expect(planScript).toContain("gh api --paginate --slurp");
  });

  test("a final tag promotes the highest published candidate, by number, on its commit", () => {
    const run = runPlan(
      "v0.8.0",
      [
        [pre("v0.8.0-rc.9"), pre("v0.8.0-rc.11", { draft: true })],
        // Look-alikes: an unescaped "." in the pattern would let these in.
        [pre("v0.8.0-rc.10"), pre("v0.880-rc.99"), pre("v0.8.0-rc.01")],
      ],
      { "v0.8.0-rc.10": SHA },
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toEqual({
      mode: "promote",
      final: "v0.8.0",
      candidate: "v0.8.0-rc.10",
    });
  });

  test("a promote refuses a final tag on another commit than the candidate's", () => {
    const run = runPlan("v0.8.0", [[pre("v0.8.0-rc.1")]], {
      "v0.8.0-rc.1": "2".repeat(40),
    });
    expect(run.code).not.toBe(0);
    expect(run.log).toMatch(/not on the commit of v0\.8\.0-rc\.1/);
  });

  test("a final tag with no candidate is a build", () => {
    const run = runPlan("v0.9.0", [[pre("v0.8.0-rc.1"), fin("v0.8.0")]]);
    expect(run.code).toBe(0);
    expect(run.out).toEqual({ mode: "build", final: "v0.9.0", candidate: "" });
  });

  test("a candidate tag is a candidate of its final", () => {
    const run = runPlan("v0.8.0-rc.3", [[pre("v0.8.0-rc.2")]]);
    expect(run.code).toBe(0);
    expect(run.out).toEqual({
      mode: "candidate",
      final: "v0.8.0",
      candidate: "",
    });
  });

  test("a candidate tag after its final is published is refused", () => {
    const run = runPlan("v0.8.0-rc.3", [[pre("v0.8.0-rc.2"), fin("v0.8.0")]]);
    expect(run.code).not.toBe(0);
    expect(run.log).toMatch(/v0\.8\.0 is already released/);
  });

  test.each([["v0.8.0-beta.1"], ["v0.8.0-rc.0"], ["v0.8"]])(
    "%s is not a release tag",
    (tag) => {
      expect(runPlan(tag, [[]]).code).not.toBe(0);
    },
  );
});
