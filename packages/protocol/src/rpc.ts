/**
 * Request/response wrappers for the HFP HTTP endpoints
 * (see docs/rfc/hfp-v0.md, "Transport Binding").
 */
import { z } from "zod";
import {
  JobIdSchema,
  JobParamsSchema,
  JobResultSchema,
  type JobStatus,
  JobStatusSchema,
} from "./job.js";
import { NodeInfoSchema } from "./node.js";

const isTerminal = (status: JobStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "canceled";

/** `POST /hfp/v0/hello` */
export const HelloRequestSchema = z.object({
  nodeInfo: NodeInfoSchema,
});
export type HelloRequest = z.infer<typeof HelloRequestSchema>;

export const HelloResponseSchema = z.object({
  nodeInfo: NodeInfoSchema,
});
export type HelloResponse = z.infer<typeof HelloResponseSchema>;

/** `POST /hfp/v0/jobs` */
export const DelegateRequestSchema = z.object({
  params: JobParamsSchema,
});
export type DelegateRequest = z.infer<typeof DelegateRequestSchema>;

export const DelegateResponseSchema = z.object({
  jobId: JobIdSchema,
});
export type DelegateResponse = z.infer<typeof DelegateResponseSchema>;

/** `GET /hfp/v0/jobs/{id}` */
export const JobSnapshotSchema = z
  .object({
    jobId: JobIdSchema,
    status: JobStatusSchema,
    /** Present iff `status` is terminal (succeeded | failed | canceled). */
    result: JobResultSchema.optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (isTerminal(snapshot.status) && snapshot.result === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "result is required when status is terminal",
      });
    }
    if (!isTerminal(snapshot.status) && snapshot.result !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "result must be absent when status is not terminal",
      });
    }
  });
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

/** `POST /hfp/v0/jobs/{id}/cancel` */
export const CancelResponseSchema = z.object({
  jobId: JobIdSchema,
  status: JobStatusSchema,
});
export type CancelResponse = z.infer<typeof CancelResponseSchema>;
