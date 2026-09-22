/**
 * Build → check → stage → `npm pack` for the release tarball (S1 spec §2).
 */
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
  /** Where `homefleet-<version>.tgz` lands. */
  outDir: string;
  /** Run the daemon's tsup build first (off only for unit tests). */
  build: boolean;
  /**
   * Where the built bins live (and, when `build` is true, where they're
   * built to). Defaults to `<daemonDir>/dist/bin` — the real build output a
   * normal `pnpm pack:release` ships.
   *
   * WHY a default rather than always the real dist/bin: the integration test
   * builds here too, and `tsup`'s `clean: true` wipes the target directory
   * first. A shared checkout's `packages/daemon/dist/bin` can be the file a
   * running `homefleetd` (started by `homefleet setup`'s Task Scheduler
   * entry) was launched from, so rebuilding it out from under that process —
   * or racing a second session's own build — is not safe to do as a side
   * effect of `pnpm test`. Tests pass a private `distDir` instead.
   */
  distDir?: string;
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
  const distDir =
    options.distDir ?? path.join(options.daemonDir, "dist", "bin");

  if (options.build) {
    // WHY --out-dir rather than the package's own `build` script: it lets us
    // redirect tsup's (and its `clean: true`) output away from the real
    // dist/bin without a second tsup config. tsup's CLI flag wins over
    // tsup.config.ts's `outDir`.
    run(
      "pnpm",
      ["--filter", daemonPkg.name, "exec", "tsup", "--out-dir", distDir],
      options.daemonDir,
    );
  }

  for (const binPath of Object.values(manifest.bin)) {
    const absolute = path.join(distDir, path.basename(binPath));
    try {
      await access(absolute);
    } catch {
      throw new Error(
        `pack-release: missing built bin ${absolute} — run the daemon build first`,
      );
    }
  }

  const stagingDir = await mkdtemp(path.join(tmpdir(), "homefleet-pack-"));
  try {
    await mkdir(path.join(stagingDir, "dist"), { recursive: true });
    await cp(distDir, path.join(stagingDir, "dist", "bin"), {
      recursive: true,
    });
    await cp(options.licensePath, path.join(stagingDir, "LICENSE"));
    await writeFile(
      path.join(stagingDir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await mkdir(options.outDir, { recursive: true });
    await clearStaleTarballs(options.outDir);
    const report = parsePackReport(
      run(
        "npm",
        ["pack", "--json", "--pack-destination", options.outDir],
        stagingDir,
      ),
    );
    return {
      tarballPath: path.join(options.outDir, report.filename),
      files: [...report.files].sort(),
      manifest,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * WHY: `release/*.tgz` globs (locally and in CI) must never pick up a
 * tarball from a previous version left behind by an earlier run.
 */
async function clearStaleTarballs(outDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => /^homefleet-.*\.tgz$/.test(name))
      .map((name) => rm(path.join(outDir, name), { force: true })),
  );
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
    const detail =
      result.status === null
        ? `terminated by signal ${result.signal}`
        : `exited ${result.status}`;
    throw new Error(`pack-release: \`${command} ${args.join(" ")}\` ${detail}`);
  }
  return result.stdout;
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
