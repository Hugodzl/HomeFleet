import { describe, expect, test } from "vitest";
import {
  buildPublishManifest,
  type DaemonPackageJson,
  REPOSITORY_URL,
} from "./publish-manifest.js";

function daemonPkg(
  overrides: Partial<DaemonPackageJson> = {},
): DaemonPackageJson {
  return {
    name: "@homefleet/daemon",
    version: "1.2.3",
    description: "homefleetd",
    license: "Apache-2.0",
    type: "module",
    engines: { node: ">=20" },
    exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
    bin: {
      homefleet: "./dist/bin/homefleet.js",
      "homefleet-mcp-stdio": "./dist/bin/homefleet-mcp-stdio.js",
      homefleetd: "./dist/bin/homefleetd.js",
    },
    scripts: { build: "tsup", typecheck: "tsc --noEmit" },
    dependencies: {
      "@homefleet/executors": "workspace:*",
      "@homefleet/protocol": "workspace:*",
      "@peculiar/x509": "^2.0.0",
      zod: "^4.4.3",
    },
    ...overrides,
  };
}

describe("buildPublishManifest", () => {
  test("renames to homefleet and keeps version/description/license/type/engines", () => {
    const m = buildPublishManifest(daemonPkg());
    expect(m).toMatchObject({
      name: "homefleet",
      version: "1.2.3",
      description: "homefleetd",
      license: "Apache-2.0",
      type: "module",
      engines: { node: ">=20" },
    });
  });

  test("drops workspace deps (bundled by tsup), keeps third-party deps", () => {
    expect(buildPublishManifest(daemonPkg()).dependencies).toEqual({
      "@peculiar/x509": "^2.0.0",
      zod: "^4.4.3",
    });
  });

  test("normalizes bin paths (no leading ./)", () => {
    expect(buildPublishManifest(daemonPkg()).bin).toEqual({
      homefleet: "dist/bin/homefleet.js",
      "homefleet-mcp-stdio": "dist/bin/homefleet-mcp-stdio.js",
      homefleetd: "dist/bin/homefleetd.js",
    });
  });

  test("ships only dist/bin, adds repository, drops exports and scripts", () => {
    const m = buildPublishManifest(daemonPkg());
    expect(m.files).toEqual(["dist/bin"]);
    expect(m.repository).toEqual({ type: "git", url: REPOSITORY_URL });
    expect(m).not.toHaveProperty("exports");
    expect(m).not.toHaveProperty("scripts");
  });

  test("refuses a non-ESM package (the bins are ESM .js)", () => {
    expect(() => buildPublishManifest(daemonPkg({ type: undefined }))).toThrow(
      /"type": "module"/,
    );
  });

  test("refuses a package with no engines.node", () => {
    expect(() =>
      buildPublishManifest(daemonPkg({ engines: undefined })),
    ).toThrow(/engines\.node/);
  });

  test("fails loud on a non-@homefleet workspace dep (it would not be bundled)", () => {
    expect(() =>
      buildPublishManifest(
        daemonPkg({ dependencies: { "some-local-lib": "workspace:*" } }),
      ),
    ).toThrow(/some-local-lib/);
  });
});
