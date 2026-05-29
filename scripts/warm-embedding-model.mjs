#!/usr/bin/env node

import { resolve } from "node:path";

const workspaceRoot = resolve(new URL("..", import.meta.url).pathname);
const provider = process.env.EMBEDDING_PROVIDER ?? "transformers";
const model = process.env.EMBEDDING_MODEL ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const dtype = process.env.EMBEDDING_DTYPE ?? "q8";
const cacheDir = resolve(
  workspaceRoot,
  process.env.EMBEDDING_CACHE_DIR ?? "./data/models/transformers",
);

if (provider !== "transformers") {
  process.stdout.write(`Embedding provider is ${provider}; skipping Transformers model warmup.\n`);
  process.exit(0);
}

const { env, pipeline } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;

process.stdout.write(`Warming embedding model ${model} (${dtype}) into ${cacheDir}\n`);

const extractor = await pipeline("feature-extraction", model, { dtype });
await extractor(["Orca embedding model warmup."], {
  pooling: "last_token",
  normalize: true,
});

process.stdout.write("Embedding model warmup complete.\n");
