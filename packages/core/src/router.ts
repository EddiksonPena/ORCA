import type { AppConfig } from "@orca/config";
import type {
  CompactConversationRequest,
  CompactConversationResponse,
  DeleteMemoryResponse,
  ExportMemoryResponse,
  FeedbackMemoryRequest,
  FeedbackMemoryResponse,
  IngestMemoryRequest,
  IngestMemoryResponse,
  MemoryArtifact,
  MemoryHealth,
  ModuleObservabilitySnapshot,
  MemoryScope,
  RecallCandidate,
  RecallMemoryRequest,
  RecallMemoryResponse,
  ReindexResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
} from "@orca/schemas";

import {
  Neo4jGraphAdapter,
  RedisWorkingMemoryAdapter,
  WeaviateSemanticAdapter,
} from "./adapters.js";
import { createEmbeddingService } from "./embeddings.js";
import { createDefaultTemporalGraphAdapter, createMemoryModules } from "./modules.js";
import { createStateStore } from "./state.js";
import { buildPromotionRequest, planConversationCompaction, toCompactionResponse } from "./lifecycle.js";
import type {
  MemoryModule,
  ModuleMetrics,
  WorkflowDefinition,
  WorkflowExecutionResult,
  WorkflowRunRecord,
} from "./types.js";
import { executeWorkflowViaTemporal, startWorkflowViaTemporal } from "./temporal/client.js";
import { moduleForType, supportsRequestedTypes } from "./types.js";
import { createStableId } from "./utils.js";
import { computeSalience, rebuildAllGraphState, roundScore, updateArtifactsAfterRecall } from "./utils.js";

export interface MemoryOs {
  getHealth(): Promise<MemoryHealth>;
  ingest(request: IngestMemoryRequest): Promise<IngestMemoryResponse>;
  recall(request: RecallMemoryRequest): Promise<RecallMemoryResponse>;
  feedback(request: FeedbackMemoryRequest): Promise<FeedbackMemoryResponse>;
  updateMemory(request: UpdateMemoryRequest): Promise<UpdateMemoryResponse>;
  deleteMemory(artifactId: string): Promise<DeleteMemoryResponse>;
  wipeScope(scope: MemoryScope): Promise<DeleteMemoryResponse>;
  exportMemories(scope?: MemoryScope): Promise<ExportMemoryResponse>;
  listMemories(scope?: MemoryScope): Promise<MemoryArtifact[]>;
  reindex(): Promise<ReindexResponse>;
  getWorkflowDefinitions(): Promise<WorkflowDefinition[]>;
  getWorkflowRuns(): Promise<WorkflowRunRecord[]>;
  getModuleMetrics(): Promise<ModuleObservabilitySnapshot[]>;
  compactConversation(request: CompactConversationRequest): Promise<CompactConversationResponse>;
  executeWorkflow(workflowId: string): Promise<WorkflowExecutionResult>;
  executeWorkflowDirect(workflowId: string): Promise<WorkflowExecutionResult>;
  completeWorkflowRun(runId: string, result: WorkflowExecutionResult, temporalWorkflowId?: string): Promise<void>;
}

