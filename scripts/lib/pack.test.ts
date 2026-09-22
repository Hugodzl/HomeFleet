import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { packRelease, parsePackReport } from "./pack.js";

describe("parsePackReport", () => {
  test("reads filename and file paths from npm pack --json", () => {
    const stdout = JSON.stringify([
      {
        filename: "homefleet-1.2.3.tgz",
        files: [{ path: "package.json" }, { path: "dist/bin/homefleet.js" }],
      },
    ]);
    expect(parsePackReport(stdout)).toEqual({
      filename: "homefleet-1.2.3.tgz",
      files: ["package.json", "dist/bin/homefleet.js"],
    });
  });

  test("tolerates noise before the JSON array", () => {
    const stdout = `npm notice something\n${JSON.stringify([
      { filename: "x-1.0.0.tgz", files: [] },
    ])}`;
    expect(parsePackReport(stdout).filename).toBe("x-1.0.0.tgz");
  });

  test("fails loud on an unexpected shape", () => {
    expect(() => parsePackReport("[]")).toThrow(/npm pack/);
    expect(() => parsePackReport("not json")).toThrow(/npm pack/);
  });
});

describe("packRelease fail-loud checks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-pack-unit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses to stage when a built bin is missing", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@homefleet/daemon",
        version: "1.2.3",
        type: "module",
        engines: { node: ">=20" },
        bin: { homefleet: "./dist/bin/homefleet.js" },
      }),
    );
    await writeFile(path.join(dir, "LICENSE"), "license");
    await expect(
      packRelease({
        daemonDir: dir,
        licensePath: path.join(dir, "LICENSE"),
        outDir: path.join(dir, "out"),
        build: false,
      }),
    ).rejects.toThrow(/missing built bin .*homefleet\.js/);
  });

  test("checks for the built bin under a custom distDir, not daemonDir/dist/bin", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@homefleet/daemon",
        version: "1.2.3",
        type: "module",
        engines: { node: ">=20" },
        bin: { homefleet: "./dist/bin/homefleet.js" },
      }),
    );
    await writeFile(path.join(dir, "LICENSE"), "license");
    const distDir = path.join(dir, "private-dist");
    await expect(
      packRelease({
        daemonDir: dir,
        licensePath: path.join(dir, "LICENSE"),
        outDir: path.join(dir, "out"),
        distDir,
        build: false,
      }),
    ).rejects.toThrow(
      new RegExp(
        `missing built bin .*${"private-dist".replace(/\\/g, "\\\\")}.*homefleet\\.js`,
      ),
    );
  });
});
