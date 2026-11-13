/**
 * The guards in workflow-guards.ts, run on deliberately bad workflow text:
 * each must catch the edit it exists to catch. The cases come from the
 * PR 25 review and its three re-reviews (YAML forms that fooled the earlier
 * regex guards). workflows.test.ts then runs the guards on the real files.
 */
import { describe, expect, test } from "vitest";
import {
  actionRefMismatches,
  dangerousTriggers,
  parseJobs,
  releaseEnvironmentHolders,
  releaseKeyUsers,
  reusableWorkflowViolations,
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
      - name: Sign the tarball
        env:
          HOMEFLEET_RELEASE_KEY: \${{ secrets.HOMEFLEET_RELEASE_KEY }}
          HOMEFLEET_RELEASE_VERSION: \${{ needs.pack.outputs.version }}
          HOMEFLEET_RELEASE_SHA256: \${{ needs.pack.outputs.sha256 }}
          HOMEFLEET_RELEASE_SIZE: \${{ needs.pack.outputs.size }}
        run: ${SIGN_RUN}
      - uses: actions/upload-artifact@${SHA} # v4.6.2
        with:
          name: homefleet-signature
          path: |
            release/homefleet-*.manifest.json
            release/homefleet-*.manifest.sig
          if-no-files-found: error
          retention-days: 1
`;

/**
 * signJobViolations of the `sign` job in `text` (a whole workflow). The text
 * must parse cleanly, so a case proves the check it names instead of passing
 * through a YAML syntax error.
 */
const signOf = (text: string): string => {
  expect(workflowProblems(text), "test YAML must parse cleanly").toEqual([]);
  return signJobViolations(parseJobs(text).get("sign")).join("\n");
};

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
      `        env:\n          HOMEFLEET_RELEASE_KEY: \${{ secrets.HOMEFLEET_RELEASE_KEY }}\n          HOMEFLEET_RELEASE_VERSION: \${{ needs.pack.outputs.version }}\n          HOMEFLEET_RELEASE_SHA256: \${{ needs.pack.outputs.sha256 }}\n          HOMEFLEET_RELEASE_SIZE: \${{ needs.pack.outputs.size }}\n`,
      `        env:\n          { HOMEFLEET_RELEASE_KEY: "\${{ secrets.HOMEFLEET_RELEASE_KEY }}", HOMEFLEET_RELEASE_VERSION: "\${{ needs.pack.outputs.version }}", HOMEFLEET_RELEASE_SHA256: "\${{ needs.pack.outputs.sha256 }}", HOMEFLEET_RELEASE_SIZE: "\${{ needs.pack.outputs.size }}", NODE_OPTIONS: x }\n`,
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
  ])("flags %s", (_label, from, to) => {
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });

  test("a lone CR that hides extra lines from a line-based reader", () => {
    const sneaky = goodSign.replace(
      "        env:\n",
      "        env:\r          NODE_OPTIONS: x\r",
    );
    // YAML reads a lone CR as a line break: the parse or the sign check fails.
    const text = wf(sneaky);
    const caught =
      workflowProblems(text).length > 0 ||
      signJobViolations(parseJobs(text).get("sign")).length > 0;
    expect(caught).toBe(true);
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

// Review loop, round 1.
describe("reusableWorkflowViolations: a job may only call a workflow of this repo that the guards scan", () => {
  const scanned = (calls: string) => [
    { name: "a.yml", text: wf(`  x:\n    uses: ${calls}\n`) },
    { name: "ci.yml", text: wf("  t:\n    runs-on: x\n") },
  ];

  test.each([
    ["./.github/workflows/ci.yml"],
    ["$/.github/workflows/ci.yml"],
  ])("accepts %s", (ref) => {
    expect(reusableWorkflowViolations(scanned(ref))).toEqual([]);
  });

  test.each([
    [`evil/repo/.github/workflows/w.yml@${SHA}`],
    [`Hugodzl/HomeFleet/.github/workflows/w.yml@${SHA}`],
    ["./.github/workflows/unscanned.yml"],
    ["$/.github/workflows/../workflows/ci.yml"],
    ["./other/ci.yml"],
  ])("flags %s", (ref) => {
    expect(reusableWorkflowViolations(scanned(ref)).length).toBeGreaterThan(0);
  });
});

describe("sign job: paths, artifacts and the sparse checkout are pinned", () => {
  test.each([
    [
      "checkout into another path",
      "          path: src\n",
      "          path: other\n",
    ],
    [
      "upload under another name",
      "          name: homefleet-signature\n",
      "          name: other\n",
    ],
    [
      "no sparse checkout at all",
      "          sparse-checkout: |\n            scripts/sign-release.mjs\n            packages/protocol/src/version.ts\n",
      "",
    ],
    [
      "cone mode on",
      "          sparse-checkout-cone-mode: false\n",
      "          sparse-checkout-cone-mode: true\n",
    ],
    [
      "cone mode left to its default",
      "          sparse-checkout-cone-mode: false\n",
      "",
    ],
    [
      "an expression input",
      "          node-version: 22\n",
      `          node-version: \${{ inputs.node }}\n`,
    ],
  ])("flags %s", (_label, from, to) => {
    expect(goodSign).toContain(from);
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });

  test("flags a second checkout step", () => {
    const second = `      - uses: actions/checkout@${SHA} # v4.4.0\n        with:\n          path: other\n          persist-credentials: false\n`;
    expect(
      signOf(
        wf(
          goodSign.replace(
            "      - name: Sign the tarball\n",
            `${second}      - name: Sign the tarball\n`,
          ),
        ),
      ),
    ).not.toBe("");
  });
});

