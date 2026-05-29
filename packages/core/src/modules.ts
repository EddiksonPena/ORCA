import type { AppConfig } from "@orca/config";
import type {
  IngestMemoryRequest,
  IngestMemoryResponse,
  MemoryArtifact,
  MemoryType,
  RecallMemoryRequest,
  ReindexResponse,
} from "@orca/schemas";

import {
  GraphitiPythonTemporalGraphAdapter,
  GraphitiTemporalGraphAdapter,
  Neo4jGraphAdapter,
  Neo4jTemporalGraphAdapter,
  RedisWorkingMemoryAdapter,
  WeaviateSemanticAdapter,
} from "./adapters.js";
import type { StateStore } from "./types.js";
import type {
  MemoryModule,
  MemoryModuleId,
  ModuleRecallResult,
  PersistedState,
  RecallSelection,
  RetrievalAugmentations,
  StoredChunk,
  TemporalGraphAdapter,
  WorkflowExecutionResult,
  WorkflowDefinition,
} from "./types.js";
import { scopeMatches } from "./types.js";
import {
  chunkContent,
  computeChunkSalience,
  computeSalience,
  createStableId,
  extractEntities,
  rankChunk,
  rebuildAllGraphState,
  rebuildGraphState,
  roundScore,
  summarize,
  tokenize,
} from "./utils.js";

interface ModuleContext {
  config: AppConfig;
  stateStore: StateStore;
  redisAdapter: RedisWorkingMemoryAdapter;
  weaviateAdapter: WeaviateSemanticAdapter;
  neo4jAdapter: Neo4jGraphAdapter;
  temporalGraphAdapter: TemporalGraphAdapter;
}

const buildTypedChunks = (
  request: IngestMemoryRequest,
  rootArtifact: MemoryArtifact,
  rootType: MemoryType,
  now: string,
): StoredChunk[] =>
  chunkContent(request.content).map((chunkText, index) => {
    const chunkId = createStableId(`${rootArtifact.id}::chunk::${index}::${chunkText}`);
    const entities = extractEntities(chunkText);
    const lexicalTokens = tokenize(chunkText);
    const artifact: MemoryArtifact = {
      id: chunkId,
      type: rootType,
      scope: request.scope,
      content: chunkText,
      summary: summarize(chunkText),
      confidence: 0.68,
      tags: Array.from(new Set([...(request.tags ?? []), ...entities])),
      provenance: rootArtifact.provenance,
      linkedArtifactIds: [rootArtifact.id],
      modelVersion: `${request.sessionId ?? "module"}:${rootType}`,
      createdAt: now,
      updatedAt: now,
      salience: computeChunkSalience(chunkText, entities.length),
      reinforcementCount: 0,
      lastAccessedAt: now,
      metadata: {
        chunkIndex: index,
        tokenCount: lexicalTokens.length,
        sessionId: request.sessionId ?? "",
      },
    };

    rootArtifact.linkedArtifactIds.push(chunkId);

    return {
      artifact,
      parentId: rootArtifact.id,
      chunkIndex: index,
      entities,
      lexicalTokens,
    } satisfies StoredChunk;
  });

const collectAugmentations = async ({
  request,
  state,
  queryEntities,
  redisAdapter,
  weaviateAdapter,
  neo4jAdapter,
  moduleId,
}: {
  request: RecallMemoryRequest;
  state: PersistedState;
  queryEntities: string[];
  redisAdapter: RedisWorkingMemoryAdapter;
  weaviateAdapter: WeaviateSemanticAdapter;
  neo4jAdapter: Neo4jGraphAdapter;
  moduleId: MemoryModuleId;
}): Promise<RetrievalAugmentations> => {
  const [workingIds, vectorHits, graphEntities] = await Promise.all([
    redisAdapter.getRecent(request.scope, moduleId),
    weaviateAdapter.search(request.query, (request.limit ?? 5) * 4, request.scope, moduleId),
    neo4jAdapter.searchRelatedEntities(queryEntities, moduleId),
  ]);

  const graphHits = new Map<string, number>();
  for (const chunk of state.chunks) {
    let score = 0;
    for (const entity of chunk.entities) {
      score += graphEntities.get(entity.toLowerCase()) ?? 0;
    }
    if (score > 0) {
      graphHits.set(chunk.artifact.id, roundScore(Math.min(score / 10, 1)));
    }
  }

  return {
    vectorHits,
    graphHits,
    workingHits: new Set(workingIds),
    storesQueried: [
      "state-store",
      "working-memory",
      "semantic-store",
      "graph-store",
    ],
  };
};

const buildStoredIn = (statuses: Array<[string, boolean]>): string[] => [
  "state-store",
  ...statuses.filter(([, ok]) => ok).map(([store]) => store),
];

