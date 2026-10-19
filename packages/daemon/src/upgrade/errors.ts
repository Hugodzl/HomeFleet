/**
 * Every refusal or failure the upgrade flow reports, as a machine-readable
 * code plus an operator-facing message. The control API maps codes to HTTP
 * statuses (control-server.ts `upgradeErrorStatus`) and forwards both.
 */
export type UpgradeErrorCode =
  | "not-newer"
  | "hfp-major-mismatch"
  | "busy"
  | "locked"
  | "not-installed"
  | "unsupported"
  | "fetch-failed"
  | "verify-failed";

export class UpgradeError extends Error {
  readonly code: UpgradeErrorCode;

  constructor(code: UpgradeErrorCode, message: string) {
    super(message);
    this.name = "UpgradeError";
    this.code = code;
  }
}
