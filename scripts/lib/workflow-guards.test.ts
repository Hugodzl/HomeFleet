/**
 * The guards in workflow-guards.ts, run on deliberately bad workflow text:
 * each must catch the edit it exists to catch (PR 25 review, findings 1–3).
 * workflows.test.ts then runs them on the real .github/workflows files.
 */
import { describe, expect, test } from "vitest";
import {
  parseJobs,
  releaseEnvironmentHolders,
  releaseKeyUsers,
  SIGN_RUN,
  signJobViolations,
  topLevelPermissions,
} from "./workflow-guards.js";

const wf = (jobs: string, top = "permissions:\n  contents: read\n") =>
  `name: x\non: push\n${top}jobs:\n${jobs}`;

const goodSign = `  sign:
    runs-on: ubuntu-latest
    environment: release
    steps:
      - uses: actions/checkout@0000000000000000000000000000000000000000 # v4.4.0
        with:
          persist-credentials: false
      - uses: actions/setup-node@0000000000000000000000000000000000000000 # v7.1.0
        with:
          node-version: 22
          package-manager-cache: false
      - uses: actions/download-artifact@0000000000000000000000000000000000000000 # v4.3.0
      - name: Sign the tarball
        env:
          HOMEFLEET_RELEASE_KEY: \${{ secrets.HOMEFLEET_RELEASE_KEY }}
        run: ${SIGN_RUN}
      - uses: actions/upload-artifact@0000000000000000000000000000000000000000 # v4.6.2
`;

describe("releaseEnvironmentHolders", () => {
  test("finds the one-line and the name: forms, in every file", () => {
    const holders = releaseEnvironmentHolders([
      { name: "release.yml", text: wf(goodSign) },
      {
        name: "rc.yml",
        text: wf(
          "  other:\n    environment:\n      name: release\n      url: x\n    runs-on: x\n",
        ),
      },
      {
        name: "q.yml",
        text: wf("  quoted:\n    environment: 'release'\n    runs-on: x\n"),
      },
    ]);
    expect(holders.sort()).toEqual([
      "q.yml#quoted",
      "rc.yml#other",
      "release.yml#sign",
    ]);
  });

  test("ignores other environments", () => {
    expect(
      releaseEnvironmentHolders([
        { name: "a.yml", text: wf("  x:\n    environment: releases\n") },
      ]),
    ).toEqual([]);
  });
});

describe("releaseKeyUsers", () => {
  test("names every job that references the key, or inherits secrets", () => {
    const users = releaseKeyUsers([
      { name: "release.yml", text: wf(goodSign) },
      {
        name: "b.yml",
        text: wf(
          `  leak:\n    steps:\n      - env:\n          K: \${{ secrets.HOMEFLEET_RELEASE_KEY }}\n` +
            "  inherit:\n    uses: $/.github/workflows/x.yml\n    secrets: inherit\n" +
            `  dyn:\n    steps:\n      - run: echo \${{ toJSON(secrets) }}\n`,
        ),
      },
    ]);
    expect(users.sort()).toEqual([
      "b.yml#dyn",
      "b.yml#inherit",
      "b.yml#leak",
      "release.yml#sign",
    ]);
  });
});

describe("signJobViolations", () => {
  test("the intended job passes", () => {
    expect(signJobViolations(goodSign)).toEqual([]);
  });

  test.each([
    ["npx", "        run: npx something\n"],
    ["pnpm dlx", "        run: pnpm dlx x\n"],
    ["yarn", "        run: yarn\n"],
    ["bun", "        run: bun x\n"],
    ["corepack", "        run: corepack enable\n"],
    ["a multi-line run", "        run: |\n          node x.mjs\n"],
  ])("flags an extra run step (%s)", (_label, run) => {
    const job = `${goodSign}      - name: extra\n${run}`;
    expect(signJobViolations(job).join("\n")).toMatch(/run/);
  });

  test("flags a third-party or local action", () => {
    for (const uses of [
      "evil/action@0000000000000000000000000000000000000000 # v1",
      "$/.github/actions/x",
      "./.github/actions/x",
    ]) {
      expect(
        signJobViolations(`${goodSign}      - uses: ${uses}\n`).join("\n"),
      ).toMatch(/action/);
    }
  });

  test("flags a dependency cache or a missing package-manager-cache: false", () => {
    expect(
      signJobViolations(
        goodSign.replace("package-manager-cache: false", "cache: npm"),
      ).join("\n"),
    ).toMatch(/cache/);
  });

  test("flags a container or services", () => {
    for (const extra of [
      "    container: node:22\n",
      "    services:\n      db:\n        image: x\n",
    ]) {
      const job = goodSign.replace(
        "    runs-on: ubuntu-latest\n",
        `    runs-on: ubuntu-latest\n${extra}`,
      );
      expect(signJobViolations(job).join("\n")).toMatch(/container|services/);
    }
  });
});

describe("topLevelPermissions", () => {
  test("returns the block's lines", () => {
    expect(topLevelPermissions(wf(""))).toEqual(["contents: read"]);
  });

  test("an added write scope shows up", () => {
    expect(
      topLevelPermissions(
        wf("", "permissions:\n  contents: read\n  packages: write\n"),
      ),
    ).toEqual(["contents: read", "packages: write"]);
  });

  test("the one-line forms and a missing block", () => {
    expect(topLevelPermissions(wf("", "permissions: write-all\n"))).toEqual([
      "write-all",
    ]);
    expect(topLevelPermissions(wf("", ""))).toEqual([]);
  });
});

test("parseJobs splits jobs at 2-space keys under jobs:", () => {
  expect([
    ...parseJobs(wf(`${goodSign}  b:\n    runs-on: x\n`)).keys(),
  ]).toEqual(["sign", "b"]);
});