const createModule = ({
  id,
  supportedTypes,
  inferType,
  context,
  recallBias,
  workflowDefinitions,
  afterIngest,
  afterRecallAugmentations,
  afterReindex,
}: {
  id: MemoryModuleId;
  supportedTypes: MemoryType[];
  inferType: (content: string) => MemoryType | undefined;
  context: ModuleContext;
  recallBias: (request: RecallMemoryRequest) => number;
  workflowDefinitions: WorkflowDefinition[];
  afterIngest?: (rootArtifact: MemoryArtifact, chunks: StoredChunk[]) => Promise<void>;
  afterRecallAugmentations?: (queryEntities: string[], state: PersistedState) => Promise<{
    graphHits: Map<string, number>;
    storesQueried: string[];
  }>;
  afterReindex?: (state: PersistedState) => Promise<void>;
}): MemoryModule => {
  const { config, stateStore, redisAdapter, weaviateAdapter, neo4jAdapter } = context;

  return {
    id,
    supportedTypes,
    canHandleType: (type) => supportedTypes.includes(type),
    canRecall: recallBias,
    inferType,
    ingest: async (request): Promise<IngestMemoryResponse> => {
      const result = await stateStore.update(async (state) => {
        const now = new Date().toISOString();
        const observedAt = request.observedAt ?? now;
        const rootType = request.typeHint && supportedTypes.includes(request.typeHint)
          ? request.typeHint
          : supportedTypes[0]!;
        const canonicalId = createStableId(
          [request.scope, id, request.source, request.sourceId ?? "", request.content].join("::"),
        );

        const existing = state.artifacts.find((artifact) => artifact.id === canonicalId);
        if (existing) {
          existing.reinforcementCount = (existing.reinforcementCount ?? 0) + 1;
          existing.salience = computeSalience(existing.reinforcementCount, existing.type);
          existing.updatedAt = now;
          existing.lastAccessedAt = now;

          return {
            response: {
              memoryId: canonicalId,
              accepted: true,
              deduplicated: true,
              artifactsCreated: 0,
	            chunksCreated: 0,
	            entitiesExtracted: 0,
	            storedIn: ["state-store"],
	          } satisfies IngestMemoryResponse,
            rootArtifact: existing,
            chunks: [] as StoredChunk[],
          };
        }

        const rootEntities = extractEntities(request.content);
        const rootArtifact: MemoryArtifact = {
          id: canonicalId,
          type: rootType,
          scope: request.scope,
          content: request.content.trim(),
          summary: summarize(request.content),
          confidence: 0.7,
          tags: Array.from(new Set(request.tags ?? [])),
          provenance: {
            source: request.source,
            observedAt,
            ingestedAt: now,
            ...(request.sourceId ? { sourceId: request.sourceId } : {}),
          },
          linkedArtifactIds: [],
          modelVersion: `${config.embeddingModel}:${config.rerankerModel}`,
          createdAt: now,
          updatedAt: now,
          salience: computeSalience(0, rootType),
          reinforcementCount: 0,
          lastAccessedAt: now,
          metadata: {
            moduleId: id,
            sessionId: request.sessionId ?? "",
            entityCount: rootEntities.length,
          },
        };

        const chunks = buildTypedChunks(request, rootArtifact, rootType, now);
        rebuildGraphState(state, rootEntities, chunks);
        state.artifacts.push(rootArtifact, ...chunks.map((chunk) => chunk.artifact));
        state.chunks.push(...chunks);

        return {
          response: {
            memoryId: canonicalId,
            accepted: true,
            deduplicated: false,
            artifactsCreated: chunks.length + 1,
	            chunksCreated: chunks.length,
	            entitiesExtracted: rootEntities.length,
	            storedIn: ["state-store"],
	          } satisfies IngestMemoryResponse,
          rootArtifact,
          chunks,
        };
      });

	      const [workingMemoryOk, semanticStoreOk, graphStoreOk] = await Promise.all([
	        redisAdapter.rememberRecent(
	          request.scope,
	          id,
          result.rootArtifact.id,
          ...result.chunks.map((chunk) => chunk.artifact.id),
        ),
        weaviateAdapter.upsertChunks(result.chunks, id),
	        neo4jAdapter.upsertMemory(result.rootArtifact, result.chunks, id),
	        ...(afterIngest ? [afterIngest(result.rootArtifact, result.chunks)] : []),
	      ]);
	      result.response.storedIn = buildStoredIn([
	        ["working-memory", Boolean(workingMemoryOk)],
	        ["semantic-store", Boolean(semanticStoreOk)],
	        ["graph-store", Boolean(graphStoreOk)],
	      ]);

	      return result.response;
    },
    recall: async ({ request, state, limit }: RecallSelection): Promise<ModuleRecallResult> => {
      const queryTokens = tokenize(request.query);
      const queryEntities = extractEntities(request.query);
      const augmentations = await collectAugmentations({
        request,
        state,
        queryEntities,
        redisAdapter,
        weaviateAdapter,
        neo4jAdapter,
        moduleId: id,
      });
      if (afterRecallAugmentations) {
        const extra = await afterRecallAugmentations(queryEntities, state);
        for (const [artifactId, score] of extra.graphHits) {
          const current = augmentations.graphHits.get(artifactId) ?? 0;
          augmentations.graphHits.set(artifactId, Math.max(current, score));
        }
        augmentations.storesQueried.push(...extra.storesQueried);
      }

      const filteredChunks = state.chunks.filter((chunk) => {
        const moduleOk = supportedTypes.includes(chunk.artifact.type);
        const scopeOk = scopeMatches(request.scope, chunk.artifact.scope);
        const typeOk =
          !request.memoryTypes || request.memoryTypes.length === 0
            ? true
            : request.memoryTypes.includes(chunk.artifact.type);
        return moduleOk && scopeOk && typeOk;
      });

      const ranked = filteredChunks
        .map((chunk) => rankChunk(chunk, queryTokens, queryEntities, augmentations))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit * 4);

      return {
        ranked,
        storesQueried: augmentations.storesQueried,
      };
    },
    reindex: async (state): Promise<ReindexResponse> => {
      rebuildAllGraphState(state);
      const moduleChunks = state.chunks.filter((chunk) => supportedTypes.includes(chunk.artifact.type));
      await Promise.all([
        weaviateAdapter.upsertChunks(moduleChunks, id),
        neo4jAdapter.reindexFromState(state),
        ...(afterReindex ? [afterReindex(state)] : []),
      ]);

      return {
        accepted: true,
        artifactsProcessed: state.artifacts.filter((artifact) => supportedTypes.includes(artifact.type)).length,
        chunksRecomputed: moduleChunks.length,
        graphNodesRecomputed: state.graphNodes.length,
      };
    },
    getWorkflowDefinitions: () => workflowDefinitions,
    executeWorkflow: async (workflowId, state): Promise<WorkflowExecutionResult | undefined> => {
      const definition = workflowDefinitions.find((workflow) => workflow.id === workflowId);
      if (!definition) {
        return undefined;
      }

      const moduleChunks = state.chunks.filter((chunk) => supportedTypes.includes(chunk.artifact.type));

      if (id === "episodic") {
        if (workflowId === "episodic.temporal-link") {
          const groups = new Map<string, StoredChunk[]>();
          let backend = context.temporalGraphAdapter.backend;
          for (const chunk of moduleChunks) {
            const current = groups.get(chunk.parentId) ?? [];
            current.push(chunk);
            groups.set(chunk.parentId, current);
          }

          let episodesWritten = 0;
          for (const [parentId, chunks] of groups) {
            const root = state.artifacts.find((artifact) => artifact.id === parentId);
            if (!root) {
              continue;
            }
            const result = await context.temporalGraphAdapter.upsertEpisode(root, chunks);
            episodesWritten += result.episodesWritten;
            backend = result.backend;
          }

          return {
            workflowId,
            moduleId: id,
            executed: true,
            backend,
            details: `Updated temporal links for ${episodesWritten} episodic chunks.`,
          };
        }

        if (workflowId === "episodic.timeline-rebuild") {
          await context.temporalGraphAdapter.reindexEpisodes(state);
          return {
            workflowId,
            moduleId: id,
            executed: true,
            backend: context.temporalGraphAdapter.backend,
            details: "Rebuilt episodic timeline projections from persisted state.",
          };
        }
      }

      if (id === "semantic") {
        await context.weaviateAdapter.upsertChunks(moduleChunks, id);
        return {
          workflowId,
          moduleId: id,
          executed: true,
          details:
            workflowId === "semantic.reembed"
              ? `Re-embedded ${moduleChunks.length} semantic chunks.`
              : `Consolidation sweep completed for ${moduleChunks.length} semantic chunks.`,
        };
      }

      if (id === "procedural") {
        await context.weaviateAdapter.upsertChunks(moduleChunks, id);
        await context.neo4jAdapter.reindexFromState(state);
        return {
          workflowId,
          moduleId: id,
          executed: true,
          details:
            workflowId === "procedural.normalize-traces"
              ? `Normalized ${moduleChunks.length} procedural chunks into reusable traces.`
              : `Consolidated procedural skills from ${moduleChunks.length} chunks.`,
        };
      }

      return {
        workflowId,
        moduleId: id,
        executed: true,
        details: definition.description,
      };
    },
  };
};

