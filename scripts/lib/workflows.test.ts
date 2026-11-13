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
  .map((f) => ({ name: f, text: readFileSync(path.join(dir, f), "utf8") }));
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
