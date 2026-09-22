/**
 * Rewrites `@homefleet/daemon`'s package.json into the manifest shipped in
 * the release tarball (S1 spec §2). Pure: no I/O, so every rule is unit-tested.
 */

export const PUBLISH_NAME = "homefleet";
export const REPOSITORY_URL = "git+https://github.com/Hugodzl/HomeFleet.git";

export interface DaemonPackageJson {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type?: string;
  engines?: { node?: string };
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface PublishManifest {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type: "module";
  engines: { node: string };
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  repository: { type: "git"; url: string };
}

export function buildPublishManifest(pkg: DaemonPackageJson): PublishManifest {
  if (pkg.type !== "module") {
    throw new Error(
      `${pkg.name} must declare "type": "module" — its bins are ESM .js files`,
    );
  }
  const node = pkg.engines?.node;
  if (node === undefined) {
    throw new Error(`${pkg.name} must declare engines.node`);
  }

  // WHY drop @homefleet/*: tsup's noExternal bundles every first-party
  // workspace package into the bins, so they are not runtime deps.
  const dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).filter(
      ([name]) => !name.startsWith("@homefleet/"),
    ),
  );
  // Asserted, not assumed: anything still pointing into the workspace would
  // be unresolvable from the registry at install time.
  for (const [name, spec] of Object.entries(dependencies)) {
    if (spec.startsWith("workspace:")) {
      throw new Error(
        `dependency ${name}@${spec} is a workspace dep but not @homefleet/* — tsup does not bundle it`,
      );
    }
  }

  const bin = Object.fromEntries(
    Object.entries(pkg.bin).map(([name, target]) => [
      name,
      target.replace(/^\.\//, ""),
    ]),
  );

  return {
    name: PUBLISH_NAME,
    version: pkg.version,
    ...(pkg.description === undefined ? {} : { description: pkg.description }),
    ...(pkg.license === undefined ? {} : { license: pkg.license }),
    type: "module",
    engines: { node },
    bin,
    files: ["dist/bin"],
    dependencies,
    repository: { type: "git", url: REPOSITORY_URL },
  };
}
