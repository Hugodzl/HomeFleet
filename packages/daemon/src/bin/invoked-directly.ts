import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `moduleUrl` is the process entry point — i.e. the
 * bin was run, not imported by a test.
 *
 * WHY realpath both sides: `npm i -g` installs bins as symlinks on
 * Linux/macOS. Node gives an ESM entry its REAL path as `import.meta.url` but
 * keeps `process.argv[1]` as the link path, so a plain string compare is
 * false and the bin silently exits 0 without running `main()`.
 */
export function isInvokedDirectly(
  moduleUrl: string,
  argv1: string | undefined,
): boolean {
  if (argv1 === undefined) return false;
  const modulePath = canonical(fileURLToPath(moduleUrl));
  const entryPath = canonical(argv1);
  return modulePath !== undefined && modulePath === entryPath;
}

function canonical(filePath: string): string | undefined {
  try {
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
}
