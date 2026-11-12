/**
 * Text-level guards over GitHub workflow files (spec 2026-11-12, PR 1; PR 25
 * review). No YAML dependency: the repo's workflows use 2-space indentation,
 * jobs are the 2-space keys under `jobs:`, job keys are 4-space. Each guard
 * is tested on bad text in workflow-guards.test.ts and run on the real
 * files in workflows.test.ts.
 */

export interface Workflow {
  name: string;
  text: string;
}

/** The only command the key-holding `sign` job may run. */
export const SIGN_RUN =
  "node src/scripts/sign-release.mjs release/homefleet-*.tgz";

/** The only actions the key-holding `sign` job may use. */
const SIGN_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "actions/download-artifact",
  "actions/upload-artifact",
]);

function preamble(text: string): string {
  const at = text.indexOf("\njobs:\n");
  return at === -1 ? text : text.slice(0, at + 1);
}

export function parseJobs(text: string): Map<string, string> {
  const at = text.indexOf("\njobs:\n");
  const result = new Map<string, string>();
  if (at === -1) return result;
  const body = text.slice(at + 7);
  const marks = [...body.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)];
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.index ?? body.length;
    result.set(m[1] as string, body.slice(m.index, end));
  });
  return result;
}

function environmentName(job: string): string | undefined {
  const inline = /^ {4}environment:[ \t]*(['"]?)([\w-]+)\1[ \t]*$/m.exec(job);
  if (inline !== null) return inline[2];
  const block = /^ {4}environment:[ \t]*\n((?: {6,}.*\n?)*)/m.exec(job);
  if (block === null) return undefined;
  return /^ {6}name:[ \t]*(['"]?)([\w-]+)\1/m.exec(block[1] as string)?.[2];
}

/** `file#job` for every job, in any workflow, that uses the `release` environment. */
export function releaseEnvironmentHolders(workflows: Workflow[]): string[] {
  const holders: string[] = [];
  for (const { name, text } of workflows) {
    for (const [id, job] of parseJobs(text)) {
      if (environmentName(job) === "release") holders.push(`${name}#${id}`);
    }
  }
  return holders;
}

const KEY_REFERENCE =
  /secrets\.HOMEFLEET_RELEASE_KEY|secrets\[|secrets:[ \t]*inherit|toJSON\(\s*secrets\s*\)/;

/**
 * `file#job` for every job that references the release key or could reach
 * it indirectly (`secrets: inherit`, `secrets[...]`, `toJSON(secrets)`), and
 * `file#(workflow)` when the workflow-level preamble does.
 */
export function releaseKeyUsers(workflows: Workflow[]): string[] {
  const users: string[] = [];
  for (const { name, text } of workflows) {
    if (KEY_REFERENCE.test(preamble(text))) users.push(`${name}#(workflow)`);
    for (const [id, job] of parseJobs(text)) {
      if (KEY_REFERENCE.test(job)) users.push(`${name}#${id}`);
    }
  }
  return users;
}

/** Why the key-holding job is not the minimal one; empty when it is. */
export function signJobViolations(job: string): string[] {
  const problems: string[] = [];
  for (const m of job.matchAll(/^\s+(?:- )?uses:[ \t]*(\S+)/gm)) {
    const ref = m[1] as string;
    const action = ref.split("@")[0] as string;
    if (!SIGN_ACTIONS.has(action)) problems.push(`action not allowed: ${ref}`);
  }
  const runs = [...job.matchAll(/^\s+(?:- )?run:[ \t]*(.*)$/gm)].map((m) =>
    (m[1] as string).trim(),
  );
  for (const run of runs) {
    if (run !== SIGN_RUN) problems.push(`run step not allowed: ${run}`);
  }
  if (runs.length !== 1) {
    problems.push(`expected exactly one run step, found ${runs.length}`);
  }
  if (/^\s+cache:/m.test(job)) problems.push("dependency cache configured");
  const setupNodes = (job.match(/uses:[ \t]*actions\/setup-node@/g) ?? [])
    .length;
  const cacheOff = (job.match(/package-manager-cache:[ \t]*false\b/g) ?? [])
    .length;
  if (cacheOff < setupNodes) {
    problems.push("setup-node without package-manager-cache: false");
  }
  for (const key of ["container", "services"]) {
    if (new RegExp(`^ {4}${key}:`, "m").test(job)) {
      problems.push(`${key} not allowed`);
    }
  }
  return problems;
}

/** The workflow-level `permissions:` entries (one-line value or block lines); [] when absent. */
export function topLevelPermissions(text: string): string[] {
  const lines = preamble(text).split("\n");
  const at = lines.findIndex((l) => /^permissions:/.test(l));
  if (at === -1) return [];
  const inline = (lines[at] as string).slice("permissions:".length).trim();
  if (inline !== "") return [inline];
  const entries: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!/^ {2}\S/.test(l)) break;
    entries.push(l.trim());
  }
  return entries;
}
