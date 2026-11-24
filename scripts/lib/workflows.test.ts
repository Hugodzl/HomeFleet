/**
 * Structural guards on the real .github/workflows files (spec 2026-11-12,
 * PR 1). The files are read with a YAML parser (workflow-guards.ts), whose
 * guards are tested on bad text in workflow-guards.test.ts. These pin the
 * properties a future edit could silently undo — above all that the job
 * holding the release key installs nothing and is the only one that can
 * read it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  actionRefMismatches,
  dangerousTriggers,
  parseJobs,
  releaseEnvironmentHolders,
  releaseKeyUsers,
  reusableWorkflowViolations,
  signJobViolations,
  topLevel,
  topLevelPermissions,
  workflowLevelViolations,
  workflowProblems,
} from "./workflow-guards.js";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/i.test(f))
  .map((f) => ({
    name: f,
    // fatal: an undecodable byte fails here instead of becoming U+FFFD.
    text: new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(path.join(dir, f)),
    ),
  }));
const text = (name: string) =>
  workflows.find((w) => w.name === name)?.text ?? "";
const release = text("release.yml");
const ci = text("ci.yml");

type Step = Record<string, unknown> & {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = Record<string, unknown> & { steps?: Step[]; uses?: string };

const job = (workflow: string, id: string): Job =>
  (parseJobs(workflow).get(id) ?? {}) as Job;
const allJobs = () =>
  workflows.flatMap(({ name, text }) =>
    [...parseJobs(text)].map(([id, j]) => ({ name, id, job: j as Job })),
  );
const allSteps = () =>
  allJobs().flatMap(({ name, id, job }) =>
    (job.steps ?? []).map((step) => ({ where: `${name}#${id}`, step })),
  );
const actionOf = (ref: unknown) =>
  typeof ref === "string" ? ref.split("@")[0] : undefined;

test("every workflow is plain YAML the guards read the same way GitHub does", () => {
  for (const { name, text } of workflows) {
    expect(workflowProblems(text), name).toEqual([]);
  }
});

test("every remote action is pinned to a commit SHA, with its version noted", () => {
  const refs = [
    ...allJobs().map(({ name, job }) => ({ where: name, ref: job.uses })),
    ...allSteps().map(({ where, step }) => ({ where, ref: step.uses })),
  ].filter(({ ref }) => typeof ref === "string" && !/^(\.|\$)\//.test(ref));
  expect(refs.length).toBeGreaterThan(0);
  for (const { where, ref } of refs) {
    expect(ref, where).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  }
  // Dependabot keeps the trailing "# vX.Y.Z" comment in step with the SHA.
  for (const { name, text } of workflows) {
    for (const line of text.split(/\r?\n/)) {
      if (/@[0-9a-f]{40}/.test(line)) {
        expect(line, name).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/);
      }
    }
  }
});

test("only release.yml's sign job uses the release environment", () => {
  expect(releaseEnvironmentHolders(workflows)).toEqual(["release.yml#sign"]);
});

test("only release.yml's sign job can reach the release key", () => {
  expect(releaseKeyUsers(workflows)).toEqual(["release.yml#sign"]);
});

test("reusable workflow calls name only workflows these tests scan", () => {
  expect(reusableWorkflowViolations(workflows)).toEqual([]);
});

test("every action runs at one single ref across all workflows", () => {
  expect(actionRefMismatches(workflows)).toEqual([]);
});

test("no workflow runs on pull_request_target or workflow_run", () => {
  for (const { name, text } of workflows) {
    expect(dangerousTriggers(text), name).toEqual([]);
  }
});

test("release.yml runs only on a v* tag push or by hand", () => {
  expect(topLevel(release, "on")).toEqual({
    push: { tags: ["v*"] },
    workflow_dispatch: null,
  });
});

test("the sign job is minimal: allowlisted actions and inputs, one signer command", () => {
  expect(signJobViolations(parseJobs(release).get("sign"))).toEqual([]);
});

test("no workflow-level env or defaults, which would reach every job", () => {
  for (const { name, text } of workflows) {
    expect(workflowLevelViolations(text), name).toEqual([]);
  }
});

test("workflow-level permissions are exactly contents: read", () => {
  for (const { name, text } of workflows) {
    expect(topLevelPermissions(text), name).toEqual({ contents: "read" });
  }
});

test("only the release job can write", () => {
  for (const { name, id, job } of allJobs()) {
    if (name === "release.yml" && id === "release") continue;
    const perms = job.permissions;
    const values =
      typeof perms === "object" && perms !== null
        ? Object.values(perms)
        : [perms];
    expect(values, `${name}#${id}`).not.toContain("write");
    expect(values, `${name}#${id}`).not.toContain("write-all");
  }
});

test("pack checks the tag is on main before anything is signed", () => {
  const runs = (job(release, "pack").steps ?? []).map((s) => s.run ?? "");
  expect(runs.some((r) => r.includes("merge-base --is-ancestor"))).toBe(true);
});

test("only a tag push publishes; release runs never overlap", () => {
  expect(job(release, "release").if).toBe(
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
  );
  expect(topLevel(release, "concurrency")).toEqual({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub expression
    group: "release-${{ github.ref }}",
    "cancel-in-progress": false,
  });
});

test("publish treats only 'release not found' as no release", () => {
  const runs = (job(release, "release").steps ?? []).map((s) => s.run ?? "");
  const publish = runs.find((r) => r.includes("gh release create")) ?? "";
  expect(publish).toContain("release not found");
  expect(publish).not.toMatch(/gh release view[^\n]*2>\/dev\/null/);
});

const zizmorStep = (id: string) =>
  (job(ci, id).steps ?? []).find(
    (s) => actionOf(s.uses) === "zizmorcore/zizmor-action",
  );

test("the zizmor gate runs a pinned zizmor version, offline", () => {
  const step = zizmorStep("zizmor");
  expect(String(step?.with?.version)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(step?.with?.["advanced-security"]).toBe(false);
  // ci.yml is also the release gate: a new online advisory must not fail an
  // already-pushed tag.
  expect(step?.with?.["online-audits"]).toBe(false);
});

test("online zizmor audits run on pull requests only, never in the release gate", () => {
  expect(job(ci, "zizmor-online").if).toBe(
    "github.event_name == 'pull_request'",
  );
  const step = zizmorStep("zizmor-online");
  expect(String(step?.with?.version)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(step?.with?.["online-audits"]).not.toBe(false);
});

test("every checkout drops its credentials", () => {
  const checkouts = allSteps().filter(
    ({ step }) => actionOf(step.uses) === "actions/checkout",
  );
  expect(checkouts.length).toBeGreaterThan(0);
  for (const { where, step } of checkouts) {
    expect(step.with?.["persist-credentials"], where).toBe(false);
  }
});

// Review loop, round 5: pin the verify-before-publish link.
const downloads = (id: string) =>
  (job(release, id).steps ?? [])
    .filter((s) => actionOf(s.uses) === "actions/download-artifact")
    .map((s) => s.with?.name);

test("verify, smoke and release use the tarball and the signature, signature last", () => {
  for (const id of ["verify", "smoke", "release"]) {
    expect(downloads(id), id).toEqual([
      "homefleet-tarball",
      "homefleet-signature",
    ]);
  }
  expect(job(release, "release").needs).toEqual(["verify", "smoke"]);
});

test("verify checks the real tarball against the signed manifest", () => {
  const runs = (job(release, "verify").steps ?? []).map((s) => s.run ?? "");
  expect(runs).toContain("pnpm verify:release release/homefleet-*.tgz");
});

test("the Release gets only the three signed-release file kinds", () => {
  // Every release/ path any run step of the release job names, so a file
  // added after --repo or by a separate gh release upload step shows up too.
  const words = (job(release, "release").steps ?? [])
    .flatMap((s) => (s.run ?? "").split(/\s+/))
    .filter((w) => w.startsWith("release/"));
  expect([...new Set(words)].sort()).toEqual([
    "release/homefleet-*.manifest.json",
    "release/homefleet-*.manifest.sig",
    "release/homefleet-*.tgz",
  ]);
});

test("the signature artifact expires after a day", () => {
  const upload = (job(release, "sign").steps ?? []).find(
    (s) => actionOf(s.uses) === "actions/upload-artifact",
  );
  expect(upload?.with?.["retention-days"]).toBe(1);
});

test("pack's digest step fails when no tarball matches", () => {
  const step = (job(release, "pack").steps ?? []).find(
    (s) => s.id === "digest",
  );
  const run = step?.run ?? "";
  expect(run).toContain("shopt -s nullglob");
  expect(run.indexOf("shopt -s nullglob")).toBeLessThan(run.indexOf("files=("));
});

// --- Release candidates (spec 2026-11-12, PR 2) ---

const stepsOf = (id: string) => job(release, id).steps ?? [];
const stepNamed = (id: string, name: string) =>
  stepsOf(id).find((s) => s.name === name);
const envOf = (step: Step | undefined) =>
  (step?.env ?? {}) as Record<string, unknown>;

test("pack plans the run with release:plan, using only github.token", () => {
  const plan = stepsOf("pack").find((s) => s.id === "plan");
  expect(plan?.run).toContain("pnpm release:plan");
  expect(plan?.run).toContain("--paginate --slurp");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub expression
  expect(envOf(plan)).toEqual({ GH_TOKEN: "${{ github.token }}" });
  for (const step of stepsOf("pack")) {
    for (const value of Object.values(envOf(step))) {
      expect(String(value)).not.toMatch(/secrets\./);
    }
  }
});

test("promote: pack refuses unless the final tag's commit is the candidate's, then downloads and verifies the candidate instead of building", () => {
  const promote = stepNamed("pack", "Promote: take the candidate's tarball");
  expect(promote?.if).toBe("steps.plan.outputs.mode == 'promote'");
  const run = promote?.run ?? "";
  expect(run).toContain('git rev-list -n 1 "$CANDIDATE"');
  expect(run).toContain('"$GITHUB_SHA"');
  expect(run).toContain('gh release download "$CANDIDATE"');
  expect(run).toContain("pnpm verify:release candidate/homefleet-*.tgz");
  expect(run.indexOf("rev-list")).toBeLessThan(run.indexOf("release download"));
  const pack = stepsOf("pack").find((s) =>
    s.name?.toString().startsWith("Pack"),
  );
  expect(pack?.if).toBe("steps.plan.outputs.mode != 'promote'");
});

test("notes are read from docs/releases/<final>.md, for candidates too", () => {
  const check = stepNamed(
    "pack",
    'Release notes exist and are titled "# HomeFleet <final> — …"',
  );
  expect(check?.run).toContain('notes="docs/releases/$FINAL.md"');
  const publish = stepNamed("release", "Publish the GitHub Release");
  expect(publish?.run).toContain('notes="docs/releases/$final.md"');
});

test("release re-derives the plan itself and never reads pack's", () => {
  expect(job(release, "release").needs).toEqual(["verify", "smoke"]);
  const plan = stepsOf("release").find((s) => s.id === "plan");
  const run = plan?.run ?? "";
  expect(run).toContain("--paginate --slurp");
  expect(run).toContain("sort -V");
  expect(run).toContain('commits/$candidate" --jq .sha');
  for (const step of stepsOf("release")) {
    expect(JSON.stringify(step)).not.toContain("needs.pack");
  }
});

test("promote: release compares the tarball and manifest with the candidate Release's before publishing", () => {
  const steps = stepsOf("release");
  const compare = steps.findIndex(
    (s) => s.name === "Promote: the bytes are the candidate's",
  );
  const publish = steps.findIndex(
    (s) => s.name === "Publish the GitHub Release",
  );
  expect(compare).toBeGreaterThanOrEqual(0);
  expect(compare).toBeLessThan(publish);
  const step = steps[compare];
  expect(step?.if).toBe("steps.plan.outputs.mode == 'promote'");
  const run = step?.run ?? "";
  expect(run).toContain("cmp");
  expect(run).toContain("release/homefleet-*.tgz");
  expect(run).toContain("release/homefleet-*.manifest.json");
});

test("a candidate is published as a prerelease that is never latest, with the notice line", () => {
  const run = stepNamed("release", "Publish the GitHub Release")?.run ?? "";
  expect(run).toContain("--prerelease --latest=false");
  expect(run).toContain("Release candidate for testing on Hugo's rig");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal bash expansion
  expect(run).toContain('title="${title/"$final"/"$tag"}"');
});