test("releaseKeyUsers finds secrets.* (every secret at once)", () => {
  expect(
    releaseKeyUsers([
      {
        name: "a.yml",
        text: wf(
          `  x:\n    steps:\n      - run: echo "\${{ join(secrets.*, ',') }}"\n`,
        ),
      },
    ]),
  ).toEqual(["a.yml#x"]);
});

// Review loop, round 2.
describe("characters where YAML parsers disagree on line breaks are rejected", () => {
  test.each([
    ["NEL U+0085", "\u0085"],
    ["LS U+2028", "\u2028"],
    ["PS U+2029", "\u2029"],
    ["a C0 control", "\u0007"],
    ["a C1 control", "\u0090"],
    ["a bidi override", "\u202E"],
    ["a bidi isolate", "\u2066"],
    ["a BOM after the start", "\uFEFF"],
  ])("flags %s", (_label, ch) => {
    const text = wf(goodSign).replace(
      "      - name: Sign the tarball\n",
      `      - name: Sign the tarball # x${ch}        shell: npx -y evil {0}\n`,
    );
    expect(workflowProblems(text).length).toBeGreaterThan(0);
  });

  test("ordinary non-ASCII text in comments is fine", () => {
    expect(
      workflowProblems(
        wf(`${goodSign}  b: # gate — then pack…\n    runs-on: x\n`),
      ),
    ).toEqual([]);
  });
});

describe("releaseKeyUsers: any secrets use in an expression outside sign counts", () => {
  test.each([
    ["parentheses", `\${{ (secrets).HOMEFLEET_RELEASE_KEY }}`],
    ["toJSON with parentheses", `\${{ toJSON((secrets)) }}`],
    ["another secret name", `\${{ secrets.OTHER }}`],
    ["upper case", `\${{ SECRETS.HOMEFLEET_RELEASE_KEY }}`],
  ])("finds %s", (_label, expr) => {
    expect(
      releaseKeyUsers([
        { name: "a.yml", text: wf(`  x:\n    env:\n      K: "${expr}"\n`) },
      ]),
    ).toEqual(["a.yml#x"]);
  });

  test("secrets.GITHUB_TOKEN alone is allowed", () => {
    expect(
      releaseKeyUsers([
        {
          name: "a.yml",
          text: wf(`  x:\n    env:\n      K: "\${{ secrets.GITHUB_TOKEN }}"\n`),
        },
      ]),
    ).toEqual([]);
  });
});

describe("sign job: environment and upload are pinned", () => {
  test.each([
    [
      "an expression environment",
      "    environment: release\n",
      `    environment: \${{ needs.pack.outputs.e }}\n`,
    ],
    [
      "an environment map with a url",
      "    environment: release\n",
      "    environment:\n      name: release\n      url: https://x\n",
    ],
    [
      "uploading src",
      "            release/homefleet-*.manifest.sig\n",
      "            src\n",
    ],
    [
      "upload not failing on no files",
      "          if-no-files-found: error\n",
      "          if-no-files-found: warn\n",
    ],
  ])("flags %s", (_label, from, to) => {
    expect(goodSign).toContain(from);
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });
});

describe("actionRefMismatches: one ref per action across all workflows", () => {
  const OTHER = "1111111111111111111111111111111111111111";
  test("the same ref everywhere passes", () => {
    expect(
      actionRefMismatches([
        { name: "a.yml", text: wf(goodSign) },
        {
          name: "b.yml",
          text: wf(`  c:\n    steps:\n      - uses: actions/checkout@${SHA}\n`),
        },
      ]),
    ).toEqual([]);
  });

  test("an action at two different SHAs is flagged", () => {
    expect(
      actionRefMismatches([
        { name: "a.yml", text: wf(goodSign) },
        {
          name: "b.yml",
          text: wf(
            `  c:\n    steps:\n      - uses: actions/checkout@${OTHER}\n`,
          ),
        },
      ]).length,
    ).toBeGreaterThan(0);
  });
});

