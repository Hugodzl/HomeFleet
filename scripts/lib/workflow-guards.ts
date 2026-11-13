/**
 * Text-level guards over GitHub workflow files (spec 2026-11-12, PR 1; PR 25
 * review and re-reviews). No YAML dependency, so the guards FAIL CLOSED:
 * workflows must be plain 2-space YAML (indentationProblems), structure is
 * read with `#` comments stripped, but key references are searched in the
 * RAW text, and any environment value that is not a plain name counts as
 * the release environment. Each guard is tested on bad text in
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

const toLines = (text: string): string[] =>
  text.replaceAll("\r\n", "\n").split("\n");

/** Comments stripped, CRLF removed. Indentation is left as is: see indentationProblems. */
export function normalize(text: string): string {
  return toLines(text).map(stripComment).join("\n");
}

const BLOCK_SCALAR = /:\s*[|>][-+0-9]*$/;

/**
 * Why this file is not plain 2-space YAML; empty when it is. Every
 * structural line is indented by an even number of spaces and at most one
 * level (2 spaces) deeper than the line it nests under; block-scalar bodies
 * (`run: |`) are free-form. The other guards assume this layout, so a file
 * that breaks it fails instead of being half-read.
 */
export function indentationProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = toLines(text).map(stripComment);
  let parent = 0;
  let scalarParent: number | undefined;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const indent = indentOf(line);
    if (scalarParent !== undefined) {
      if (indent > scalarParent) return;
      scalarParent = undefined;
    }
    if (indent % 2 !== 0) {
      problems.push(`line ${i + 1}: odd indentation (${indent})`);
    } else if (indent > parent + 2) {
      problems.push(
        `line ${i + 1}: indented ${indent - parent} spaces under its parent, not 2`,
      );
    }
    const dash = /^\s*-\s+/.exec(line);
    // Keys of a list item ("- uses: x" then "with:") sit 2 deeper than the dash.
    parent = dash !== null ? indent + 2 : indent;
    if (BLOCK_SCALAR.test(line)) scalarParent = indent;
  });
  return problems;
}

interface JobRange {
  id: string;
  start: number;
  end: number;
}

/** Line ranges of the jobs, found on the comment-stripped text; same line numbers as the raw text. */
function jobRanges(lines: string[]): { jobsLine: number; jobs: JobRange[] } {
  const jobsLine = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsLine === -1) return { jobsLine: lines.length, jobs: [] };
  const jobs: JobRange[] = [];
  for (let i = jobsLine + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(lines[i] as string);
    if (m === null) continue;
    const last = jobs.at(-1);
    if (last !== undefined) last.end = i;
    jobs.push({ id: m[1] as string, start: i, end: lines.length });
  }
  return { jobsLine, jobs };
}

function preamble(text: string): string {
  const lines = toLines(normalize(text));
  return lines.slice(0, jobRanges(lines).jobsLine).join("\n");
}

export function parseJobs(text: string): Map<string, string> {
  const lines = toLines(normalize(text));
  const result = new Map<string, string>();
  for (const { id, start, end } of jobRanges(lines).jobs) {
    result.set(id, lines.slice(start, end).join("\n"));
  }
  return result;
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, "$2");

/** A plain environment name, or DYNAMIC for anything the guards can't read literally. */
const DYNAMIC = "(not a plain name)";

function plainName(value: string): string {
  const v = unquote(value);
  return /^[\w-]+$/.test(v) ? v.toLowerCase() : DYNAMIC;
}

function environmentName(job: string): string | undefined {
  const m = /^ {4}environment:[ \t]*(.*)$/m.exec(job);
  if (m === null) return undefined;
  const value = (m[1] as string).trim();
  if (value.startsWith("{")) {
    if (!value.endsWith("}")) return DYNAMIC;
    const name = /^\{\s*name:\s*([^,}]+?)\s*[,}]/.exec(value)?.[1];
    return name === undefined ? DYNAMIC : plainName(name);
  }
  if (value !== "") return plainName(value);
  const rest = job.slice(m.index + m[0].length + 1).split("\n");
  for (const line of rest) {
    if (line.trim() === "") continue;
    if (indentOf(line) <= 4) break;
    const name = /^ {6}name:[ \t]*(.+)$/.exec(line)?.[1];
    if (name !== undefined) return plainName(name);
  }
  return DYNAMIC;
}

/**
 * `file#job` for every job, in any workflow, that uses the `release`
 * environment (any case) or an environment the guards can't read literally
 * (an expression, anchor, alias, tag, multi-line flow map): fail closed.
 */
export function releaseEnvironmentHolders(workflows: Workflow[]): string[] {
  const holders: string[] = [];
  for (const { name, text } of workflows) {
    for (const [id, job] of parseJobs(text)) {
      const env = environmentName(job);
      if (env === "release" || env === DYNAMIC) holders.push(`${name}#${id}`);
    }
  }
  return holders;
}

const KEY_REFERENCE =
  /secrets\.HOMEFLEET_RELEASE_KEY|secrets\[|secrets:[ \t]*inherit|toJSON\(\s*secrets\s*\)/i;

/**
 * `file#job` for every job that references the release key or could reach
 * it indirectly (`secrets: inherit`, `secrets[...]`, `toJSON(secrets)`), and
 * `file#(workflow)` when the workflow-level preamble does. Searched in the
 * RAW text, comments included — a `#` inside a `run: |` script is content
 * GitHub still expands — and case-insensitively, like secret names.
 */
export function releaseKeyUsers(workflows: Workflow[]): string[] {
  const users: string[] = [];
  for (const { name, text } of workflows) {
    const raw = toLines(text);
    const { jobsLine, jobs } = jobRanges(toLines(normalize(text)));
    if (KEY_REFERENCE.test(raw.slice(0, jobsLine).join("\n"))) {
      users.push(`${name}#(workflow)`);
    }
    for (const { id, start, end } of jobs) {
      if (KEY_REFERENCE.test(raw.slice(start, end).join("\n"))) {
        users.push(`${name}#${id}`);
      }
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
