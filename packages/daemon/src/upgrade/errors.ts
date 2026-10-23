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
  | "verify-failed"
  | "disabled"
  | "unknown-node";

export class UpgradeError extends Error {
  readonly code: UpgradeErrorCode;
  /**
   * The wording for a peer that pushed the upgrade, when `message` speaks to
   * this node's own operator (local paths, CLI flags); see routes.ts.
   */
  readonly peerMessage: string | undefined;

  constructor(
    code: UpgradeErrorCode,
    message: string,
    options: { peerMessage?: string } = {},
  ) {
    super(message);
    this.name = "UpgradeError";
    this.code = code;
    this.peerMessage = options.peerMessage;
  }
}
