/**
 * Minimal OpenAI-compatible chat-completions client for the agent executor
 * (ADR-0003): built-in fetch, non-streaming — job-event streaming is what
 * HFP does; token streaming is not needed in v0. The response comes from a
 * merely *configured* endpoint, so it is untrusted input and is
 * zod-validated before anything reads it.
 */
import { z } from "zod";

export interface OpenAiClientOptions {
  /** Endpoint base, e.g. `http://127.0.0.1:1234/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` when present. */
  apiKey?: string;
}

/** A tool offered to the model, in the OpenAI function-calling format. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema for the arguments object. */
    parameters: Record<string, unknown>;
  };
}

/** Wire shape of a model-requested tool call (echoed back in messages). */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Chat message in the OpenAI wire format. */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A model-requested tool call, normalized for the loop. */
export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON argument text, exactly as the model produced it. */
  arguments: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletion {
  content: string | null;
  toolCalls: ChatToolCall[];
  /** Absent when the endpoint reports no usage — tolerated, not an error. */
  usage: ChatUsage | undefined;
}

/** The endpoint answered with a non-2xx status. */
export class EndpointHttpError extends Error {
  readonly status: number;

  constructor(status: number, bodyExcerpt: string) {
    super(`endpoint responded with status ${status}: ${bodyExcerpt}`);
    this.name = "EndpointHttpError";
    this.status = status;
  }
}

/** The endpoint answered 2xx but the body is not a valid chat completion. */
export class MalformedEndpointResponseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`malformed chat-completions response: ${message}`, { cause });
    this.name = "MalformedEndpointResponseError";
  }
}

const WireToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

/**
 * The subset of the chat-completions response the loop consumes. Unknown
 * fields are ignored (zod strips them); `content`/`tool_calls`/`usage` may
 * be null or absent — servers differ.
 */
const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(WireToolCallSchema).nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.int().min(0),
      completion_tokens: z.int().min(0),
    })
    .nullish(),
});

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Aborts the fetch; the job signal and wall-budget timeout both feed it. */
  signal: AbortSignal;
}

export class OpenAiClient {
  private readonly url: string;
  private readonly apiKey: string | undefined;

  constructor(options: OpenAiClientOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = options.apiKey;
  }

  /**
   * One non-streaming chat call. Throws {@link EndpointHttpError} on a
   * non-2xx status, {@link MalformedEndpointResponseError} on a body that
   * fails validation, and whatever fetch throws on network failure/abort —
   * the executor maps all of these to a failed (or canceled) result.
   */
  async chat(request: ChatRequest): Promise<ChatCompletion> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        // Absent (not []) when no tools are offered: some servers treat an
        // empty tool list differently from no tool list.
        ...(request.tools !== undefined && request.tools.length > 0
          ? { tools: request.tools }
          : {}),
        stream: false,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      let excerpt = "";
      try {
        excerpt = (await response.text()).slice(0, 256);
      } catch {
        // Body unreadable; the status alone will have to do.
      }
      throw new EndpointHttpError(response.status, excerpt);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new MalformedEndpointResponseError("body is not valid JSON", cause);
    }
    const parsed = ChatCompletionResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new MalformedEndpointResponseError(
        "body failed schema validation",
        parsed.error,
      );
    }
    const message = parsed.data.choices[0]?.message;
    if (message === undefined) {
      // Unreachable given .min(1), but the type system cannot see that.
      throw new MalformedEndpointResponseError("response has no choices");
    }
    const usage = parsed.data.usage ?? undefined;
    return {
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage:
        usage !== undefined
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
            }
          : undefined,
    };
  }
}
