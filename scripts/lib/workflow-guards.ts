/**
 * Structural guards over GitHub workflow files (spec 2026-11-12, PR 1; PR 25
 * review and re-reviews). The files are read with a real YAML parser
 * (`yaml`, a test-only dev dependency), so quoting, spacing, flow maps,
 * comments and line endings can't hide anything: the guards check the parsed
 * structure, which is what GitHub runs. To keep that true they also reject
 * YAML features where parsers may disagree (anchors, aliases, tags, merge
 * keys, duplicate keys). Each guard is tested on bad text in
 * workflow-guards.test.ts and run on the real files in workflows.test.ts.
 */
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from "yaml";

export interface Workflow {
  name: string;
  text: string;
}

type YamlMap = Record<string, unknown>;

/** The only command the key-holding `sign` job may run. */
export const SIGN_RUN =
  "node src/scripts/sign-release.mjs release/homefleet-*.tgz";

const SIGN_KEY_ENV = "HOMEFLEET_RELEASE_KEY";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub expression
const SIGN_KEY_VALUE = "${{ secrets.HOMEFLEET_RELEASE_KEY }}";
const SIGN_SPARSE = [
  "packages/protocol/src/version.ts",
  "scripts/sign-release.mjs",
];

/**
 * The only actions the `sign` job may use (each at most once), each with the
 * only `with:` inputs it may set. `required` inputs must be present with
 * exactly that value, so paths and artifact names are pinned: nothing
 * downloaded can land where the signer command looks for its script.
 * Anything else — a checkout `repository`/`ref`/`token`, a cache, a download
 * from another run, an expression value — is a violation.
 */
const SIGN_ACTIONS: Record<
  string,
  { allowed: string[]; required: Record<string, unknown> }
> = {
  "actions/checkout": {
    allowed: [
      "sparse-checkout",
      "sparse-checkout-cone-mode",
      "path",
      "persist-credentials",
    ],
    required: {
      "persist-credentials": false,
      path: "src",
      "sparse-checkout-cone-mode": false,
    },
  },
  "actions/setup-node": {
    allowed: ["node-version", "package-manager-cache"],
    required: { "package-manager-cache": false },
  },
  "actions/download-artifact": {
    allowed: ["name", "path"],
    required: { name: "homefleet-tarball", path: "release" },
  },
  "actions/upload-artifact": {
    allowed: ["name", "path", "if-no-files-found"],
    required: {
      name: "homefleet-release",
      path: "release/homefleet-*",
      "if-no-files-found": "error",
    },
  },
};

const SIGN_JOB_KEYS = new Set(["needs", "runs-on", "environment", "steps"]);
const WORKFLOW_KEYS = new Set([
  "name",
  "run-name",
  "on",
  "permissions",
  "concurrency",
  "jobs",
]);

const isPlainMap = (v: unknown): v is YamlMap =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Characters where YAML parsers disagree: `yaml` (YAML 1.2) does not break
 * lines on NEL/LS/PS, but GitHub's and zizmor's libyaml-style parsers do, so
 * text hidden after one in a comment would be YAML to GitHub only. Also C0/C1
 * controls, bidi overrides/isolates (Trojan Source) and a BOM after the
 * start. Tab, LF and CR are fine; so is ordinary non-ASCII text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const DIVERGENT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]|[\s\S]\uFEFF/;

function load(text: string): { root: unknown; problems: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });
  const problems = [
    ...(DIVERGENT_CHARS.test(text)
      ? [
          "a control, line-separator or bidi character where YAML parsers disagree",
        ]
      : []),
    ...doc.errors.map((e) => `YAML error: ${e.message}`),
    ...doc.warnings.map((w) => `YAML warning: ${w.message}`),
  ];
  visit(doc, {
    Alias() {
      problems.push("YAML alias not allowed");
    },
    Node(_key, node) {
      if (isNode(node) && node.anchor)
        problems.push(`YAML anchor &${node.anchor} not allowed`);
      if (isNode(node) && node.tag !== undefined)
        problems.push(`YAML tag ${node.tag} not allowed`);
    },
    Pair(_key, pair) {
      const k = pair.key;
      if (isAlias(k) || !isScalar(k) || typeof k.value !== "string") {
        problems.push("YAML keys must be plain strings");
      } else if (k.value === "<<") {
        problems.push("YAML merge key << not allowed");
      }
    },
  });
  if (!isMap(doc.contents)) problems.push("the workflow root is not a map");
  let root: unknown;
  try {
    root = doc.toJS();
  } catch (error) {
    problems.push(`YAML could not be read: ${String(error)}`);
  }
  return { root, problems };
}

