/**
 * Custom HFP header names shared by the binary bundle transfers: the
 * workspace bundle upload (request headers), the write-job artifact download
 * (response header), and the client sides of both. A neutral home — neither
 * the workspace nor the jobs route module owns the wire vocabulary.
 */

/** Header carrying the (URL-encoded) repoId for the binary bundle upload. */
export const REPO_ID_HEADER = "x-homefleet-repo-id";

/**
 * Header carrying a 40-hex commit hash: the head a bundle upload claims to
 * deliver (request), or an artifact bundle's branch tip (response) — the
 * integrity anchor the delegator verifies the fetched ref against.
 */
export const HEAD_COMMIT_HEADER = "x-homefleet-head-commit";
