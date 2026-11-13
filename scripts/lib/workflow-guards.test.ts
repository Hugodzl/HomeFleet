/**
 * The guards in workflow-guards.ts, run on deliberately bad workflow text:
 * each must catch the edit it exists to catch. The cases come from the
 * PR 25 review and its three re-reviews (YAML forms that fooled the earlier
 * regex guards). workflows.test.ts then runs the guards on the real files.
 */
import { describe, expect, test } from "vitest";
import {
  parseJobs,
  releaseEnvironmentHolders,
  releaseKeyUsers,
  SIGN_RUN,
  signJobViolations,
  topLevelPermissions,
  workflowLevelViolations,
  workflowProblems,
} from "./workflow-guards.js";

const wf = (jobs: string, top = "permissions:\n  contents: read\n") =>
  `name: x\non: push\n${top}jobs:\n${jobs}`;

const SHA = "0000000000000000000000000000000000000000";

const goodSign = `  sign:
    needs: pack
    runs-on: ubuntu-latest
    environment: release
    steps:
      - uses: actions/checkout@${SHA} # v4.4.0
        with:
          sparse-checkout: |
            scripts/sign-release.mjs
            packages/protocol/src/version.ts
          sparse-checkout-cone-mode: false
          path: src
          persist-credentials: false
      - uses: actions/setup-node@${SHA} # v7.1.0
        with:
          node-version: 22
          package-manager-cache: false
      - uses: actions/download-artifact@${SHA} # v4.3.0
        with:
          name: homefleet-tarball
          path: release
      - name: Sign the tarball
        env:
          HOMEFLEET_RELEASE_KEY: \${{ secrets.HOMEFLEET_RELEASE_KEY }}
        run: ${SIGN_RUN}
      - uses: actions/upload-artifact@${SHA} # v4.6.2
        with:
          name: homefleet-release
          path: release/homefleet-*
          if-no-files-found: error
`;

/** signJobViolations of the `sign` job in `text` (a whole workflow). */
const signOf = (text: string): string =>
  signJobViolations(parseJobs(text).get("sign")).join("\n");

const holders = (text: string) =>
  releaseEnvironmentHolders([{ name: "a.yml", text }]);

describe("workflowProblems: only plain, parseable YAML is accepted", () => {
  test("the intended layout passes", () => {
    expect(workflowProblems(wf(goodSign))).toEqual([]);
  });

  test.each([
    ["a syntax error", "on: push\njobs:\n  a: [\n"],
    [
      "a duplicate key",
      "on: push\njobs:\n  a:\n    runs-on: x\n    runs-on: y\n",
    ],
    [
      "an anchor and alias",
      "on: push\njobs:\n  a: &j\n    runs-on: x\n  b: *j\n",
    ],
    ["a merge key", "on: push\njobs:\n  a:\n    <<: {runs-on: x}\n"],
    ["a tag", "on: push\njobs:\n  a:\n    environment: !!str release\n"],
    ["no jobs map", "on: push\njobs: []\n"],
    ["a root that is not a map", "- a\n"],
  ])("flags %s", (_label, text) => {
    expect(workflowProblems(text).length).toBeGreaterThan(0);
  });
});

describe("releaseEnvironmentHolders", () => {
  test.each([
    ["the one-line form", "    environment: release\n"],
    ["a quoted value", "    environment: 'release'\n"],
    ["a trailing comment", "    environment: release # RC\n"],
    ["a capital letter", "    environment: Release\n"],
    ["a name: block", "    environment:\n      name: release\n      url: x\n"],
    ["a one-line map", "    environment: { name: release }\n"],
    ["a multi-line flow map", "    environment: {\n      name: release }\n"],
    ["a space before the colon", "    environment : release\n"],
    ["a quoted key", '    "environment": release\n'],
    ["an expression", `    environment: \${{ inputs.env }}\n`],
    [
      "an expression name",
      `    environment:\n      name: \${{ inputs.env }}\n`,
    ],
    ["a map without a name", "    environment:\n      url: x\n"],
  ])("finds %s", (_label, env) => {
    expect(holders(wf(`  x:\n${env}    runs-on: x\n`))).toEqual(["a.yml#x"]);
  });

  test("finds a second job whose id is quoted or spaced", () => {
    for (const id of ['"leak":', "leak :"]) {
      const text = wf(
        `${goodSign}  ${id}\n    runs-on: x\n    environment: release\n`,
      );
      expect(holders(text).sort()).toEqual(["a.yml#leak", "a.yml#sign"]);
    }
  });

  test("ignores other environments", () => {
    expect(holders(wf("  x:\n    environment: releases\n"))).toEqual([]);
  });
});

