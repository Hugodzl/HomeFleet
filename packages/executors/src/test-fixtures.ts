/**
 * Shared fixtures for the executors test suite. Unlike the protocol/daemon
 * fixtures this file IS exported from the package: the daemon's M5 job
 * manager tests drive the agent executor through the mock endpoint too.
 *
 * {@link MockOpenAiEndpoint} is the testing strategy's designated mock: a
 * real local HTTP server implementing `POST /chat/completions` from an
 * ordered script of canned responses — the ONLY fake in the executor test
 * suite (processes, filesystem sandboxing, and HTTP are all real).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

/** Creates a fresh temp directory (stands in for a materialized workspace). */
export async function makeTempDir(
  prefix = "homefleet-executors-test-",
): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temp dir, retrying to ride out transient Windows file locking.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

/** Token counts attached to a scripted response (wire: snake_case). */
export interface MockUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface MockToolCall {
  /** Wire tool-call ID; defaults to `call_<n>` numbered per response. */
  id?: string;
  name: string;
  /** JSON-stringified into the wire `function.arguments`. */
  arguments?: unknown;
  /**
   * Verbatim wire `function.arguments` text; overrides `arguments`. Lets a
   * script hand the loop argument text that is not valid JSON.
   */
  argumentsRaw?: string;
}

/**
 * One canned response. `content` ends a conversation turn, `tool_calls`
 * requests tool invocations, `malformed` returns JSON that fails the
 * client's response schema; `delayMs` holds the response back (timeout and
 * cancellation tests).
 */
export type MockScriptEntry =
  | { kind: "content"; content: string; usage?: MockUsage; delayMs?: number }
  | {
      kind: "tool_calls";
      toolCalls: MockToolCall[];
      usage?: MockUsage;
      delayMs?: number;
    }
  | { kind: "malformed"; delayMs?: number };

export interface RecordedRequest {
  /** Parsed JSON request body. */
  body: unknown;
  headers: IncomingHttpHeaders;
}

/** Optional fixture behavior for {@link MockOpenAiEndpoint.start}. */
export interface MockOpenAiEndpointOptions {
  /**
   * Model ids the endpoint claims to serve on `GET /models` (A2 startup
   * validation probes this route). Defaults to none (an empty list, i.e. the
   * daemon's `not_served` status for every catalog entry pointed here).
   */
  models?: string[];
}

/**
 * Deterministic scripted OpenAI-compatible endpoint on 127.0.0.1 (ephemeral
 * port). Serves the script entries in order — one per request — and records
 * every received request for assertions. `close()` tears down cleanly: no
 * open handles, even with a delayed response still pending.
 */
export class MockOpenAiEndpoint {
  /** Every received request, in order. */
  readonly requests: RecordedRequest[] = [];
  readonly baseUrl: string;
  private readonly script: MockScriptEntry[];
  private readonly models: string[];
  private nextEntry = 0;
  private toolCallCounter = 0;
  private readonly server: Server;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  private constructor(
    server: Server,
    script: MockScriptEntry[],
    port: number,
    models: string[],
  ) {
    this.server = server;
    this.script = script;
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
    this.models = models;
  }

  static async start(
    script: MockScriptEntry[],
    options: MockOpenAiEndpointOptions = {},
  ): Promise<MockOpenAiEndpoint> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("MockOpenAiEndpoint bound to a non-TCP address");
    }
    const endpoint = new MockOpenAiEndpoint(
      server,
      script,
      address.port,
      options.models ?? [],
    );
    server.on("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        endpoint.handle(
          req.method ?? "",
          req.url ?? "",
          req.headers,
          Buffer.concat(chunks).toString("utf8"),
          (status, body) => {
            const payload = JSON.stringify(body);
            res.writeHead(status, { "content-type": "application/json" });
            res.end(payload);
          },
        );
      });
    });
    return endpoint;
  }

  /** Idempotent; pending delayed responses are dropped, not delivered. */
  async close(): Promise<void> {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handle(
    method: string,
    url: string,
    headers: IncomingHttpHeaders,
    bodyText: string,
    respond: (status: number, body: unknown) => void,
  ): void {
    // The catalog's startup `/models` probe (node/catalog.ts's
    // `probeServed`): answered from the configured list, never scripted or
    // recorded — it is not part of the chat-completion script.
    if (method === "GET" && url.endsWith("/models")) {
      respond(200, {
        object: "list",
        data: this.models.map((id) => ({ id, object: "model" })),
      });
      return;
    }
    if (method !== "POST" || url !== "/v1/chat/completions") {
      respond(404, { error: `no route for ${method} ${url}` });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      respond(400, { error: "request body is not valid JSON" });
      return;
    }
    this.requests.push({ body, headers });

    const entry = this.script[this.nextEntry];
    if (entry === undefined) {
      respond(500, { error: "mock script exhausted" });
      return;
    }
    this.nextEntry += 1;

    const send = (): void => respond(200, this.buildResponse(entry));
    if (entry.delayMs !== undefined) {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        send();
      }, entry.delayMs);
      this.pendingTimers.add(timer);
      return;
    }
    send();
  }

  private buildResponse(entry: MockScriptEntry): unknown {
    if (entry.kind === "malformed") {
      // Valid JSON that fails the client's response schema (no choices).
      return { choices: [] };
    }
    const usage =
      entry.usage !== undefined
        ? {
            usage: {
              prompt_tokens: entry.usage.promptTokens,
              completion_tokens: entry.usage.completionTokens,
            },
          }
        : {};
    const message =
      entry.kind === "content"
        ? { role: "assistant", content: entry.content }
        : {
            role: "assistant",
            content: null,
            tool_calls: entry.toolCalls.map((call) => {
              this.toolCallCounter += 1;
              return {
                id: call.id ?? `call_${this.toolCallCounter}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments:
                    call.argumentsRaw ?? JSON.stringify(call.arguments ?? {}),
                },
              };
            }),
          };
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message,
          finish_reason: entry.kind === "content" ? "stop" : "tool_calls",
        },
      ],
      ...usage,
    };
  }
}
