import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { EnforcedMemoryHarness, type ChatMessage } from "@orca/harness";
import type { MemoryScope } from "@orca/schemas";

const port = Number(process.env.ORCA_PROXY_PORT ?? 4030);
const upstreamBaseUrl = (
  process.env.ORCA_PROXY_UPSTREAM_BASE_URL ??
  process.env.OPENAI_UPSTREAM_BASE_URL ??
  "https://api.openai.com"
).replace(/\/$/u, "");
const upstreamApiKey = process.env.OPENAI_API_KEY ?? "";
const defaultScope = process.env.ORCA_DEFAULT_SCOPE ?? "workspace";
const failureMode = process.env.ORCA_FAILURE_MODE === "degraded" ? "degraded" : "block";
const required = process.env.ORCA_REQUIRED === "false" ? false : true;
const maxRequestBytes = Number(process.env.ORCA_PROXY_MAX_REQUEST_BYTES ?? process.env.MAX_REQUEST_BYTES ?? 1024 * 1024);
const memoryBlockMaxChars = Number(process.env.ORCA_PROXY_MEMORY_BLOCK_MAX_CHARS ?? 6000);
const startedAt = new Date().toISOString();

const metrics = {
  requests: 0,
  streamingRequests: 0,
  upstreamRequests: 0,
  recallSuccess: 0,
  recallFailure: 0,
  ingestSuccess: 0,
  ingestFailure: 0,
  blockedRequests: 0,
  degradedRequests: 0,
  memoryInjected: 0,
};