/** Why this file can't be trusted to read the same in the guards as on GitHub; empty when it can. */
export function workflowProblems(text: string): string[] {
  const { root, problems } = load(text);
  const jobs = isPlainMap(root) ? root.jobs : undefined;
  if (!isPlainMap(jobs) || Object.keys(jobs).length === 0) {
    problems.push("`jobs` is not a non-empty map");
  }
  return problems;
}

function rootOf(text: string): YamlMap {
  const { root } = load(text);
  return isPlainMap(root) ? root : {};
}

export function parseJobs(text: string): Map<string, unknown> {
  const jobs = rootOf(text).jobs;
  return new Map(isPlainMap(jobs) ? Object.entries(jobs) : []);
}

/** Top-level keys a workflow may have: no `env` or `defaults`, which reach every job. */
export function workflowLevelViolations(text: string): string[] {
  return Object.keys(rootOf(text))
    .filter((k) => !WORKFLOW_KEYS.has(k))
    .map((k) => `workflow-level ${k}: not allowed`);
}

/** A parsed workflow-level value (`permissions`, `concurrency`, …); undefined when absent. */
export function topLevel(text: string, key: string): unknown {
  return rootOf(text)[key];
}

/** The parsed workflow-level `permissions:` value; undefined when absent. */
export function topLevelPermissions(text: string): unknown {
  return topLevel(text, "permissions");
}

const PLAIN_NAME = /^[\w-]+$/;
const NOT_PLAIN = "(not a plain name)";

function environmentName(job: unknown): string | undefined {
  if (!isPlainMap(job) || !("environment" in job)) return undefined;
  const env = job.environment;
  const name = isPlainMap(env) ? env.name : env;
  return typeof name === "string" && PLAIN_NAME.test(name)
    ? name.toLowerCase()
    : NOT_PLAIN;
}

/**
 * `file#job` for every job, in any workflow, that uses the `release`
 * environment (any case) or an environment value that isn't a plain name
 * (an expression, a map without a plain `name`): fail closed.
 */
export function releaseEnvironmentHolders(workflows: Workflow[]): string[] {
  const holders: string[] = [];
  for (const { name, text } of workflows) {
    for (const [id, job] of parseJobs(text)) {
      const env = environmentName(job);
      if (env === "release" || env === NOT_PLAIN) holders.push(`${name}#${id}`);
    }
  }
  return holders;
}

