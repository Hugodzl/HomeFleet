/**
 * Pairing handshake (ADR-0004): a short human-readable code confirms
 * certificate fingerprints out-of-band before two devices trust each other.
 */
import { z } from "zod";
import { NodeInfoSchema } from "./node.js";

export const PairRequestSchema = z.object({
  code: z
    .string()
    .regex(
      /^[A-Z0-9]{6,10}$/,
      "pairing code must be 6-10 uppercase alphanumeric chars",
    ),
  nodeInfo: NodeInfoSchema,
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z
  .object({
    accepted: z.boolean(),
    /** The responder's node info; present iff `accepted` is true. */
    nodeInfo: NodeInfoSchema.optional(),
  })
  .superRefine((response, ctx) => {
    if (response.accepted && response.nodeInfo === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["nodeInfo"],
        message: "nodeInfo is required when accepted is true",
      });
    }
    if (!response.accepted && response.nodeInfo !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["nodeInfo"],
        message: "nodeInfo must be absent when accepted is false",
      });
    }
  });
export type PairResponse = z.infer<typeof PairResponseSchema>;
