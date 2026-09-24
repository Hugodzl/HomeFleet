/**
 * Opens a URL in the user's default browser for `homefleet dashboard`.
 * The command mapping is pure (unit-tested); `openUrl` spawns it detached
 * and never waits for the browser. Windows uses rundll32's URL handler
 * rather than `cmd /c start`, so cmd.exe never parses the URL: `start`
 * is a cmd.exe builtin, and the classic injection spot is a URL containing
 * `&`, `|`, or a stray `"` reaching a shell that re-tokenizes it. Passing
 * the URL as an argv element to `rundll32` (via `spawn`, no shell) avoids
 * cmd.exe entirely, so there is nothing for it to parse.
 */
import { spawn } from "node:child_process";

export function openUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

/** Resolves once the opener process has spawned; rejects if it cannot. */
export function openUrl(url: string): Promise<void> {
  const { command, args } = openUrlCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
