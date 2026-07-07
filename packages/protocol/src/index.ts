/**
 * HomeFleet Protocol (HFP) — versioned message schemas and inferred types.
 *
 * The zod schemas are the source of truth; every exported `XxxSchema` has a
 * matching inferred `Xxx` type. Spec: docs/rfc/hfp-v0.md.
 */
export * from "./discovery.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./job.js";
export * from "./node.js";
export * from "./pairing.js";
export * from "./rpc.js";
export * from "./version.js";
