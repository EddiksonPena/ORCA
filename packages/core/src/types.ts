import type {
  IngestMemoryRequest,
  IngestMemoryResponse,
  MemoryArtifact,
  MemoryScope,
  MemoryType,
  RecallCandidate,
  RecallMemoryRequest,
  ReindexResponse,
} from "@orca/schemas";

export type MemoryModuleId = "semantic" | "episodic" | "procedural";

export interface StoredChunk {
  artifact: MemoryArtifact;
  parentId: string;
  chunkIndex: number;
  entities: string[];
  lexicalTokens: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: "co_occurs_with";
  weight: number;
}

export interface PersistedState {
  artifacts: MemoryArtifact[];
  chunks: StoredChunk[];
  graphNodes: string[];
  graphEdges: GraphEdge[];
  workflowRuns: WorkflowRunRecord[];
  moduleMetrics: Record<MemoryModuleId, ModuleMetrics>;
}

export interface StateStore {
  read(): Promise<PersistedState>;
  write(state: PersistedState): Promise<void>;
  update<T>(mutate: (state: PersistedState) => Promise<T> | T): Promise<T>;
  describe(): string;
}

export interface ModuleMetrics {
  moduleId: MemoryModuleId;
  ingestCount: number;
  deduplicatedCount: number;
  artifactWriteCount: number;
  chunkWriteCount: number;
  recallQueryCount: number;
  recallHitCount: number;
  feedbackCount: number;
  positiveFeedbackCount: number;
  workflowScheduledCount: number;
  workflowCompletedCount: number;
  workflowFailedCount: number;
  totalIngestLatencyMs: number;
  totalRecallLatencyMs: number;
  lastActivityAt?: string;
}

export interface RetrievalAugmentations {
  vectorHits: Map<string, number>;
  graphHits: Map<string, number>;
  workingHits: Set<string>;
  storesQueried: string[];
}

export interface RankedChunk {
  chunk: StoredChunk;
  score: number;
  primarySource: RecallCandidate["source"];
  reasoning: string;
}

export interface ModuleRecallResult {
  ranked: RankedChunk[];
  storesQueried: string[];
}

export interface RecallSelection {
  request: RecallMemoryRequest;
  state: PersistedState;
  limit: number;
}

export interface WorkflowDefinition {
  id: string;
  moduleId: MemoryModuleId;
  trigger: "ingest" | "feedback" | "reindex" | "scheduled" | "threshold";
  stage: "pre" | "post" | "maintenance" | "lifecycle";
  description: string;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  moduleId: MemoryModuleId;
  executed: boolean;
  backend?: string;
  mode?: "local" | "temporal";
  details: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  moduleId: MemoryModuleId;
  mode: "local" | "temporal";
  status: "scheduled" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  details: string;
  backend?: string;
  temporalWorkflowId?: string;
}

export interface TemporalEpisodeUpsert {
  backend: "neo4j-temporal" | "graphiti-python" | "graphiti-scaffold";
  episodesWritten: number;
}

export interface TemporalGraphAdapter {
  readonly backend: "neo4j-temporal" | "graphiti-python" | "graphiti-scaffold";
  upsertEpisode(rootArtifact: MemoryArtifact, chunks: StoredChunk[]): Promise<TemporalEpisodeUpsert>;
  searchTimeline(queryEntities: string[], candidateChunks: StoredChunk[]): Promise<Map<string, number>>;
  reindexEpisodes(state: PersistedState): Promise<void>;
}

export interface MemoryModule {
  id: MemoryModuleId;
  supportedTypes: MemoryType[];
  canHandleType(type: MemoryType): boolean;
  canRecall(request: RecallMemoryRequest): number;
  inferType(content: string): MemoryType | undefined;
  ingest(request: IngestMemoryRequest): Promise<IngestMemoryResponse>;
  recall(selection: RecallSelection): Promise<ModuleRecallResult>;
  reindex(state: PersistedState): Promise<ReindexResponse>;
  getWorkflowDefinitions(): WorkflowDefinition[];
  executeWorkflow(workflowId: string, state: PersistedState): Promise<WorkflowExecutionResult | undefined>;
}

export const EMPTY_STATE: PersistedState = {
  artifacts: [],
  chunks: [],
  graphNodes: [],
  graphEdges: [],
  workflowRuns: [],
  moduleMetrics: {
    semantic: {
      moduleId: "semantic",
      ingestCount: 0,
      deduplicatedCount: 0,
      artifactWriteCount: 0,
      chunkWriteCount: 0,
      recallQueryCount: 0,
      recallHitCount: 0,
      feedbackCount: 0,
      positiveFeedbackCount: 0,
      workflowScheduledCount: 0,
      workflowCompletedCount: 0,
      workflowFailedCount: 0,
      totalIngestLatencyMs: 0,
      totalRecallLatencyMs: 0,
    },
    episodic: {
      moduleId: "episodic",
      ingestCount: 0,
      deduplicatedCount: 0,
      artifactWriteCount: 0,
      chunkWriteCount: 0,
      recallQueryCount: 0,
      recallHitCount: 0,
      feedbackCount: 0,
      positiveFeedbackCount: 0,
      workflowScheduledCount: 0,
      workflowCompletedCount: 0,
      workflowFailedCount: 0,
      totalIngestLatencyMs: 0,
      totalRecallLatencyMs: 0,
    },
    procedural: {
      moduleId: "procedural",
      ingestCount: 0,
      deduplicatedCount: 0,
      artifactWriteCount: 0,
      chunkWriteCount: 0,
      recallQueryCount: 0,
      recallHitCount: 0,
      feedbackCount: 0,
      positiveFeedbackCount: 0,
      workflowScheduledCount: 0,
      workflowCompletedCount: 0,
      workflowFailedCount: 0,
      totalIngestLatencyMs: 0,
      totalRecallLatencyMs: 0,
    },
  },
};

export const moduleForType = (type: MemoryType): MemoryModuleId =>
  type === "episodic" ? "episodic" : type === "procedural" ? "procedural" : "semantic";

export const supportsRequestedTypes = (
  supportedTypes: MemoryType[],
  requestedTypes: MemoryType[] | undefined,
): boolean =>
  !requestedTypes || requestedTypes.length === 0
    ? true
    : requestedTypes.some((type) => supportedTypes.includes(type));

export const scopeMatches = (scope: MemoryScope | undefined, candidateScope: MemoryScope): boolean =>
  !scope || scope === candidateScope;