describe("dangerousTriggers", () => {
  test.each([
    ["pull_request_target", "on:\n  pull_request_target:\n"],
    ["workflow_run", "on:\n  workflow_run:\n    workflows: [x]\n"],
    ["a list form", "on: [push, pull_request_target]\n"],
    ["a string form", "on: workflow_run\n"],
  ])("flags %s", (_label, on) => {
    expect(
      dangerousTriggers(`name: x\n${on}jobs:\n  a:\n    runs-on: x\n`).length,
    ).toBeGreaterThan(0);
  });

  test("push, pull_request and workflow_dispatch are fine", () => {
    expect(
      dangerousTriggers(
        "name: x\non:\n  push:\n  pull_request:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: x\n",
      ),
    ).toEqual([]);
  });
});

// Review loop, round 3.
test("releaseKeyUsers is not fooled by '}}' inside a quoted string", () => {
  expect(
    releaseKeyUsers([
      {
        name: "a.yml",
        text: wf(
          `  x:\n    steps:\n      - run: echo "\${{ format('}}', (secrets).HOMEFLEET_RELEASE_KEY) }}"\n`,
        ),
      },
    ]),
  ).toEqual(["a.yml#x"]);
});

describe("sign job: no expression anywhere but the one pinned key value", () => {
  test.each([
    [
      "the sign step's name",
      "      - name: Sign the tarball\n",
      `      - name: "\${{ toJSON(secrets) }}"\n`,
    ],
    [
      "an action step's name",
      `      - uses: actions/upload-artifact@${SHA} # v4.6.2\n`,
      `      - name: "\${{ secrets.HOMEFLEET_RELEASE_KEY }}"\n        uses: actions/upload-artifact@${SHA} # v4.6.2\n`,
    ],
  ])("flags an expression in %s", (_label, from, to) => {
    expect(goodSign).toContain(from);
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });

  test.each([
    ["nightly"],
    ["latest"],
    ["node"],
    ["24-nightly"],
  ])("flags node-version %s", (version) => {
    expect(
      signOf(
        wf(
          goodSign.replace(
            "          node-version: 22\n",
            `          node-version: ${version}\n`,
          ),
        ),
      ),
    ).not.toBe("");
  });

  test("flags a missing node-version", () => {
    expect(
      signOf(wf(goodSign.replace("          node-version: 22\n", ""))),
    ).not.toBe("");
  });

  test("flags an upload glob that would carry extra unsigned files", () => {
    expect(
      signOf(
        wf(
          goodSign.replace(
            "          path: |\n            release/homefleet-*.manifest.json\n            release/homefleet-*.manifest.sig\n",
            "          path: release/homefleet-*\n",
          ),
        ),
      ),
    ).not.toBe("");
  });
});

test("the replacement character from undecodable bytes is rejected", () => {
  expect(
    workflowProblems(wf(`${goodSign}  b: # x\uFFFD\n    runs-on: x\n`)).length,
  ).toBeGreaterThan(0);
});

// Review loop, round 4: the sign job handles no file at all.
describe("sign job signs a digest and downloads nothing", () => {
  test("flags any download-artifact step", () => {
    const download = `      - uses: actions/download-artifact@${SHA} # v4.3.0\n        with:\n          name: homefleet-tarball\n          path: release\n`;
    expect(
      signOf(
        wf(
          goodSign.replace(
            "      - name: Sign the tarball\n",
            `${download}      - name: Sign the tarball\n`,
          ),
        ),
      ),
    ).not.toBe("");
  });

  test.each([
    [
      "a digest taken from elsewhere",
      "needs.pack.outputs.sha256",
      "github.event.inputs.sha256",
    ],
    [
      "a missing digest variable",
      `          HOMEFLEET_RELEASE_SIZE: \${{ needs.pack.outputs.size }}\n`,
      "",
    ],
    ["needs other than pack", "    needs: pack\n", "    needs: [pack, gate]\n"],
  ])("flags %s", (_label, from, to) => {
    expect(goodSign).toContain(from);
    expect(signOf(wf(goodSign.replace(from, to)))).not.toBe("");
  });
});

test("the long-s spelling of secrets is still found", () => {
  expect(
    releaseKeyUsers([
      {
        name: "a.yml",
        text: wf(
          `  x:\n    env:\n      K: "\${{ \u017Fecrets.HOMEFLEET_RELEASE_KEY }}"\n`,
        ),
      },
    ]),
  ).toEqual(["a.yml#x"]);
});

test("a BOM at the very start is fine, a second one is not", () => {
  expect(workflowProblems(`\uFEFF${wf(goodSign)}`)).toEqual([]);
  expect(
    workflowProblems(`\uFEFF\uFEFF${wf(goodSign)}`).length,
  ).toBeGreaterThan(0);
});

test("sign's signature upload must expire after a day", () => {
  expect(
    signOf(wf(goodSign.replace("          retention-days: 1\n", ""))),
  ).not.toBe("");
  expect(
    signOf(
      wf(
        goodSign.replace(
          "          retention-days: 1\n",
          "          retention-days: 90\n",
        ),
      ),
    ),
  ).not.toBe("");
});
