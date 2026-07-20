/**
 * The daemon's own version, advertised as NodeInfo `daemonVersion` and in
 * discovery. Single owner: everything (including the stdio shim) imports it
 * from here.
 *
 * Kept in its own module (rather than in `daemon.ts`) so that lightweight
 * consumers — notably the stdio shim, which is meant to be a minimal
 * executable — can depend on the version string alone without pulling in the
 * entire daemon assembly (discovery, transport, jobs, executors, ...).
 */
export const DAEMON_VERSION = "0.2.0";