const harness = new EnforcedMemoryHarness({
  defaultScope: defaultScope as MemoryScope,
  failureMode,
  required,
  source: "orca-openai-proxy",
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        service: "orca-proxy",
        status: "ok",
        required,
        failureMode,
        upstreamBaseUrl,
        startedAt,
        metrics,
      });
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      return sendText(res, 200, renderMetrics(), {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      metrics.requests += 1;
      if (!upstreamApiKey) {
        metrics.blockedRequests += 1;
        return sendJson(res, 500, {
          error: "missing_upstream_api_key",
          message: "Set OPENAI_API_KEY before using the Orca proxy.",
        });
      }

      const payload = await readJson(req) as {
        messages?: ChatMessage[];
        user?: string;
        metadata?: Record<string, unknown>;
        [key: string]: unknown;
      };
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const latestPrompt = latestUserPrompt(messages);
      const sessionId =
        String(req.headers["x-orca-session-id"] ?? payload.user ?? payload.metadata?.["sessionId"] ?? randomUUID());
      const scope = String(req.headers["x-orca-scope"] ?? payload.metadata?.["scope"] ?? defaultScope);

      let before;
      try {
        before = await harness.beforePrompt({
          sessionId,
          scope: scope as MemoryScope,
          prompt: latestPrompt,
          messages,
        });
        metrics.recallSuccess += 1;
        if (before.memories.length > 0) {
          metrics.memoryInjected += 1;
        }
      } catch (error) {
        metrics.recallFailure += 1;
        metrics.blockedRequests += 1;
        throw error;
      }

      const upstreamMessages = trimInjectedMemory(before.messages);
      metrics.upstreamRequests += 1;
      if (payload.stream === true) {
        metrics.streamingRequests += 1;
      }

      const upstreamResponse = await fetch(`${upstreamBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${upstreamApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          messages: upstreamMessages,
        }),
      });

      if (payload.stream === true && upstreamResponse.ok) {
        await forwardStreamingCompletion({
          res,
          upstreamResponse,
          sessionId,
          memoryCount: before.memories.length,
          latestPrompt,
          scope: scope as MemoryScope,
          upstreamMessages,
        });
        return;
      }

      const text = await upstreamResponse.text();
      const responsePayload = text ? JSON.parse(text) as Record<string, unknown> : {};

      if (upstreamResponse.ok) {
        const assistantResponse = extractAssistantResponse(responsePayload);
        if (assistantResponse) {
          try {
            await harness.afterResponse({
              sessionId,
              scope: scope as MemoryScope,
              prompt: latestPrompt,
              response: assistantResponse,
              messages: upstreamMessages,
            });
            metrics.ingestSuccess += 1;
          } catch (error) {
            metrics.ingestFailure += 1;
            if (required && failureMode === "block") {
              throw error;
            }
          }
        }
      } else if (!required || failureMode === "degraded") {
        metrics.degradedRequests += 1;
      }

      res.writeHead(upstreamResponse.status, {
        ...proxyResponseHeaders(upstreamResponse, sessionId, before.memories.length),
      });
      res.end(text);
      return;
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (!required || failureMode === "degraded") {
      metrics.degradedRequests += 1;
    }
    return sendJson(res, 500, {
      error: "orca_proxy_failed",
      message: (error as Error).message,
    });
  }
});

server.listen(port, () => {
  console.log(JSON.stringify({
    service: "orca-proxy",
    event: "listening",
    port,
    upstreamBaseUrl,
    required,
    failureMode,
  }));
});

const latestUserPrompt = (messages: ChatMessage[]): string => {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) {
    return "Agent turn with no explicit user message.";
  }
  return typeof latest.content === "string" ? latest.content : JSON.stringify(latest.content);
};

const trimInjectedMemory = (messages: ChatMessage[]): ChatMessage[] => {
  if (messages.length === 0) {
    return messages;
  }
  const [first, ...rest] = messages;
  if (
    first?.role !== "system" ||
    typeof first.content !== "string" ||
    !first.content.startsWith("Relevant prior memory from Orca.")
  ) {
    return messages;
  }
  if (first.content.length <= memoryBlockMaxChars) {
    return messages;
  }
  return [
    {
      ...first,
      content: `${first.content.slice(0, memoryBlockMaxChars)}\n[Orca memory block truncated by proxy budget]`,
    },
    ...rest,
  ];
};

const extractAssistantResponse = (payload: Record<string, unknown>): string => {
  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return "";
  }
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
  const content = first?.message?.content ?? first?.text;
  return typeof content === "string" ? content : content ? JSON.stringify(content) : "";
};

interface StreamingCompletionInput {
  res: ServerResponse<IncomingMessage>;
  upstreamResponse: Response;
  sessionId: string;
  memoryCount: number;
  latestPrompt: string;
  scope: MemoryScope;
  upstreamMessages: ChatMessage[];
}

const proxyResponseHeaders = (
  upstreamResponse: Response,
  sessionId: string,
  memoryCount: number,
): Record<string, string> => ({
  "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
  "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-cache",
  "x-orca-session-id": sessionId,
  "x-orca-memory-count": String(memoryCount),
});

const forwardStreamingCompletion = async ({
  res,
  upstreamResponse,
  sessionId,
  memoryCount,
  latestPrompt,
  scope,
  upstreamMessages,
}: StreamingCompletionInput): Promise<void> => {
  if (!upstreamResponse.body) {
    throw new Error("Streaming upstream response did not include a body.");
  }

  res.writeHead(upstreamResponse.status, proxyResponseHeaders(upstreamResponse, sessionId, memoryCount));

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let assistantResponse = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunkText = decoder.decode(value, { stream: true });
      assistantResponse += extractStreamingAssistantDelta(`${pending}${chunkText}`);
      pending = trailingPartialSseEvent(`${pending}${chunkText}`);
      res.write(Buffer.from(chunkText));
    }

    const finalText = decoder.decode();
    if (finalText) {
      assistantResponse += extractStreamingAssistantDelta(`${pending}${finalText}`);
      res.write(finalText);
      pending = "";
    }

    res.end();

    if (assistantResponse.trim()) {
      try {
        await harness.afterResponse({
          sessionId,
          scope,
          prompt: latestPrompt,
          response: assistantResponse,
          messages: upstreamMessages,
        });
        metrics.ingestSuccess += 1;
      } catch {
        metrics.ingestFailure += 1;
      }
    }
  } catch (error) {
    metrics.ingestFailure += 1;
    res.destroy(error as Error);
  } finally {
    reader.releaseLock();
  }
};

const trailingPartialSseEvent = (text: string): string => {
  const crlfIndex = text.lastIndexOf("\r\n\r\n");
  const lfIndex = text.lastIndexOf("\n\n");
  if (crlfIndex > lfIndex) {
    return text.slice(crlfIndex + 4);
  }
  return lfIndex === -1 ? text : text.slice(lfIndex + 2);
};

const extractStreamingAssistantDelta = (text: string): string =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => {
      try {
        const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown }; text?: unknown }> };
        const choice = payload.choices?.[0];
        const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
        return typeof content === "string" ? content : "";
      } catch {
        return "";
      }
    })
    .join("");

function sendJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: string,
  headers: Record<string, string>,
): void {
  res.writeHead(statusCode, headers);
  res.end(body);
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const rawBody = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const destroyableReq = req as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxRequestBytes) {
        reject(new Error(`Request body exceeds ORCA_PROXY_MAX_REQUEST_BYTES (${maxRequestBytes}).`));
        destroyableReq.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  return rawBody ? JSON.parse(rawBody) as unknown : {};
}

const metric = (name: string, value: number): string => `orca_proxy_${name} ${value}`;

const renderMetrics = (): string => [
  "# HELP orca_proxy_requests Total proxy chat completion requests.",
  "# TYPE orca_proxy_requests counter",
  metric("requests", metrics.requests),
  "# HELP orca_proxy_streaming_requests Total streaming proxy chat completion requests.",
  "# TYPE orca_proxy_streaming_requests counter",
  metric("streaming_requests", metrics.streamingRequests),
  "# HELP orca_proxy_upstream_requests Total upstream chat completion requests.",
  "# TYPE orca_proxy_upstream_requests counter",
  metric("upstream_requests", metrics.upstreamRequests),
  "# HELP orca_proxy_recall_success Total successful before-prompt recalls.",
  "# TYPE orca_proxy_recall_success counter",
  metric("recall_success", metrics.recallSuccess),
  "# HELP orca_proxy_recall_failure Total failed before-prompt recalls.",
  "# TYPE orca_proxy_recall_failure counter",
  metric("recall_failure", metrics.recallFailure),
  "# HELP orca_proxy_ingest_success Total successful after-response ingests.",
  "# TYPE orca_proxy_ingest_success counter",
  metric("ingest_success", metrics.ingestSuccess),
  "# HELP orca_proxy_ingest_failure Total failed after-response ingests.",
  "# TYPE orca_proxy_ingest_failure counter",
  metric("ingest_failure", metrics.ingestFailure),
  "# HELP orca_proxy_memory_injected Total requests with one or more recalled memories injected.",
  "# TYPE orca_proxy_memory_injected counter",
  metric("memory_injected", metrics.memoryInjected),
  "# HELP orca_proxy_blocked_requests Total requests blocked by strict Orca enforcement.",
  "# TYPE orca_proxy_blocked_requests counter",
  metric("blocked_requests", metrics.blockedRequests),
  "# HELP orca_proxy_degraded_requests Total requests that continued in degraded mode.",
  "# TYPE orca_proxy_degraded_requests counter",
  metric("degraded_requests", metrics.degradedRequests),
].join("\n") + "\n";
