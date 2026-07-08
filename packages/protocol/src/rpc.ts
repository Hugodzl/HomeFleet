/**
 * Request/response wrappers for the HFP HTTP endpoints
 * (see docs/rfc/hfp-v0.md, "Transport Binding").
 */
import { z } from "zod";
import {
  isTerminalJobStatus,
  JobIdSchema,
  JobParamsSchema,
  JobResultSchema,
  JobStatusSchema,
} from "./job.js";
import { NodeInfoSchema } from "./node.js";

/**
 * Default TCP port for the HFP node service (the mTLS HTTPS endpoint peers
 * connect to). Neighbors the UDP discovery port 56371 (`DISCOVERY_UDP_PORT`
 * in discovery.js); the daemon config module documents the full HomeFleet
 * 5637x port family. A stable well-known default keeps discovery hints and
 * static-node config simple; deployments can still override it per daemon.
 */
export const HFP_DEFAULT_PORT = 56370;

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
    if (isTerminalJobStatus(snapshot.status) && snapshot.result === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "result is required when status is terminal",
      });
    }
    if (
      !isTerminalJobStatus(snapshot.status) &&
      snapshot.result !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "result must be absent when status is not terminal",
      });
    }
    if (snapshot.result !== undefined) {
      if (snapshot.result.status !== snapshot.status) {
        ctx.addIssue({
          code: "custom",
          path: ["result", "status"],
          message: "result.status must match the snapshot status",
        });
      }
      if (snapshot.result.jobId !== snapshot.jobId) {
        ctx.addIssue({
          code: "custom",
          path: ["result", "jobId"],
          message: "result.jobId must match the snapshot jobId",
        });
      }
    }
  });
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

/** `POST /hfp/v0/jobs/{id}/cancel` */
export const CancelResponseSchema = z.object({
  jobId: JobIdSchema,
  status: JobStatusSchema,
});
export type CancelResponse = z.infer<typeof CancelResponseSchema>;
