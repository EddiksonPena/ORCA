import { createHash } from "node:crypto";

import type { AppConfig } from "@orca/config";

import { roundScore, tokenize } from "./utils.js";

export type EmbeddingPurpose = "query" | "document";

export interface EmbeddingService {
  embed(content: string, purpose: EmbeddingPurpose): Promise<number[]>;
}

const hashEmbed = (content: string, dimensions: number): number[] => {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(content);
  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    for (let index = 0; index < dimensions; index += 1) {
      const normalized = (digest[index] ?? 0) / 255;
      vector[index] = (vector[index] ?? 0) + normalized * 2 - 1;
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => roundScore(value / magnitude));
};

const formatInput = (content: string, purpose: EmbeddingPurpose, config: AppConfig): string => {
  if (purpose !== "query") {
    return content;
  }

  return `Instruct: ${config.embeddingQueryInstruction}\nQuery: ${content}`;
};

const toVector = (output: unknown): number[] => {
  const candidate = output as {
    data?: Iterable<number>;
    tolist?: () => unknown;
  };

  if (typeof candidate.tolist === "function") {
    const listed = candidate.tolist() as unknown;
    if (
      Array.isArray(listed)
      && listed.length > 0
      && Array.isArray(listed[0])
    ) {
      return (listed[0] as number[]).map(Number);
    }
    if (Array.isArray(listed)) {
      return listed.map(Number);
    }
  }

  if (candidate.data) {
    return Array.from(candidate.data, Number);
  }

  throw new Error("Transformers embedding output did not contain vector data.");
};

export const createEmbeddingService = (config: AppConfig): EmbeddingService => {
  if (config.embeddingProvider === "hash") {
    return {
      embed: async (content) => hashEmbed(content, config.embeddingDimensions),
    };
  }

  let extractorPromise: Promise<(input: string[], options: Record<string, unknown>) => Promise<unknown>> | undefined;

  const getExtractor = async () => {
    extractorPromise ??= (async () => {
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = config.embeddingCacheDir;
      return transformers.pipeline("feature-extraction", config.embeddingModel, {
        dtype: config.embeddingDtype,
      }) as Promise<(input: string[], options: Record<string, unknown>) => Promise<unknown>>;
    })();

    return extractorPromise;
  };

  return {
    embed: async (content, purpose) => {
      const extractor = await getExtractor();
      const output = await extractor([formatInput(content, purpose, config)], {
        pooling: "last_token",
        normalize: true,
      });
      return toVector(output);
    },
  };
};
