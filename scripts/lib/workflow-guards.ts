/**
 * Text-level guards over GitHub workflow files (spec 2026-11-12, PR 1; PR 25
 * review and re-review). No YAML dependency. Before matching, every file is
 * normalized: `#` comments are stripped (outside quotes) and indentation is
 * rescaled to 2 spaces per level, so jobs are the 2-space keys under
 * `jobs:` and job keys are 4-space. Each guard is tested on bad text in
 * workflow-guards.test.ts and run on the real files in workflows.test.ts.
 */

export interface Workflow {
  name: string;
  text: string;
}

/** The only command the key-holding `sign` job may run. */
export const SIGN_RUN =
  "node src/scripts/sign-release.mjs release/homefleet-*.tgz";

/** The only env var the key-holding `sign` job may set. */
const SIGN_ENV = "HOMEFLEET_RELEASE_KEY";

/** The only actions the key-holding `sign` job may use. */
const SIGN_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "actions/download-artifact",
  "actions/upload-artifact",
]);

/** Drop a `#` comment that starts the line or follows whitespace, outside quotes. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/** Comments stripped, CRLF removed, indentation rescaled to 2 spaces per level. */
export function normalize(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n").map(stripComment);
  const unit = Math.min(
    ...lines
      .filter((l) => l.trim() !== "")
      .map(indentOf)
      .filter((n) => n > 0),
  );
  if (!Number.isFinite(unit) || unit === 2) return lines.join("\n");
  return lines
    .map((l) => " ".repeat(Math.floor(indentOf(l) / unit) * 2) + l.trimStart())
    .join("\n");
}

function preamble(text: string): string {
  const s = normalize(text);
  const at = s.search(/^jobs:\s*$/m);
  return at === -1 ? s : s.slice(0, at);
}

export function parseJobs(text: string): Map<string, string> {
  const s = normalize(text);
  const result = new Map<string, string>();
  const at = /^jobs:\s*$/m.exec(s);
  if (at === null) return result;
  const body = s.slice(at.index + at[0].length + 1);
  const marks = [...body.matchAll(/^ {2}([A-Za-z_][\w-]*):\s*$/gm)];
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.index ?? body.length;
    result.set(m[1] as string, body.slice(m.index, end));
  });
  return result;
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, "$2");

function environmentName(job: string): string | undefined {
  const m = /^ {4}environment:[ \t]*(.*)$/m.exec(job);
  if (m === null) return undefined;
  const value = (m[1] as string).trim();
  if (value.startsWith("{")) {
    const name = /\bname:\s*([^,}]+)/.exec(value)?.[1];
    return name === undefined ? undefined : unquote(name).toLowerCase();
  }
  if (value !== "") return unquote(value).toLowerCase();
  const rest = job.slice(m.index + m[0].length + 1).split("\n");
  for (const line of rest) {
    if (line.trim() === "") continue;
    if (indentOf(line) <= 4) break;
    const name = /^ {6}name:[ \t]*(.+)$/.exec(line)?.[1];
    if (name !== undefined) return unquote(name).toLowerCase();
  }
  return undefined;
}

/** `file#job` for every job, in any workflow, that uses the `release` environment (any case). */
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
  /secrets\.HOMEFLEET_RELEASE_KEY|secrets\[|secrets:[ \t]*inherit|toJSON\(\s*secrets\s*\)/i;

/**
 * `file#job` for every job that references the release key or could reach
 * it indirectly (`secrets: inherit`, `secrets[...]`, `toJSON(secrets)`), and
 * `file#(workflow)` when the workflow-level preamble does. Case-insensitive,
 * like GitHub's secret names.
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

/** Env var names set anywhere in a (normalized) job: job- or step-level `env:` blocks. */
function envNames(job: string): string[] {
  const names: string[] = [];
  const lines = job.split("\n");
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:-\s+)?env:[ \t]*(.*)$/.exec(line);
    if (m === null) return;
    if ((m[2] as string).trim() !== "") {
      names.push(`(inline env: ${(m[2] as string).trim()})`);
      return;
    }
    const keyIndent =
      indentOf(line) + (line.trimStart().startsWith("-") ? 2 : 0);
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === "") continue;
      if (indentOf(next) <= keyIndent) break;
      const key = /^\s*([^:\s]+):/.exec(next)?.[1];
      if (key !== undefined && indentOf(next) === keyIndent + 2)
        names.push(key);
    }
  });
  return names;
}

/** Why the key-holding job is not the minimal one; empty when it is. */
export function signJobViolations(job: string): string[] {
  const s = normalize(job);
  const problems: string[] = [];
  for (const m of s.matchAll(/^\s*(?:-\s+)?uses:[ \t]*(\S+)/gm)) {
    const ref = m[1] as string;
    if (!SIGN_ACTIONS.has(ref.split("@")[0] as string)) {
      problems.push(`action not allowed: ${ref}`);
    }
  }
  const runs = [...s.matchAll(/^\s*(?:-\s+)?run:[ \t]*(.*)$/gm)].map((m) =>
    (m[1] as string).trim(),
  );
  for (const run of runs) {
    if (run !== SIGN_RUN) problems.push(`run step not allowed: ${run}`);
  }
  if (runs.length !== 1) {
    problems.push(`expected exactly one run step, found ${runs.length}`);
  }
  if (/^\s*(?:-\s+)?shell:/m.test(s)) problems.push("shell: not allowed");
  for (const name of envNames(s)) {
    if (name !== SIGN_ENV) problems.push(`env var not allowed: ${name}`);
  }
  const runsOn = /^ {4}runs-on:[ \t]*(.*)$/m.exec(s)?.[1]?.trim();
  if (runsOn !== "ubuntu-latest") {
    problems.push(`runs-on must be ubuntu-latest, found ${runsOn ?? "none"}`);
  }
  if (/^\s+cache:/m.test(s)) problems.push("dependency cache configured");
  const setupNodes = (s.match(/uses:[ \t]*actions\/setup-node@/g) ?? []).length;
  const cacheOff = (s.match(/^\s+package-manager-cache:[ \t]*false\b/gm) ?? [])
    .length;
  if (cacheOff < setupNodes) {
    problems.push("setup-node without package-manager-cache: false");
  }
  for (const key of ["container", "services"]) {
    if (new RegExp(`^ {4}${key}:`, "m").test(s)) {
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
    if (l.trim() === "") continue;
    if (indentOf(l) === 0) break;
    entries.push(l.trim());
  }
  return entries;
}
