export type MemoryType =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "graph";

export type MemoryScope =
  | "session"
  | "agent"
  | "user"
  | "user-profile"
  | "workspace"
  | "global"
  | `project:${string}`
  | `skill:${string}`
  | `session:${string}`;

const MEMORY_TYPES = new Set<MemoryType>(["working", "episodic", "semantic", "procedural", "graph"]);
const FIXED_MEMORY_SCOPES = new Set<string>(["session", "agent", "user", "user-profile", "workspace", "global"]);
const CONVERSATION_ROLES = new Set<ConversationTurn["role"]>(["system", "user", "assistant", "tool"]);

export class ValidationError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const isMemoryType = (value: unknown): value is MemoryType =>
  typeof value === "string" && MEMORY_TYPES.has(value as MemoryType);

export const isMemoryScope = (value: unknown): value is MemoryScope => {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (FIXED_MEMORY_SCOPES.has(trimmed)) {
    return true;
  }

  return /^(project|skill|session):[a-zA-Z0-9][a-zA-Z0-9._/@-]{0,127}$/u.test(trimmed);
};

const asRecord = (payload: unknown, label: string): Record<string, unknown> => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError(`${label} must be a JSON object.`);
  }
  return payload as Record<string, unknown>;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${key} must be a non-empty string.`);
  }
  return value.trim();
};

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const requiredScope = (record: Record<string, unknown>, key = "scope"): MemoryScope => {
  const value = requiredString(record, key);
  if (!isMemoryScope(value)) {
    throw new ValidationError(
      `${key} must be one of session, agent, user, user-profile, workspace, global, project:<id>, skill:<id>, or session:<id>.`,
    );
  }
  return value;
};

const optionalScope = (record: Record<string, unknown>, key = "scope"): MemoryScope | undefined => {
  const value = optionalString(record, key);
  if (!value) {
    return undefined;
  }
  if (!isMemoryScope(value)) {
    throw new ValidationError(
      `${key} must be one of session, agent, user, user-profile, workspace, global, project:<id>, skill:<id>, or session:<id>.`,
    );
  }
  return value;
};

const optionalStringArray = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ValidationError(`${key} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
};

const optionalBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ValidationError(`${key} must be a boolean.`);
  }
  return value;
};

const optionalNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${key} must be a finite number.`);
  }
  return value;
};

export interface Provenance {
  source: string;
  sourceId?: string;
  observedAt: string;
  ingestedAt: string;
}

export interface MemoryArtifact {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  summary?: string;
  confidence: number;
  tags: string[];
  provenance: Provenance;
  linkedArtifactIds: string[];
  modelVersion?: string;
  createdAt: string;
  updatedAt: string;
  salience?: number;
  reinforcementCount?: number;
  lastAccessedAt?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface IngestMemoryRequest {
  scope: MemoryScope;
  content: string;
  source: string;
  sourceId?: string;
  observedAt?: string;
  tags?: string[];
  typeHint?: MemoryType;
  sessionId?: string;
}

export const parseIngestMemoryRequest = (payload: unknown): IngestMemoryRequest => {
  const record = asRecord(payload, "Ingest memory request");
  const typeHint = optionalString(record, "typeHint");
  if (typeHint && !isMemoryType(typeHint)) {
    throw new ValidationError("typeHint must be one of working, episodic, semantic, procedural, or graph.");
  }

  const request: IngestMemoryRequest = {
    scope: requiredScope(record),
    content: requiredString(record, "content"),
    source: requiredString(record, "source"),
  };
  const sourceId = optionalString(record, "sourceId");
  const observedAt = optionalString(record, "observedAt");
  const tags = optionalStringArray(record, "tags");
  const sessionId = optionalString(record, "sessionId");
  if (sourceId) request.sourceId = sourceId;
  if (observedAt) request.observedAt = observedAt;
  if (tags) request.tags = tags;
  if (typeHint) request.typeHint = typeHint as MemoryType;
  if (sessionId) request.sessionId = sessionId;
  return request;
};

export interface IngestMemoryResponse {
  memoryId: string;
  accepted: boolean;
  deduplicated: boolean;
  artifactsCreated: number;
  chunksCreated: number;
  entitiesExtracted: number;
  storedIn: string[];
}

export interface RecallMemoryRequest {
  query: string;
  scope?: MemoryScope;
  memoryTypes?: MemoryType[];
  limit?: number;
  includeDiagnostics?: boolean;
  sessionId?: string;
}

export const parseRecallMemoryRequest = (payload: unknown): RecallMemoryRequest => {
  const record = asRecord(payload, "Recall memory request");
  const memoryTypes = optionalStringArray(record, "memoryTypes");
  if (memoryTypes?.some((type) => !isMemoryType(type))) {
    throw new ValidationError("memoryTypes entries must be working, episodic, semantic, procedural, or graph.");
  }
  const limit = optionalNumber(record, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new ValidationError("limit must be an integer between 1 and 50.");
  }

  const request: RecallMemoryRequest = {
    query: requiredString(record, "query"),
  };
  const scope = optionalScope(record);
  const includeDiagnostics = optionalBoolean(record, "includeDiagnostics");
  const sessionId = optionalString(record, "sessionId");
  if (scope) request.scope = scope;
  if (memoryTypes) request.memoryTypes = memoryTypes as MemoryType[];
  if (limit !== undefined) request.limit = limit;
  if (includeDiagnostics !== undefined) request.includeDiagnostics = includeDiagnostics;
  if (sessionId) request.sessionId = sessionId;
  return request;
};

export interface RecallCandidate {
  artifactId: string;
  score: number;
  source: "vector" | "sparse" | "graph" | "working";
  reasoning: string;
}

export interface RecallMemoryResponse {
  query: string;
  context: MemoryArtifact[];
  candidates: RecallCandidate[];
  diagnostics?: {
    storesQueried: string[];
    reranked: boolean;
    totalCandidates?: number;
    queryEntities?: string[];
    appliedScope?: MemoryScope | "all";
    elapsedMs?: number;
  };
}

export interface ConversationTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt?: string;
}

export interface CompactionCandidate {
  moduleId: "semantic" | "episodic" | "procedural";
  content: string;
  score: number;
  reason: string;
  tags: string[];
}

export interface CompactConversationRequest {
  scope: MemoryScope;
  messages: ConversationTurn[];
  sessionId?: string;
  conversationId?: string;
  currentWindowTokens?: number;
  maxWindowTokens?: number;
  occupancyRatio?: number;
  thresholdRatio?: number;
  force?: boolean;
}

export const parseCompactConversationRequest = (payload: unknown): CompactConversationRequest => {
  const record = asRecord(payload, "Compact conversation request");
  const rawMessages = record.messages;
  if (!Array.isArray(rawMessages)) {
    throw new ValidationError("messages must be an array.");
  }

  const messages = rawMessages.map((message, index): ConversationTurn => {
    const entry = asRecord(message, `messages[${index}]`);
    const role = requiredString(entry, "role");
    if (!CONVERSATION_ROLES.has(role as ConversationTurn["role"])) {
      throw new ValidationError(`messages[${index}].role must be system, user, assistant, or tool.`);
    }
    const turn: ConversationTurn = {
      role: role as ConversationTurn["role"],
      content: requiredString(entry, "content"),
    };
    const createdAt = optionalString(entry, "createdAt");
    if (createdAt) turn.createdAt = createdAt;
    return turn;
  });

  const request: CompactConversationRequest = {
    scope: requiredScope(record),
    messages,
  };
  const sessionId = optionalString(record, "sessionId");
  const conversationId = optionalString(record, "conversationId");
  const currentWindowTokens = optionalNumber(record, "currentWindowTokens");
  const maxWindowTokens = optionalNumber(record, "maxWindowTokens");
  const occupancyRatio = optionalNumber(record, "occupancyRatio");
  const thresholdRatio = optionalNumber(record, "thresholdRatio");
  const force = optionalBoolean(record, "force");
  if (sessionId) request.sessionId = sessionId;
  if (conversationId) request.conversationId = conversationId;
  if (currentWindowTokens !== undefined) request.currentWindowTokens = currentWindowTokens;
  if (maxWindowTokens !== undefined) request.maxWindowTokens = maxWindowTokens;
  if (occupancyRatio !== undefined) request.occupancyRatio = occupancyRatio;
  if (thresholdRatio !== undefined) request.thresholdRatio = thresholdRatio;
  if (force !== undefined) request.force = force;
  return request;
};

export interface CompactConversationResponse {
  triggered: boolean;
  reason: string;
  occupancyRatio: number;
  workingSummary: string;
  openLoops: string[];
  discardedMessageCount: number;
  promoted: {
    episodic: string[];
    semantic: string[];
    procedural: string[];
  };
  candidates: CompactionCandidate[];
}

export interface FeedbackMemoryRequest {
  artifactId: string;
  useful: boolean;
  notes?: string;
}

export const parseFeedbackMemoryRequest = (payload: unknown): FeedbackMemoryRequest => {
  const record = asRecord(payload, "Feedback memory request");
  const useful = record.useful;
  if (typeof useful !== "boolean") {
    throw new ValidationError("useful must be a boolean.");
  }

  const request: FeedbackMemoryRequest = {
    artifactId: requiredString(record, "artifactId"),
    useful,
  };
  const notes = optionalString(record, "notes");
  if (notes) request.notes = notes;
  return request;
};

export interface FeedbackMemoryResponse {
  artifactId: string;
  updated: boolean;
  reinforcementCount: number;
  salience: number;
}

export interface UpdateMemoryRequest {
  artifactId: string;
  content?: string;
  summary?: string;
  tags?: string[];
  salience?: number;
  confidence?: number;
  metadata?: Record<string, string | number | boolean>;
}

const optionalMetadata = (
  record: Record<string, unknown>,
  key: string,
): Record<string, string | number | boolean> | undefined => {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${key} must be an object.`);
  }
  const metadata: Record<string, string | number | boolean> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entryValue !== "string" &&
      typeof entryValue !== "number" &&
      typeof entryValue !== "boolean"
    ) {
      throw new ValidationError(`${key}.${entryKey} must be a string, number, or boolean.`);
    }
    metadata[entryKey] = entryValue;
  }
  return metadata;
};

