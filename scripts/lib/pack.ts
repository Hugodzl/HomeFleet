/**
 * Build → check → stage → `npm pack` for the release tarball (S1 spec §2).
 */
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPublishManifest,
  type DaemonPackageJson,
  type PublishManifest,
} from "./publish-manifest.js";

export interface PackOptions {
  /** `packages/daemon` */
  daemonDir: string;
  licensePath: string;
  /** Wiped and recreated on every run. */
  stagingDir: string;
  /** Where `homefleet-<version>.tgz` lands. */
  outDir: string;
  /** Run the daemon's tsup build first (off only for unit tests). */
  build: boolean;
}

export interface PackResult {
  tarballPath: string;
  /** Paths inside the tarball, sorted. */
  files: string[];
  manifest: PublishManifest;
}

export async function packRelease(options: PackOptions): Promise<PackResult> {
  const daemonPkg = JSON.parse(
    await readFile(path.join(options.daemonDir, "package.json"), "utf8"),
  ) as DaemonPackageJson;
  const manifest = buildPublishManifest(daemonPkg);

  if (options.build) {
    run("pnpm", ["--filter", daemonPkg.name, "build"], options.daemonDir);
  }

  for (const binPath of Object.values(manifest.bin)) {
    const absolute = path.join(options.daemonDir, binPath);
    try {
      await access(absolute);
    } catch {
      throw new Error(
        `pack-release: missing built bin ${absolute} — run the daemon build first`,
      );
    }
  }

  await rm(options.stagingDir, { recursive: true, force: true });
  await mkdir(path.join(options.stagingDir, "dist"), { recursive: true });
  await cp(
    path.join(options.daemonDir, "dist", "bin"),
    path.join(options.stagingDir, "dist", "bin"),
    { recursive: true },
  );
  await cp(options.licensePath, path.join(options.stagingDir, "LICENSE"));
  await writeFile(
    path.join(options.stagingDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await mkdir(options.outDir, { recursive: true });
  const report = parsePackReport(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", options.outDir],
      options.stagingDir,
    ),
  );
  return {
    tarballPath: path.join(options.outDir, report.filename),
    files: [...report.files].sort(),
    manifest,
  };
}

export function parsePackReport(stdout: string): {
  filename: string;
  files: string[];
} {
  const start = stdout.indexOf("[");
  let parsed: unknown;
  try {
    parsed = JSON.parse(start === -1 ? stdout : stdout.slice(start));
  } catch {
    throw new Error(`npm pack --json produced unparseable output:\n${stdout}`);
  }
  const entry = (Array.isArray(parsed) ? parsed[0] : undefined) as
    | { filename?: unknown; files?: unknown }
    | undefined;
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.filename !== "string" ||
    !Array.isArray(entry.files)
  ) {
    throw new Error(`npm pack --json produced an unexpected shape:\n${stdout}`);
  }
  return {
    filename: entry.filename,
    files: (entry.files as { path: string }[]).map((file) => file.path),
  };
}

/**
 * Runs a package-manager CLI and returns its stdout.
 *
 * WHY a shell on Windows: `npm`/`pnpm` are `.cmd` shims there, and Node ≥20.12
 * refuses to spawn `.cmd` files without one. Args go in one quoted command
 * string rather than as an array with `shell: true` (deprecated, DEP0190).
 */
function run(command: string, args: string[], cwd: string): string {
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync([command, ...args.map(quoteForCmd)].join(" "), {
        cwd,
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      })
    : spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pack-release: \`${command} ${args.join(" ")}\` exited ${result.status}`,
    );
  }
  return result.stdout;
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