const KEY_REFERENCE =
  /secrets\s*\.\s*HOMEFLEET_RELEASE_KEY|secrets\s*\.\s*\*|secrets\s*\[|toJSON\(\s*secrets\s*\)/i;

/** Every string key and value inside a parsed value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isPlainMap(value)) {
    return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  }
  return [];
}

/**
 * True for an expression that uses `secrets` in any way except
 * `secrets.GITHUB_TOKEN`: grouping like `(secrets).X` or `toJSON((secrets))`
 * can't then slip past a pattern.
 */
function usesSecrets(s: string): boolean {
  for (const m of s.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const expr = (m[1] as string).replace(
      /\bsecrets\s*\.\s*GITHUB_TOKEN\b/gi,
      "",
    );
    if (/\bsecrets\b/i.test(expr)) return true;
  }
  return false;
}

const reachesKey = (value: unknown): boolean =>
  strings(value).some((s) => KEY_REFERENCE.test(s) || usesSecrets(s)) ||
  (isPlainMap(value) && value.secrets === "inherit");

/**
 * `file#job` for every job that references the release key or could reach
 * it indirectly (`secrets: inherit`, `secrets[...]`, `toJSON(secrets)`), and
 * `file#(workflow)` when the workflow level does. Searched in the parsed
 * values — every `run:` script, `env:` and `with:` value — case-insensitively.
 * A YAML comment is not searched: GitHub never expands one.
 */
export function releaseKeyUsers(workflows: Workflow[]): string[] {
  const users: string[] = [];
  for (const { name, text } of workflows) {
    const { jobs, ...rest } = rootOf(text);
    if (reachesKey(rest)) users.push(`${name}#(workflow)`);
    if (isPlainMap(jobs)) {
      for (const [id, job] of Object.entries(jobs)) {
        if (reachesKey(job)) users.push(`${name}#${id}`);
      }
    }
  }
  return users;
}

const PINNED = /^([\w.-]+\/[\w.-]+)@[0-9a-f]{40}$/;

function actionStepViolations(step: YamlMap, i: number): string[] {
  const problems: string[] = [];
  const where = `step ${i + 1}`;
  for (const key of Object.keys(step)) {
    if (!["uses", "with", "name"].includes(key))
      problems.push(`${where}: ${key} not allowed`);
  }
  const ref = step.uses;
  const action = typeof ref === "string" ? PINNED.exec(ref)?.[1] : undefined;
  const rules = action === undefined ? undefined : SIGN_ACTIONS[action];
  if (rules === undefined) {
    problems.push(`${where}: action not allowed: ${String(ref)}`);
    return problems;
  }
  const inputs = step.with ?? {};
  if (!isPlainMap(inputs)) return [...problems, `${where}: with: is not a map`];
  for (const key of Object.keys(inputs)) {
    if (!rules.allowed.includes(key))
      problems.push(`${where}: ${action} input ${key} not allowed`);
  }
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === "string" && value.includes("${{")) {
      problems.push(`${where}: ${action} input ${key} must be a literal`);
    }
  }
  for (const [key, value] of Object.entries(rules.required)) {
    if (inputs[key] !== value) {
      problems.push(
        `${where}: ${action} needs ${key}: ${JSON.stringify(value)}`,
      );
    }
  }
  if (action === "actions/checkout") {
    const paths =
      typeof inputs["sparse-checkout"] === "string"
        ? inputs["sparse-checkout"]
            .split(/\r?\n/)
            .map((p) => p.trim())
            .filter((p) => p !== "")
        : [];
    if (JSON.stringify(paths.sort()) !== JSON.stringify(SIGN_SPARSE)) {
      problems.push(
        `${where}: sparse-checkout must be exactly ${SIGN_SPARSE.join(", ")}`,
      );
    }
  }
  return problems;
}

function runStepViolations(step: YamlMap, i: number): string[] {
  const problems: string[] = [];
  const where = `step ${i + 1}`;
  for (const key of Object.keys(step)) {
    if (!["run", "env", "name"].includes(key))
      problems.push(`${where}: ${key} not allowed`);
  }
  if (step.run !== SIGN_RUN)
    problems.push(`${where}: run step not allowed: ${String(step.run)}`);
  const env = step.env;
  const keys = isPlainMap(env) ? Object.keys(env) : [];
  if (
    !isPlainMap(env) ||
    keys.length !== 1 ||
    keys[0] !== SIGN_KEY_ENV ||
    env[SIGN_KEY_ENV] !== SIGN_KEY_VALUE
  ) {
    problems.push(
      `${where}: env must be exactly ${SIGN_KEY_ENV}: ${SIGN_KEY_VALUE}`,
    );
  }
  return problems;
}

/**
 * Why the key-holding job is not the minimal one; empty when it is: only
 * `needs`, `runs-on: ubuntu-latest`, `environment` and `steps`; steps are
 * allowlisted actions pinned to a SHA with allowlisted inputs, plus exactly
 * one step that runs SIGN_RUN with only the key in its env.
 */