export const parseUpdateMemoryRequest = (
  payload: unknown,
  artifactId: string,
): UpdateMemoryRequest => {
  const record = asRecord(payload, "Update memory request");
  const request: UpdateMemoryRequest = { artifactId };
  const content = optionalString(record, "content");
  const summary = optionalString(record, "summary");
  const tags = optionalStringArray(record, "tags");
  const salience = optionalNumber(record, "salience");
  const confidence = optionalNumber(record, "confidence");
  const metadata = optionalMetadata(record, "metadata");

  if (salience !== undefined && (salience < 0 || salience > 1)) {
    throw new ValidationError("salience must be between 0 and 1.");
  }
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    throw new ValidationError("confidence must be between 0 and 1.");
  }
  if (content) request.content = content;
  if (summary) request.summary = summary;
  if (tags) request.tags = tags;
  if (salience !== undefined) request.salience = salience;
  if (confidence !== undefined) request.confidence = confidence;
  if (metadata) request.metadata = metadata;
  return request;
};

export interface UpdateMemoryResponse {
  artifactId: string;
  updated: boolean;
}

export interface DeleteMemoryResponse {
  deleted: number;
  artifactIds: string[];
}

export interface ExportMemoryResponse {
  exportedAt: string;
  artifacts: MemoryArtifact[];
}

export interface MemoryHealth {
  status: "ok";
  persistenceFile: string;
  artifactCount: number;
  chunkCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
}

export interface ReindexResponse {
  accepted: boolean;
  artifactsProcessed: number;
  chunksRecomputed: number;
  graphNodesRecomputed: number;
}

export interface ModuleObservabilitySnapshot {
  moduleId: "semantic" | "episodic" | "procedural";
  artifactCount: number;
  chunkCount: number;
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
  averageIngestLatencyMs: number;
  averageRecallLatencyMs: number;
  lastActivityAt?: string;
}

export interface WorkerHeartbeat {
  service: "memory-api" | "worker";
  status: "ok";
  timestamp: string;
}