export const createMemoryRouter = (config: AppConfig): MemoryOs => {
  const stateStore = createStateStore(config);
  const persistenceFile = stateStore.describe();
  const embeddingService = createEmbeddingService(config);
  const redisAdapter = new RedisWorkingMemoryAdapter(config.redisUrl);
  const weaviateAdapter = new WeaviateSemanticAdapter(config.weaviateHttpUrl, embeddingService);
  const neo4jAdapter = new Neo4jGraphAdapter(config);
  const temporalGraphAdapter = createDefaultTemporalGraphAdapter(config);
  const modules = createMemoryModules({
    config,
    stateStore,
    redisAdapter,
    weaviateAdapter,
    neo4jAdapter,
    temporalGraphAdapter,
  });

  const selectIngestModule = (request: IngestMemoryRequest): MemoryModule => {
    const explicit = request.typeHint
      ? modules.find((module) => module.canHandleType(request.typeHint!))
      : undefined;
    if (explicit) {
      return explicit;
    }

    return (
      modules.find((module) => module.inferType(request.content) !== undefined) ??
      modules.find((module) => module.id === "semantic")!
    );
  };

  const selectRecallModules = (request: RecallMemoryRequest): MemoryModule[] =>
    modules
      .filter((module) => supportsRequestedTypes(module.supportedTypes, request.memoryTypes))
      .map((module) => ({ module, score: module.canRecall(request) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.module);

  const executeWorkflowDirect = async (workflowId: string): Promise<WorkflowExecutionResult> => {
    return stateStore.update(async (state) => {
      for (const module of modules) {
        const result = await module.executeWorkflow(workflowId, state);
        if (result) {
          return {
            ...result,
            mode: "local",
          };
        }
      }

      return {
        workflowId,
        moduleId: "semantic",
        executed: false,
        mode: "local",
        details: "Workflow definition not found.",
      };
    });
  };

  const listWorkflowDefinitions = (): WorkflowDefinition[] =>
    modules.flatMap((module) => module.getWorkflowDefinitions());

  const appendWorkflowRun = async (
    record: WorkflowRunRecord,
  ): Promise<void> => {
    await stateStore.update((state) => {
      state.workflowRuns.unshift(record);
      state.workflowRuns = state.workflowRuns.slice(0, 200);
    });
  };

  const updateWorkflowRun = async (
    runId: string,
    patch: Partial<WorkflowRunRecord>,
  ): Promise<void> => {
    await stateStore.update((state) => {
      const run = state.workflowRuns.find((candidate) => candidate.id === runId);
      if (!run) {
        return;
      }
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    });
  };

  const updateModuleMetrics = async (
    moduleId: ReturnType<typeof moduleForType>,
    update: (metrics: ModuleMetrics) => void,
  ): Promise<void> => {
    await stateStore.update((state) => {
      update(state.moduleMetrics[moduleId]);
    });
  };

  const completeWorkflowRun = async (
    runId: string,
    result: WorkflowExecutionResult,
    temporalWorkflowId?: string,
  ): Promise<void> => {
    const nextStatus = result.executed ? "completed" : "failed";
    await updateWorkflowRun(runId, {
      status: nextStatus,
      mode: result.mode ?? "temporal",
      details: result.details,
      ...(result.backend ? { backend: result.backend } : {}),
      ...(temporalWorkflowId ? { temporalWorkflowId } : {}),
    });
    await updateModuleMetrics(result.moduleId, (metrics) => {
      if (nextStatus === "completed") {
        metrics.workflowCompletedCount += 1;
      } else {
        metrics.workflowFailedCount += 1;
      }
      metrics.lastActivityAt = new Date().toISOString();
    });
  };

  const autoTriggerWorkflows = async (trigger: WorkflowDefinition["trigger"], moduleId?: string): Promise<void> => {
    if (!config.autoTriggerWorkflows) {
      return;
    }

    const workflows = listWorkflowDefinitions().filter(
      (workflow) => workflow.trigger === trigger && (!moduleId || workflow.moduleId === moduleId),
    );

    for (const workflow of workflows) {
      const runId = createStableId(`${workflow.id}:${Date.now()}:${Math.random()}`);
      const createdAt = new Date().toISOString();
      await appendWorkflowRun({
        id: runId,
        workflowId: workflow.id,
        moduleId: workflow.moduleId,
        mode: config.temporalExecutionMode === "local" ? "local" : "temporal",
        status: "scheduled",
        createdAt,
        updatedAt: createdAt,
        details: `Scheduled automatically after ${trigger}.`,
      });
      await updateModuleMetrics(workflow.moduleId, (metrics) => {
        metrics.workflowScheduledCount += 1;
        metrics.lastActivityAt = createdAt;
      });

      if (config.temporalExecutionMode !== "local") {
        try {
          const started = await startWorkflowViaTemporal(config, workflow.id, runId);
          await updateWorkflowRun(runId, {
            temporalWorkflowId: started.temporalWorkflowId,
            details: `Scheduled automatically after ${trigger}.`,
          });
          continue;
        } catch (error) {
          if (config.temporalExecutionMode === "temporal") {
            await updateWorkflowRun(runId, {
              status: "failed",
              backend: "temporal",
              details: `Temporal scheduling failed: ${(error as Error).message}`,
            });
            await updateModuleMetrics(workflow.moduleId, (metrics) => {
              metrics.workflowFailedCount += 1;
              metrics.lastActivityAt = new Date().toISOString();
            });
            continue;
          }
        }
      }

      const result = await executeWorkflowDirect(workflow.id);
      await completeWorkflowRun(runId, {
        ...result,
        mode: "local",
      });
    }
  };

  return {
    getHealth: async () => {
      const state = await stateStore.read();
      return {
        status: "ok",
        persistenceFile,
        artifactCount: state.artifacts.length,
        chunkCount: state.chunks.length,
        graphNodeCount: state.graphNodes.length,
        graphEdgeCount: state.graphEdges.length,
      };
    },

    ingest: async (request) => {
      const startedAt = Date.now();
      const module = selectIngestModule(request);
      const fallbackType = module.supportedTypes[0];
      if (!fallbackType) {
        throw new Error(`Module ${module.id} does not declare any supported types.`);
      }
      const routedType = request.typeHint ?? module.inferType(request.content) ?? fallbackType;
      const result = await module.ingest(
        request.typeHint === routedType
          ? request
          : {
              ...request,
              typeHint: routedType,
          },
      );
      await updateModuleMetrics(module.id, (metrics) => {
        metrics.ingestCount += 1;
        metrics.artifactWriteCount += result.artifactsCreated;
        metrics.chunkWriteCount += result.chunksCreated;
        metrics.totalIngestLatencyMs += Date.now() - startedAt;
        if (result.deduplicated) {
          metrics.deduplicatedCount += 1;
        }
        metrics.lastActivityAt = new Date().toISOString();
      });
      await autoTriggerWorkflows("ingest", module.id);
      return result;
    },

    recall: async (request) => {
      const startedAt = Date.now();
      const state = await stateStore.read();
      const limit = request.limit ?? 5;
      const selectedModules = selectRecallModules(request);
      const moduleResults = await Promise.all(
        selectedModules.map((module) => module.recall({ request, state, limit })),
      );

      const ranked = moduleResults
        .flatMap((result) => result.ranked)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit * 4);

      const seenArtifactIds = new Set<string>();
      const candidates: RecallCandidate[] = [];
      const context: MemoryArtifact[] = [];

      for (const rankedChunk of ranked) {
        if (seenArtifactIds.has(rankedChunk.chunk.artifact.id)) {
          continue;
        }

        seenArtifactIds.add(rankedChunk.chunk.artifact.id);
        candidates.push({
          artifactId: rankedChunk.chunk.artifact.id,
          score: roundScore(rankedChunk.score),
          source: rankedChunk.primarySource,
          reasoning: rankedChunk.reasoning,
        });
        context.push(rankedChunk.chunk.artifact);
      }

      try {
        await stateStore.update((latestState) => {
          const latestContext = context
            .map((artifact) => latestState.artifacts.find((candidate) => candidate.id === artifact.id))
            .filter((artifact): artifact is MemoryArtifact => Boolean(artifact));
          updateArtifactsAfterRecall(latestState, latestContext);
        });
      } catch {
        // Recall should remain available even if best-effort salience updates lose a write race.
      }
      const elapsedMs = Date.now() - startedAt;
      const hitModules = new Map<ReturnType<typeof moduleForType>, number>();
      for (const artifact of context.slice(0, limit)) {
        const moduleId = moduleForType(artifact.type);
        hitModules.set(moduleId, (hitModules.get(moduleId) ?? 0) + 1);
      }
      for (const module of selectedModules) {
        await updateModuleMetrics(module.id, (metrics) => {
          metrics.recallQueryCount += 1;
          metrics.totalRecallLatencyMs += elapsedMs;
          metrics.recallHitCount += hitModules.get(module.id) ?? 0;
          metrics.lastActivityAt = new Date().toISOString();
        });
      }

      const diagnostics = request.includeDiagnostics
        ? {
            storesQueried: Array.from(
              new Set(moduleResults.flatMap((result) => result.storesQueried)),
            ),
            reranked: ranked.length > 1,
            totalCandidates: ranked.length,
            queryEntities: Array.from(
              new Set(
                request.query.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g) ?? [],
              ),
            ),
            appliedScope: (request.scope ?? "all") as MemoryScope | "all",
            elapsedMs: Date.now() - startedAt,
          }
        : undefined;

      return {
        query: request.query,
        context: context.slice(0, limit),
        candidates: candidates.slice(0, limit),
        ...(diagnostics ? { diagnostics } : {}),
      };
    },

    feedback: async (request) => {
      const result = await stateStore.update((state) => {
        const artifact = state.artifacts.find((candidate) => candidate.id === request.artifactId);
        if (!artifact) {
          return {
            artifactId: request.artifactId,
            updated: false,
            reinforcementCount: 0,
            salience: 0,
          };
        }

        const delta = request.useful ? 1 : -1;
        const nextCount = Math.max(0, (artifact.reinforcementCount ?? 0) + delta);
        artifact.reinforcementCount = nextCount;
        artifact.salience = computeSalience(nextCount, artifact.type);
        artifact.confidence = Math.max(
          0.1,
          Math.min(0.99, artifact.confidence + (request.useful ? 0.05 : -0.08)),
        );
        artifact.updatedAt = new Date().toISOString();

        return {
          artifactId: artifact.id,
          updated: true,
          reinforcementCount: nextCount,
          salience: artifact.salience,
          artifactType: artifact.type,
        };
      });

      if (!result.updated || !result.artifactType) {
        return result;
      }
      await updateModuleMetrics(moduleForType(result.artifactType), (metrics) => {
        metrics.feedbackCount += 1;
        if (request.useful) {
          metrics.positiveFeedbackCount += 1;
        }
        metrics.lastActivityAt = new Date().toISOString();
      });
      await autoTriggerWorkflows("feedback", moduleForType(result.artifactType));

      return {
        artifactId: result.artifactId,
        updated: true,
        reinforcementCount: result.reinforcementCount,
        salience: result.salience,
      };
    },

    updateMemory: async (request) => {
      return stateStore.update((state) => {
        const artifact = state.artifacts.find((candidate) => candidate.id === request.artifactId);
        if (!artifact) {
          return {
            artifactId: request.artifactId,
            updated: false,
          };
        }

        if (request.content) {
          artifact.content = request.content;
          if (request.summary) {
            artifact.summary = request.summary;
          }
        } else if (request.summary) {
          artifact.summary = request.summary;
        }
        if (request.tags) {
          artifact.tags = request.tags;
        }
        if (request.salience !== undefined) {
          artifact.salience = request.salience;
        }
        if (request.confidence !== undefined) {
          artifact.confidence = request.confidence;
        }
        if (request.metadata) {
          artifact.metadata = {
            ...(artifact.metadata ?? {}),
            ...request.metadata,
          };
        }
        artifact.updatedAt = new Date().toISOString();

        const chunk = state.chunks.find((candidate) => candidate.artifact.id === artifact.id);
        if (chunk && request.content) {
          chunk.entities = [];
          chunk.lexicalTokens = [];
          rebuildAllGraphState(state);
        }

        return {
          artifactId: artifact.id,
          updated: true,
        };
      });
    },

    deleteMemory: async (artifactId) => {
      return stateStore.update((state) => {
        const target = state.artifacts.find((artifact) => artifact.id === artifactId);
        if (!target) {
          return { deleted: 0, artifactIds: [] };
        }

        const ids = new Set<string>([artifactId]);
        for (const artifact of state.artifacts) {
          if (artifact.linkedArtifactIds.includes(artifactId)) {
            ids.add(artifact.id);
          }
        }
        for (const chunk of state.chunks) {
          if (chunk.parentId === artifactId || chunk.artifact.id === artifactId) {
            ids.add(chunk.artifact.id);
          }
        }

        state.artifacts = state.artifacts.filter((artifact) => !ids.has(artifact.id));
        state.chunks = state.chunks.filter((chunk) => !ids.has(chunk.artifact.id) && !ids.has(chunk.parentId));
        for (const artifact of state.artifacts) {
          artifact.linkedArtifactIds = artifact.linkedArtifactIds.filter((id) => !ids.has(id));
        }
        rebuildAllGraphState(state);
        return {
          deleted: ids.size,
          artifactIds: Array.from(ids),
        };
      });
    },

    wipeScope: async (scope) => {
      return stateStore.update((state) => {
        const ids = new Set(
          state.artifacts
            .filter((artifact) => artifact.scope === scope)
            .map((artifact) => artifact.id),
        );
        state.artifacts = state.artifacts.filter((artifact) => !ids.has(artifact.id));
        state.chunks = state.chunks.filter((chunk) => !ids.has(chunk.artifact.id) && !ids.has(chunk.parentId));
        for (const artifact of state.artifacts) {
          artifact.linkedArtifactIds = artifact.linkedArtifactIds.filter((id) => !ids.has(id));
        }
        rebuildAllGraphState(state);
        return {
          deleted: ids.size,
          artifactIds: Array.from(ids),
        };
      });
    },

    listMemories: async (scope) => {
      const state = await stateStore.read();
      return state.artifacts
        .filter((artifact) => !scope || artifact.scope === scope)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    exportMemories: async (scope) => {
      const state = await stateStore.read();
      const artifacts = state.artifacts
        .filter((artifact) => !scope || artifact.scope === scope)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return {
        exportedAt: new Date().toISOString(),
        artifacts,
      };
    },

    reindex: async () => {
      return stateStore.update(async (state) => {
        const moduleResults = await Promise.all(modules.map((module) => module.reindex(state)));

        return {
          accepted: true,
          artifactsProcessed: moduleResults.reduce((sum, result) => sum + result.artifactsProcessed, 0),
          chunksRecomputed: moduleResults.reduce((sum, result) => sum + result.chunksRecomputed, 0),
          graphNodesRecomputed: state.graphNodes.length,
        };
      });
    },

    getWorkflowDefinitions: async () =>
      listWorkflowDefinitions(),

    getWorkflowRuns: async () => {
      const state = await stateStore.read();
      return state.workflowRuns;
    },

    getModuleMetrics: async () => {
      const state = await stateStore.read();
      return (["semantic", "episodic", "procedural"] as const).map((moduleId) => {
        const metrics = state.moduleMetrics[moduleId];
        const artifactCount = state.artifacts.filter((artifact) => moduleForType(artifact.type) === moduleId).length;
        const chunkCount = state.chunks.filter((chunk) => moduleForType(chunk.artifact.type) === moduleId).length;
        return {
          moduleId,
          artifactCount,
          chunkCount,
          ingestCount: metrics.ingestCount,
          deduplicatedCount: metrics.deduplicatedCount,
          artifactWriteCount: metrics.artifactWriteCount,
          chunkWriteCount: metrics.chunkWriteCount,
          recallQueryCount: metrics.recallQueryCount,
          recallHitCount: metrics.recallHitCount,
          feedbackCount: metrics.feedbackCount,
          positiveFeedbackCount: metrics.positiveFeedbackCount,
          workflowScheduledCount: metrics.workflowScheduledCount,
          workflowCompletedCount: metrics.workflowCompletedCount,
          workflowFailedCount: metrics.workflowFailedCount,
          averageIngestLatencyMs:
            metrics.ingestCount > 0 ? roundScore(metrics.totalIngestLatencyMs / metrics.ingestCount) : 0,
          averageRecallLatencyMs:
            metrics.recallQueryCount > 0
              ? roundScore(metrics.totalRecallLatencyMs / metrics.recallQueryCount)
              : 0,
          ...(metrics.lastActivityAt ? { lastActivityAt: metrics.lastActivityAt } : {}),
        } satisfies ModuleObservabilitySnapshot;
      });
    },

    compactConversation: async (request) => {
      const plan = planConversationCompaction(request);
      if (!plan.triggered) {
        return toCompactionResponse(plan, {
          episodic: [],
          semantic: [],
          procedural: [],
        });
      }

      const promoted: CompactConversationResponse["promoted"] = {
        episodic: [],
        semantic: [],
        procedural: [],
      };

      for (const candidate of plan.candidates) {
        const promotionRequest = buildPromotionRequest(request, candidate);
        const startedAt = Date.now();
        const response = await selectIngestModule(promotionRequest).ingest(promotionRequest);
        if (candidate.moduleId === "episodic") {
          promoted.episodic.push(response.memoryId);
        } else if (candidate.moduleId === "procedural") {
          promoted.procedural.push(response.memoryId);
        } else {
          promoted.semantic.push(response.memoryId);
        }

        await updateModuleMetrics(candidate.moduleId, (metrics) => {
          metrics.ingestCount += 1;
          metrics.artifactWriteCount += response.artifactsCreated;
          metrics.chunkWriteCount += response.chunksCreated;
          metrics.totalIngestLatencyMs += Date.now() - startedAt;
          if (response.deduplicated) {
            metrics.deduplicatedCount += 1;
          }
          metrics.lastActivityAt = new Date().toISOString();
        });
        await autoTriggerWorkflows("threshold", candidate.moduleId);
      }

      return toCompactionResponse(plan, promoted);
    },

    executeWorkflow: async (workflowId) => {
      if (config.temporalExecutionMode !== "local") {
        try {
          const result = await executeWorkflowViaTemporal(config, workflowId);
          return {
            ...result,
            mode: "temporal",
          };
        } catch (error) {
          if (config.temporalExecutionMode === "temporal") {
            const candidate = error as Error;
            return {
              workflowId,
              moduleId: "semantic",
              executed: false,
              mode: "temporal",
              backend: "temporal",
              details: `Temporal execution failed: ${candidate.message}`,
            };
          }
        }
      }

      return executeWorkflowDirect(workflowId);
    },

    executeWorkflowDirect,
    completeWorkflowRun,
  };
};