export function signJobViolations(job: unknown): string[] {
  if (!isPlainMap(job)) return ["the sign job is missing or not a map"];
  const problems: string[] = [];
  for (const key of Object.keys(job)) {
    if (!SIGN_JOB_KEYS.has(key)) problems.push(`job-level ${key} not allowed`);
  }
  if (job.environment !== "release") {
    problems.push(
      `environment must be exactly release, found ${JSON.stringify(job.environment)}`,
    );
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    problems.push(
      `runs-on must be ubuntu-latest, found ${JSON.stringify(job["runs-on"])}`,
    );
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (steps.length === 0) problems.push("no steps");
  let runSteps = 0;
  const actionsSeen = new Set<string>();
  steps.forEach((step: unknown, i: number) => {
    const action =
      isPlainMap(step) && typeof step.uses === "string"
        ? step.uses.split("@")[0]
        : undefined;
    if (action !== undefined) {
      if (actionsSeen.has(action))
        problems.push(`step ${i + 1}: ${action} used twice`);
      actionsSeen.add(action);
    }
    if (!isPlainMap(step)) {
      problems.push(`step ${i + 1}: not a map`);
    } else if ("uses" in step && !("run" in step)) {
      problems.push(...actionStepViolations(step, i));
    } else if ("run" in step && !("uses" in step)) {
      runSteps++;
      problems.push(...runStepViolations(step, i));
    } else {
      problems.push(`step ${i + 1}: needs exactly one of uses or run`);
    }
  });
  if (runSteps !== 1)
    problems.push(`expected exactly one run step, found ${runSteps}`);
  return problems;
}

const LOCAL_WORKFLOW =
  /^[.$]\/\.github\/workflows\/([\w-]+(?:\.[\w-]+)*\.ya?ml)$/;

/**
 * A job-level `uses:` (a reusable workflow) may only name a workflow of this
 * repo that the guards themselves scan: `./` or `$/` + `.github/workflows/`
 * + one of the scanned file names. A remote workflow — even this repo's at
 * another SHA — could hold the `release` environment unseen, since a called
 * workflow's environment resolves against the caller's repo.
 */
export function reusableWorkflowViolations(workflows: Workflow[]): string[] {
  const scanned = new Set(workflows.map((w) => w.name));
  const problems: string[] = [];
  for (const { name, text } of workflows) {
    for (const [id, job] of parseJobs(text)) {
      if (!isPlainMap(job) || !("uses" in job)) continue;
      const file =
        typeof job.uses === "string"
          ? LOCAL_WORKFLOW.exec(job.uses)?.[1]
          : undefined;
      if (file === undefined || !scanned.has(file)) {
        problems.push(
          `${name}#${id}: reusable workflow not allowed: ${String(job.uses)}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Every remote action must use one single ref across all workflows, so the
 * sign job's actions are the same reviewed commits the rest of CI runs (and
 * an impostor SHA in one place stands out). Dependabot bumps them together.
 */
export function actionRefMismatches(workflows: Workflow[]): string[] {
  const refs = new Map<string, Set<string>>();
  for (const { text } of workflows) {
    for (const job of parseJobs(text).values()) {
      if (!isPlainMap(job)) continue;
      const uses = [
        job.uses,
        ...(Array.isArray(job.steps)
          ? job.steps.map((st) => (isPlainMap(st) ? st.uses : undefined))
          : []),
      ];
      for (const ref of uses) {
        if (typeof ref !== "string" || /^[.$]\//.test(ref)) continue;
        const [action = ref] = ref.split("@");
        refs.set(action, (refs.get(action) ?? new Set()).add(ref));
      }
    }
  }
  return [...refs]
    .filter(([, set]) => set.size > 1)
    .map(
      ([action, set]) =>
        `${action} used at ${set.size} refs: ${[...set].join(", ")}`,
    );
}

const DANGEROUS_TRIGGERS = ["pull_request_target", "workflow_run"];

/** Triggers that run a workflow with this repo's secrets on another party's input. */
export function dangerousTriggers(text: string): string[] {
  const on = rootOf(text).on;
  const events =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.map(String)
        : isPlainMap(on)
          ? Object.keys(on)
          : [];
  return events
    .filter((e) => DANGEROUS_TRIGGERS.includes(e))
    .map((e) => `trigger ${e} not allowed`);
}
