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