describe("releaseKeyUsers", () => {
  const users = (jobs: string, top?: string) =>
    releaseKeyUsers([{ name: "a.yml", text: wf(jobs, top) }]).sort();

  test("names every job that references the key, or inherits secrets", () => {
    const jobs =
      `${goodSign}  leak:\n    steps:\n      - env:\n          K: \${{ secrets.homefleet_release_key }}\n` +
      "  inherit:\n    uses: $/.github/workflows/x.yml\n    secrets: inherit\n" +
      `  dyn:\n    steps:\n      - run: echo \${{ toJSON(secrets) }}\n` +
      `  idx:\n    steps:\n      - run: echo \${{ secrets['HOMEFLEET_RELEASE_KEY'] }}\n`;
    expect(users(jobs)).toEqual([
      "a.yml#dyn",
      "a.yml#idx",
      "a.yml#inherit",
      "a.yml#leak",
      "a.yml#sign",
    ]);
  });

  test("finds a reference on a # line inside a run: | script", () => {
    expect(
      users(
        `  x:\n    steps:\n      - run: |\n          # \${{ secrets.HOMEFLEET_RELEASE_KEY }}\n`,
      ),
    ).toEqual(["a.yml#x"]);
  });

  test("finds a workflow-level reference", () => {
    expect(
      users(
        "  x:\n    runs-on: y\n",
        `permissions:\n  contents: read\nenv:\n  K: \${{ secrets.HOMEFLEET_RELEASE_KEY }}\n`,
      ),
    ).toEqual(["a.yml#(workflow)"]);
  });

  test("a YAML comment is not a reference (GitHub never expands it)", () => {
    expect(
      users(`  x:\n    runs-on: y # \${{ secrets.HOMEFLEET_RELEASE_KEY }}\n`),
    ).toEqual([]);
  });
});

