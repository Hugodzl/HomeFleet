/**
 * HFP protocol errors. Returned as HTTP error response bodies and embedded
 * in failed job results.
 */
import { z } from "zod";

export const HfpErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "UNKNOWN_JOB",
  "UNSUPPORTED_JOB_TYPE",
  "WORKSPACE_UNAVAILABLE",
  "BUSY",
  "INVALID_REQUEST",
  "CANCELED",
  "INTERNAL",
]);
export type HfpErrorCode = z.infer<typeof HfpErrorCodeSchema>;

export const HfpErrorSchema = z.object({
  code: HfpErrorCodeSchema,
  message: z.string(),
  /** Machine-readable extras; must be a JSON-serializable value. */
  details: z.json().optional(),
});
export type HfpError = z.infer<typeof HfpErrorSchema>;
