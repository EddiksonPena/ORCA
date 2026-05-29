import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./index.js";

test("embedding config defaults to shippable Qwen Transformers.js model", () => {
  const config = loadConfig({
    PWD: process.cwd(),
  });

  assert.equal(config.embeddingProvider, "transformers");
  assert.equal(config.embeddingModel, "onnx-community/Qwen3-Embedding-0.6B-ONNX");
  assert.equal(config.embeddingDtype, "q8");
  assert.equal(config.embeddingDimensions, 1024);
});

test("embedding config can fall back to deterministic hash vectors", () => {
  const config = loadConfig({
    PWD: process.cwd(),
    EMBEDDING_PROVIDER: "hash",
    EMBEDDING_MODEL: "test-hash",
    EMBEDDING_DTYPE: "fp32",
    EMBEDDING_DIMENSIONS: "16",
  });

  assert.equal(config.embeddingProvider, "hash");
  assert.equal(config.embeddingModel, "test-hash");
  assert.equal(config.embeddingDtype, "fp32");
  assert.equal(config.embeddingDimensions, 16);
});

test("embedding config supports Ollama endpoints", () => {
  const config = loadConfig({
    PWD: process.cwd(),
    EMBEDDING_PROVIDER: "ollama",
    EMBEDDING_MODEL: "qwen3-embedding:4b",
    EMBEDDING_DIMENSIONS: "2560",
    OLLAMA_HOST: "https://ollama.com/",
    OLLAMA_API_KEY: "ollama-test-key",
  });

  assert.equal(config.embeddingProvider, "ollama");
  assert.equal(config.embeddingModel, "qwen3-embedding:4b");
  assert.equal(config.embeddingDimensions, 2560);
  assert.equal(config.ollamaHost, "https://ollama.com");
  assert.equal(config.ollamaApiKey, "ollama-test-key");
});