describe("signJobViolations", () => {
  test("the intended job passes", () => {
    expect(signOf(wf(goodSign))).toBe("");
  });

  test("a missing job is a violation", () => {
    expect(signJobViolations(undefined).length).toBeGreaterThan(0);
  });

  const withStep = (step: string) =>
    signOf(
      wf(
        goodSign.replace(
          "      - name: Sign the tarball\n",
          `${step}      - name: Sign the tarball\n`,
        ),
      ),
    );

  test.each([
    ["npx", "      - run: npx something\n"],
    ["a multi-line run", "      - run: |\n          node x.mjs\n"],
    ["a run with a space before the colon", "      - run : curl x | sh\n"],
    ["a third-party action", `      - uses: evil/action@${SHA}\n`],
    ["a local action", "      - uses: ./.github/actions/x\n"],
    ["a self-repository action", "      - uses: $/.github/actions/x\n"],
    [
      "a uses with a space before the colon",
      `      - uses : evil/action@${SHA}\n`,
    ],
    ["an unpinned allowed action", "      - uses: actions/checkout@v4\n"],
  ])("flags an extra step: %s", (_label, step) => {
    expect(withStep(step)).not.toBe("");
  });

  test.each([
    ["a shell: override", "        shell: npx -y evil {0}\n"],
    ["a working-directory", "        working-directory: /tmp\n"],
    ["an if:", "        if: always()\n"],
  ])("flags %s on the sign step", (_label, extra) => {
    expect(
      signOf(wf(goodSign.replace("        run: ", `${extra}        run: `))),
    ).not.toBe("");
  });

  test.each([
    [
      "a step-level extra env var",
      "          HOMEFLEET_RELEASE_KEY:",
      "          NODE_OPTIONS: --require ./x.js\n          HOMEFLEET_RELEASE_KEY:",
    ],
    [
      "a spaced env key",
      "          HOMEFLEET_RELEASE_KEY:",
      "          NODE_OPTIONS : x\n          HOMEFLEET_RELEASE_KEY:",
    ],
    [
      "a flow-map env",
      `        env:\n          HOMEFLEET_RELEASE_KEY: \${{ secrets.HOMEFLEET_RELEASE_KEY }}\n`,
      `        env:\n          { HOMEFLEET_RELEASE_KEY: \${{ secrets.HOMEFLEET_RELEASE_KEY }}, NODE_OPTIONS: x }\n`,
    ],
    [
      "a key taken from somewhere else",
      `\${{ secrets.HOMEFLEET_RELEASE_KEY }}`,
      `\${{ github.event.inputs.key }}`,
    ],
    [
      "a different command",
      `        run: ${SIGN_RUN}\n`,
      `        run: ${SIGN_RUN} --key-file /tmp/k\n`,
    ],
  ])("flags %s", (_label, from, to) => {
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });

  test.each([
    [
      "a job-level env",
      "    steps:\n",
      "    env:\n      NODE_OPTIONS: x\n    steps:\n",
    ],
    [
      "a self-hosted runner",
      "runs-on: ubuntu-latest",
      "runs-on: [self-hosted, evil]",
    ],
    ["a container", "    steps:\n", "    container: node:22\n    steps:\n"],
    [
      "services",
      "    steps:\n",
      "    services:\n      db:\n        image: x\n    steps:\n",
    ],
    [
      "defaults",
      "    steps:\n",
      "    defaults:\n      run:\n        shell: bash\n    steps:\n",
    ],
    [
      "a strategy matrix",
      "    steps:\n",
      "    strategy:\n      matrix:\n        x: [1]\n    steps:\n",
    ],
  ])("flags %s", (_label, from, to) => {
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });

  test.each([
    [
      "checkout repository:",
      "          path: src\n",
      "          path: src\n          repository: evil/fork\n",
    ],
    [
      "checkout ref:",
      "          path: src\n",
      "          path: src\n          ref: some-branch\n",
    ],
    [
      "checkout token:",
      "          path: src\n",
      "          path: src\n          token: x\n",
    ],
    [
      "checkout persisted credentials",
      "          persist-credentials: false\n",
      "          persist-credentials: true\n",
    ],
    [
      "a third sparse path",
      "            packages/protocol/src/version.ts\n",
      "            packages/protocol/src/version.ts\n            node_modules\n",
    ],
    [
      "setup-node with a cache",
      "          package-manager-cache: false\n",
      "          package-manager-cache: false\n          cache: npm\n",
    ],
    [
      "setup-node cache left on",
      "          package-manager-cache: false\n",
      "          package-manager-cache: 'false'\n",
    ],
    [
      "setup-node mirror-token",
      "          node-version: 22\n",
      "          node-version: 22\n          mirror-token: x\n",
    ],
    [
      "download from another run",
      "          name: homefleet-tarball\n",
      "          name: homefleet-tarball\n          run-id: 1\n          github-token: x\n",
    ],
  ])("flags %s", (_label, from, to) => {
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });

  test("a lone CR that hides extra lines from a line-based reader", () => {
    const sneaky = goodSign.replace(
      "        env:\n",
      "        env:\r          NODE_OPTIONS: x\r",
    );
    expect(signOf(wf(sneaky))).not.toBe("");
  });

  test("a block-scalar step name does not hide the keys after it", () => {
    const job = goodSign.replace(
      "      - name: Sign the tarball\n",
      "      - name: |\n          Sign\n        shell: bash\n",
    );
    expect(signOf(wf(job))).not.toBe("");
  });
});

describe("topLevelPermissions", () => {
  test("returns the parsed block", () => {
    expect(topLevelPermissions(wf(""))).toEqual({ contents: "read" });
  });

  test("an added write scope shows up, blank lines and comments or not", () => {
    expect(
      topLevelPermissions(
        wf(
          "",
          "permissions:\n  contents: read\n\n  # later\n  packages: write\n",
        ),
      ),
    ).toEqual({ contents: "read", packages: "write" });
  });

  test("the one-line forms and a missing block", () => {
    expect(topLevelPermissions(wf("", "permissions: write-all\n"))).toBe(
      "write-all",
    );
    expect(topLevelPermissions(wf("", ""))).toBeUndefined();
  });
});

test("parseJobs returns the parsed jobs, whatever their key quoting", () => {
  expect([
    ...parseJobs(wf(`${goodSign}  "b":\n    runs-on: x\n`)).keys(),
  ]).toEqual(["sign", "b"]);
});

describe("workflowLevelViolations: nothing at the top level may reach every job", () => {
  test("the intended preamble passes", () => {
    expect(
      workflowLevelViolations(
        wf(
          goodSign,
          "permissions:\n  contents: read\nconcurrency:\n  group: x\n",
        ),
      ),
    ).toEqual([]);
  });

  test.each([
    [
      "a workflow-level env",
      "permissions:\n  contents: read\nenv:\n  NODE_OPTIONS: x\n",
    ],
    [
      "workflow-level defaults",
      "permissions:\n  contents: read\ndefaults:\n  run:\n    shell: bash\n",
    ],
  ])("flags %s", (_label, top) => {
    expect(workflowLevelViolations(wf(goodSign, top)).length).toBeGreaterThan(
      0,
    );
  });
});
