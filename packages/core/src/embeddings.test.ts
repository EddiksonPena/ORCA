import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "@orca/config";

import { createEmbeddingService } from "./embeddings.js";

test("hash embedding provider returns deterministic normalized vectors", async () => {
  const service = createEmbeddingService(
    loadConfig({
      PWD: process.cwd(),
      EMBEDDING_PROVIDER: "hash",
      EMBEDDING_DIMENSIONS: "16",
    }),
  );

  const first = await service.embed("Orca remembers Qwen embeddings.", "document");
  const second = await service.embed("Orca remembers Qwen embeddings.", "document");

  assert.deepEqual(first, second);
  assert.equal(first.length, 16);
  assert.ok(first.some((value) => value !== 0));
});

test("ollama embedding provider calls /api/embed with bearer auth", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit | undefined }[] = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const service = createEmbeddingService(
      loadConfig({
        PWD: process.cwd(),
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "qwen3-embedding:4b",
        OLLAMA_HOST: "https://ollama.com/",
        OLLAMA_API_KEY: "ollama-test-key",
      }),
    );

    const vector = await service.embed("How should Orca recall project memory?", "query");

    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.equal(requests[0]?.url, "https://ollama.com/api/embed");
    assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer ollama-test-key");
    assert.match(String(requests[0]?.init?.body), /qwen3-embedding:4b/);
    assert.match(String(requests[0]?.init?.body), /Instruct:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
