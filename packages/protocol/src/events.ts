/**
 * Streaming job events, delivered over the SSE endpoint
 * `GET /hfp/v0/jobs/{id}/events`. Events for a job are totally ordered by
 * `seq`; the `result` event is terminal.
 */
import { z } from "zod";
import { JobIdSchema, JobResultSchema, JobStatusSchema } from "./job.js";

const JobEventBaseSchema = z.object({
  jobId: JobIdSchema,
  seq: z.int().min(0),
  /** ISO 8601 UTC timestamp (trailing `Z`). */
  ts: z.iso.datetime(),
});

export const StatusEventSchema = JobEventBaseSchema.extend({
  type: z.literal("status"),
  status: JobStatusSchema,
});
export type StatusEvent = z.infer<typeof StatusEventSchema>;

export const LogEventSchema = JobEventBaseSchema.extend({
  type: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

export const ToolCallEventSchema = JobEventBaseSchema.extend({
  type: z.literal("tool_call"),
  name: z.string(),
  argsSummary: z.string(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolResultEventSchema = JobEventBaseSchema.extend({
  type: z.literal("tool_result"),
  name: z.string(),
  resultSummary: z.string(),
  isError: z.boolean(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

/** Terminal event: carries the same result the job snapshot exposes. */
export const ResultEventSchema = JobEventBaseSchema.extend({
  type: z.literal("result"),
  result: JobResultSchema,
});
export type ResultEvent = z.infer<typeof ResultEventSchema>;

export const JobEventSchema = z.discriminatedUnion("type", [
  StatusEventSchema,
  LogEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ResultEventSchema,
]);
export type JobEvent = z.infer<typeof JobEventSchema>;