export const createMemoryModules = (context: ModuleContext): MemoryModule[] => [
  createModule({
    id: "semantic",
    supportedTypes: ["semantic", "working", "graph"],
    context,
    inferType: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes("fact") || lower.includes("concept") || lower.includes("knowledge")) {
        return "semantic";
      }
      return undefined;
    },
    recallBias: (request) => {
      if (request.memoryTypes?.includes("semantic")) {
        return 1;
      }
      return /fact|concept|what is|define|knowledge/i.test(request.query) ? 0.95 : 0.7;
    },
    workflowDefinitions: [
      {
        id: "semantic.reembed",
        moduleId: "semantic",
        trigger: "ingest",
        stage: "post",
        description: "Refresh semantic embeddings and concept summaries after semantic ingest.",
      },
    {
      id: "semantic.consolidate",
      moduleId: "semantic",
      trigger: "scheduled",
      stage: "maintenance",
      description: "Consolidate duplicate concepts and refresh vector salience.",
    },
    {
      id: "semantic.distill-from-episode",
      moduleId: "semantic",
      trigger: "threshold",
      stage: "lifecycle",
      description: "Distill durable facts and stable constraints from compacted episodes.",
    },
  ],
  }),
  createModule({
    id: "episodic",
    supportedTypes: ["episodic"],
    context,
    inferType: (content) => {
      const lower = content.toLowerCase();
      return lower.includes("event") || lower.includes("incident") || lower.includes("met ")
        ? "episodic"
        : undefined;
    },
    recallBias: (request) => {
      if (request.memoryTypes?.includes("episodic")) {
        return 1;
      }
      return /event|incident|happened|when|interaction|timeline/i.test(request.query) ? 0.9 : 0.45;
    },
    workflowDefinitions: [
      {
        id: "episodic.temporal-link",
        moduleId: "episodic",
        trigger: "ingest",
        stage: "post",
        description: "Link new episodes into the temporal graph and update sequence edges.",
      },
    {
      id: "episodic.timeline-rebuild",
      moduleId: "episodic",
      trigger: "reindex",
      stage: "maintenance",
      description: "Rebuild episodic timeline projections from stored memory artifacts.",
    },
    {
      id: "episodic.promote-from-conversation",
      moduleId: "episodic",
      trigger: "threshold",
      stage: "lifecycle",
      description: "Promote compacted conversation windows into episodic memories when context pressure rises.",
    },
  ],
    afterIngest: async (rootArtifact, chunks) => {
      await context.temporalGraphAdapter.upsertEpisode(rootArtifact, chunks);
    },
    afterRecallAugmentations: async (queryEntities, state) => {
      const episodicChunks = state.chunks.filter((chunk) => chunk.artifact.type === "episodic");
      return {
        graphHits: await context.temporalGraphAdapter.searchTimeline(queryEntities, episodicChunks),
        storesQueried: ["temporal-graph"],
      };
    },
    afterReindex: async (state) => {
      await context.temporalGraphAdapter.reindexEpisodes(state);
    },
  }),
  createModule({
    id: "procedural",
    supportedTypes: ["procedural"],
    context,
    inferType: (content) => {
      const lower = content.toLowerCase();
      return lower.includes("step") || lower.includes("workflow") || lower.includes("runbook")
        ? "procedural"
        : undefined;
    },
    recallBias: (request) => {
      if (request.memoryTypes?.includes("procedural")) {
        return 1;
      }
      return /step|workflow|runbook|how to|procedure|tool/i.test(request.query) ? 0.95 : 0.55;
    },
    workflowDefinitions: [
      {
        id: "procedural.normalize-traces",
        moduleId: "procedural",
        trigger: "ingest",
        stage: "post",
        description: "Normalize procedural traces into reusable step sequences and tool patterns.",
      },
    {
      id: "procedural.skill-consolidation",
      moduleId: "procedural",
      trigger: "scheduled",
      stage: "maintenance",
      description: "Consolidate procedural patterns into reusable workflow skill memories.",
    },
    {
      id: "procedural.extract-from-repetition",
      moduleId: "procedural",
      trigger: "threshold",
      stage: "lifecycle",
      description: "Extract reusable procedure memory from repeated or step-like compacted dialogue.",
    },
  ],
  }),
];

export const createDefaultTemporalGraphAdapter = (
  config: AppConfig,
): TemporalGraphAdapter =>
  config.temporalGraphBackend === "graphiti-python"
    ? new GraphitiPythonTemporalGraphAdapter(config)
    : config.temporalGraphBackend === "graphiti-scaffold"
    ? new GraphitiTemporalGraphAdapter(config)
    : new Neo4jTemporalGraphAdapter(config);
