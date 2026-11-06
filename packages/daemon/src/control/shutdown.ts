/**
 * The decision behind `POST /control/shutdown` (`homefleet daemon stop`),
 * kept pure so every branch is unit-tested; ../daemon.ts supplies the live
 * facts and acts on the result.
 *
 * Order matters:
 * 1. `unsupported`: nothing would restart or stop this daemon.
 * 2. `upgrading`: an upgrade restarts the daemon itself (and has requested
 *    its own shutdown); a stop would race the updater's relaunch. Checked
 *    before (3) because the upgrade sets the same "requested" flag.
 * 3. Already stopping: answer success again WITHOUT re-requesting.
 *    homefleetd treats a second shutdown request as "force exit now",
 *    which would cut `daemon.stop()` short.
 * 4. `busy`: jobs are running and the caller did not pass `force`. The
 *    daemon enforces this, not the CLI, the same way the upgrade guards do.
 */
import type { ShutdownResult } from "./control-server.js";

export interface ShutdownFacts {
  pid: number;
  hasShutdownHook: boolean;
  upgrading: boolean;
  alreadyRequested: boolean;
  activeJobs: number;
  force: boolean;
}

/** `request` true means: the caller must start the shutdown now. */
export function decideShutdown(facts: ShutdownFacts): {
  result: ShutdownResult;
  request: boolean;
} {
  if (!facts.hasShutdownHook) {
    return refuse(
      "unsupported",
      "this daemon was not started by homefleetd, so it cannot shut itself down",
    );
  }
  if (facts.upgrading) {
    return refuse(
      "upgrading",
      "an upgrade is in progress; it restarts the daemon itself",
    );
  }
  if (facts.alreadyRequested) {
    return {
      result: { ok: true, pid: facts.pid, alreadyStopping: true },
      request: false,
    };
  }
  if (facts.activeJobs > 0 && !facts.force) {
    return refuse(
      "busy",
      `${facts.activeJobs} job(s) running; pass force to stop anyway`,
    );
  }
  return {
    result: { ok: true, pid: facts.pid, alreadyStopping: false },
    request: true,
  };
}

function refuse(
  code: "unsupported" | "busy" | "upgrading",
  message: string,
): { result: ShutdownResult; request: boolean } {
  return { result: { ok: false, code, message }, request: false };
}
