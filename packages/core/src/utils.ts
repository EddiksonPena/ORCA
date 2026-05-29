import { createHash } from "node:crypto";

import type {
  MemoryArtifact,
  MemoryType,
  RecallCandidate,
} from "@orca/schemas";

import type {
  GraphEdge,
  PersistedState,
  RankedChunk,
  RetrievalAugmentations,
  StoredChunk,
} from "./types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
]);

export const createStableId = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export const summarize = (content: string): string => {
  const sentence = content.trim().split(/(?<=[.!?])\s+/)[0] ?? content.trim();
  return sentence.slice(0, 220);
};

export const tokenize = (content: string): string[] =>
  content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

export const chunkContent = (content: string): string[] => {
  const normalized = content.trim().replace(/\r\n/g, "\n");
  if (normalized.length <= 360) {
    return [normalized];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= 360) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= 360) {
      current = paragraph;
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let sentenceChunk = "";
    for (const sentence of sentences) {
      const candidate = sentenceChunk ? `${sentenceChunk} ${sentence}` : sentence;
      if (candidate.length <= 360) {
        sentenceChunk = candidate;
      } else {
        if (sentenceChunk) {
          chunks.push(sentenceChunk);
        }
        sentenceChunk = sentence;
      }
    }
    if (sentenceChunk) {
      current = sentenceChunk;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

export const extractEntities = (content: string): string[] => {
  const matches = content.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g) ?? [];
  const acronyms = content.match(/\b[A-Z]{2,}\b/g) ?? [];
  return dedupeStrings([...matches, ...acronyms].map((entity) => entity.trim())).slice(0, 24);
};

export const dedupeStrings = (values: string[]): string[] =>
  Array.from(new Set(values.filter(Boolean)));

export const computeChunkSalience = (content: string, entityCount: number): number =>
  roundScore(
    clamp(0.45 + Math.min(content.length / 1000, 0.25) + Math.min(entityCount * 0.03, 0.2), 0, 1),
  );

export const computeSalience = (reinforcementCount: number, type: MemoryType): number => {
  const typeBoost =
    type === "procedural" ? 0.12 : type === "working" ? 0.15 : type === "episodic" ? 0.08 : 0.05;
  return roundScore(clamp(0.45 + reinforcementCount * 0.05 + typeBoost, 0, 0.99));
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const jaccard = (left: string[], right: string[]): number => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  return intersection / union.size;
};

const semanticSimilarity = (queryTokens: string[], candidateTokens: string[]): number => {
  const expandedQuery = expandTokens(queryTokens);
  const expandedCandidate = expandTokens(candidateTokens);
  return jaccard(expandedQuery, expandedCandidate);
};

const expandTokens = (tokens: string[]): string[] => {
  const expansions = new Set(tokens);
  for (const token of tokens) {
    expansions.add(token.slice(0, 4));
    expansions.add(token.slice(-4));
  }
  return Array.from(expansions).filter((token) => token.length >= 2);
};

const graphOverlap = (queryEntities: string[], candidateEntities: string[]): number =>
  jaccard(
    queryEntities.map((entity) => entity.toLowerCase()),
    candidateEntities.map((entity) => entity.toLowerCase()),
  );

export const rankChunk = (
  chunk: StoredChunk,
  queryTokens: string[],
  queryEntities: string[],
  augmentations: RetrievalAugmentations,
): RankedChunk => {
  const sparseScore = jaccard(queryTokens, chunk.lexicalTokens);
  const semanticScore = Math.max(
    semanticSimilarity(queryTokens, chunk.lexicalTokens),
    augmentations.vectorHits.get(chunk.artifact.id) ?? 0,
  );
  const graphScore = Math.max(
    graphOverlap(queryEntities, chunk.entities),
    augmentations.graphHits.get(chunk.artifact.id) ?? 0,
  );
  const workingBoost = augmentations.workingHits.has(chunk.artifact.id)
    ? 0.12
    : chunk.artifact.scope === "session"
      ? 0.06
      : 0;
  const reinforcementBoost = Math.min((chunk.artifact.reinforcementCount ?? 0) * 0.03, 0.15);
  const score =
    semanticScore * 0.45 +
    sparseScore * 0.25 +
    graphScore * 0.2 +
    workingBoost +
    reinforcementBoost;

  const sourceScores = {
    vector: semanticScore,
    sparse: sparseScore,
    graph: graphScore,
    working: workingBoost,
  } satisfies Record<RecallCandidate["source"], number>;

  const [primarySource, primaryScore] = Object.entries(sourceScores).sort(
    (left, right) => right[1] - left[1],
  )[0] as [RecallCandidate["source"], number];

  return {
    chunk,
    score,
    primarySource,
    reasoning:
      `${primarySource}=${roundScore(primaryScore)},` +
      ` graph=${roundScore(graphScore)}, working=${roundScore(workingBoost)},` +
      ` reinforcement=${roundScore(reinforcementBoost)}`,
  };
};

export const edgeKey = (from: string, to: string): string =>
  [from.toLowerCase(), to.toLowerCase()].sort().join("::");

export const roundScore = (value: number): number => Math.round(value * 1000) / 1000;

export const toUuid = (value: string): string => {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const escapeGraphQl = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");

export const neo4jHttpUrl = (boltUri: string): string => {
  const parsed = new URL(boltUri);
  const port = parsed.port === "7687" || !parsed.port ? "7474" : parsed.port;
  return `http://${parsed.hostname}:${port}/db/neo4j/tx/commit`;
};

export const rebuildGraphState = (
  state: PersistedState,
  rootEntities: string[],
  chunks: StoredChunk[],
): void => {
  const graphNodes = new Set(state.graphNodes);
  const graphEdges = new Map<string, GraphEdge>();
  for (const edge of state.graphEdges) {
    graphEdges.set(edgeKey(edge.from, edge.to), edge);
  }

  for (const entity of rootEntities) {
    graphNodes.add(entity);
  }

  for (const chunk of chunks) {
    for (const entity of chunk.entities) {
      graphNodes.add(entity);
    }
    for (let index = 0; index < chunk.entities.length - 1; index += 1) {
      const from = chunk.entities[index];
      const to = chunk.entities[index + 1];
      if (!from || !to || from === to) {
        continue;
      }

      const key = edgeKey(from, to);
      const current = graphEdges.get(key);
      graphEdges.set(key, {
        from,
        to,
        relation: "co_occurs_with",
        weight: (current?.weight ?? 0) + 1,
      });
    }
  }

  state.graphNodes = Array.from(graphNodes).sort();
  state.graphEdges = Array.from(graphEdges.values()).sort((left, right) =>
    edgeKey(left.from, left.to).localeCompare(edgeKey(right.from, right.to)),
  );
};

export const rebuildAllGraphState = (state: PersistedState): void => {
  state.graphNodes = [];
  state.graphEdges = [];
  for (const chunk of state.chunks) {
    chunk.entities = extractEntities(chunk.artifact.content);
    chunk.lexicalTokens = tokenize(chunk.artifact.content);
    chunk.artifact.salience = computeChunkSalience(chunk.artifact.content, chunk.entities.length);
    chunk.artifact.updatedAt = new Date().toISOString();
  }

  const parentIds = new Set(state.chunks.map((chunk) => chunk.parentId));
  for (const parentId of parentIds) {
    const rootArtifact = state.artifacts.find((artifact) => artifact.id === parentId);
    const rootEntities = rootArtifact ? extractEntities(rootArtifact.content) : [];
    rebuildGraphState(
      state,
      rootEntities,
      state.chunks.filter((chunk) => chunk.parentId === parentId),
    );
  }
};

export const updateArtifactsAfterRecall = (
  state: PersistedState,
  context: MemoryArtifact[],
): void => {
  const now = new Date().toISOString();
  for (const artifact of context) {
    artifact.lastAccessedAt = now;
    artifact.reinforcementCount = (artifact.reinforcementCount ?? 0) + 1;
    artifact.salience = computeSalience(artifact.reinforcementCount, artifact.type);
  }
};
