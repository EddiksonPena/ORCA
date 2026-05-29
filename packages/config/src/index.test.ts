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
