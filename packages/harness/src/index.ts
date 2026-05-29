import type {
  CompactConversationRequest,
  CompactConversationResponse,
  IngestMemoryRequest,
  IngestMemoryResponse,
  MemoryArtifact,
  MemoryScope,
  RecallMemoryRequest,
  RecallMemoryResponse,
} from "@orca/schemas";

export interface OrcaClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: unknown;
  [key: string]: unknown;
}

export type OrcaFailureMode = "block" | "degraded";

export interface MemoryHarnessOptions extends OrcaClientOptions {
  required?: boolean;
  failureMode?: OrcaFailureMode;
  defaultScope?: MemoryScope;
  bootstrapScopes?: MemoryScope[];
  source?: string;
  includeDiagnostics?: boolean;
  recallLimit?: number;
  compactionThresholdRatio?: number;
}

export interface SessionContext {
  sessionId: string;
  scope?: MemoryScope;
  projectScope?: MemoryScope;
  userScope?: MemoryScope;
  skillScope?: MemoryScope;
  source?: string;
}

export interface MemoryInjection {
  sessionId: string;
  scope: MemoryScope;
  memories: MemoryArtifact[];
  recallResponses: RecallMemoryResponse[];
  memoryBlock: string;
  diagnostics: Array<NonNullable<RecallMemoryResponse["diagnostics"]>>;
}

export interface BeforePromptInput extends SessionContext {
  prompt: string;
  messages?: ChatMessage[];
}

export interface BeforePromptResult extends MemoryInjection {
  messages: ChatMessage[];
}

export interface AfterResponseInput extends SessionContext {
  prompt: string;
  response: string;
  messages?: ChatMessage[];
  metadata?: Record<string, string | number | boolean>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_SCOPE = "workspace" satisfies MemoryScope;

const asContentString = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "text" in entry) {
          return String((entry as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(entry);
      })
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
};

const dedupeArtifacts = (responses: RecallMemoryResponse[]): MemoryArtifact[] => {
  const seen = new Set<string>();
  const artifacts: MemoryArtifact[] = [];
  for (const response of responses) {
    for (const artifact of response.context) {
      if (seen.has(artifact.id)) {
        continue;
      }
      seen.add(artifact.id);
      artifacts.push(artifact);
    }
  }
  return artifacts;
};

export const renderMemoryBlock = (artifacts: MemoryArtifact[]): string => {
  if (artifacts.length === 0) {
    return "";
  }

  return [
    "Relevant prior memory from Orca. Treat this as authoritative context unless the current prompt contradicts it.",
    ...artifacts.map((artifact, index) => {
      const body = artifact.summary || artifact.content;
      const tags = artifact.tags.length > 0 ? ` tags=${artifact.tags.join(",")}` : "";
      return `${index + 1}. [${artifact.scope}/${artifact.type}] ${body}${tags} source=${artifact.provenance.source}`;
    }),
  ].join("\n");
};

export class OrcaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OrcaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.ORCA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
    this.apiKey = options.apiKey ?? process.env.ORCA_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  async recall(request: RecallMemoryRequest): Promise<RecallMemoryResponse> {
    return this.request("POST", "/v1/memories/recall", request) as Promise<RecallMemoryResponse>;
  }

  async ingest(request: IngestMemoryRequest): Promise<IngestMemoryResponse> {
    return this.request("POST", "/v1/memories/ingest", request) as Promise<IngestMemoryResponse>;
  }

  async compact(request: CompactConversationRequest): Promise<CompactConversationResponse> {
    return this.request("POST", "/v1/memories/compact", request) as Promise<CompactConversationResponse>;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiKey?.trim()) {
      headers["x-api-key"] = this.apiKey.trim();
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `Orca request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }
}

export class EnforcedMemoryHarness {
  private readonly client: OrcaClient;
  private readonly required: boolean;
  private readonly failureMode: OrcaFailureMode;
  private readonly defaultScope: MemoryScope;
  private readonly bootstrapScopes: MemoryScope[];
  private readonly source: string;
  private readonly includeDiagnostics: boolean;
  private readonly recallLimit: number;
  private readonly compactionThresholdRatio: number;

  constructor(options: MemoryHarnessOptions = {}) {
    this.client = new OrcaClient(options);
    this.required = options.required ?? true;
    this.failureMode = options.failureMode ?? "block";
    this.defaultScope = options.defaultScope ?? DEFAULT_SCOPE;
    this.bootstrapScopes = options.bootstrapScopes ?? ["user-profile", "workspace"];
    this.source = options.source ?? "orca-enforced-harness";
    this.includeDiagnostics = options.includeDiagnostics ?? true;
    this.recallLimit = options.recallLimit ?? 5;
    this.compactionThresholdRatio = options.compactionThresholdRatio ?? 0.7;
  }

  async startSession(context: SessionContext): Promise<MemoryInjection> {
    await this.guard(() => this.client.health(), "Orca health check failed");
    const scopes = this.resolveScopes(context, true);
    const responses = await this.recallAcrossScopes(
      `Session bootstrap for ${context.sessionId}. Recall durable user, workspace, project, and session context.`,
      scopes,
    );
    return this.toInjection(context.sessionId, context.scope ?? this.defaultScope, responses);
  }

  async beforePrompt(input: BeforePromptInput): Promise<BeforePromptResult> {
    const scopes = this.resolveScopes(input, false);
    const responses = await this.recallAcrossScopes(input.prompt, scopes);
    const injection = this.toInjection(input.sessionId, input.scope ?? this.defaultScope, responses);
    const memoryMessage = injection.memoryBlock
      ? [{ role: "system", content: injection.memoryBlock } satisfies ChatMessage]
      : [];

    return {
      ...injection,
      messages: [
        ...memoryMessage,
        ...(input.messages ?? []),
      ],
    };
  }

  async afterResponse(input: AfterResponseInput): Promise<IngestMemoryResponse | undefined> {
    const scope = input.scope ?? this.defaultScope;
    const content = [
      `User prompt: ${input.prompt}`,
      `Assistant response: ${input.response}`,
    ].join("\n\n");

    return this.guard(
      () =>
        this.client.ingest({
          scope,
          source: input.source ?? this.source,
          sourceId: `${input.sessionId}:${Date.now()}`,
          sessionId: input.sessionId,
          typeHint: "episodic",
          tags: ["agent-turn", "enforced-memory", ...(input.metadata ? Object.keys(input.metadata) : [])],
          content,
        }),
      "Orca post-response ingest failed",
    );
  }

  async compactIfNeeded(context: SessionContext & { messages: ChatMessage[]; force?: boolean }): Promise<CompactConversationResponse | undefined> {
    return this.guard(
      () =>
        this.client.compact({
          scope: context.scope ?? this.defaultScope,
          sessionId: context.sessionId,
          thresholdRatio: this.compactionThresholdRatio,
          ...(context.force === undefined ? {} : { force: context.force }),
          messages: context.messages
            .filter((message) => ["system", "user", "assistant", "tool"].includes(message.role))
            .map((message) => ({
              role: message.role as "system" | "user" | "assistant" | "tool",
              content: asContentString(message.content),
            })),
        }),
      "Orca compaction failed",
    );
  }

  private resolveScopes(context: SessionContext, includeBootstrap: boolean): MemoryScope[] {
    return Array.from(
      new Set([
        ...(includeBootstrap ? this.bootstrapScopes : []),
        context.userScope,
        context.projectScope,
        context.skillScope,
        context.scope ?? this.defaultScope,
        `session:${context.sessionId}` as MemoryScope,
      ].filter((scope): scope is MemoryScope => Boolean(scope))),
    );
  }

  private async recallAcrossScopes(query: string, scopes: MemoryScope[]): Promise<RecallMemoryResponse[]> {
    const responses: RecallMemoryResponse[] = [];
    for (const scope of scopes) {
      const response = await this.guard(
        () =>
          this.client.recall({
            query,
            scope,
            limit: this.recallLimit,
            includeDiagnostics: this.includeDiagnostics,
          }),
        `Orca recall failed for scope ${scope}`,
      );
      if (response) {
        responses.push(response);
      }
    }
    return responses;
  }

  private toInjection(sessionId: string, scope: MemoryScope, responses: RecallMemoryResponse[]): MemoryInjection {
    const memories = dedupeArtifacts(responses);
    return {
      sessionId,
      scope,
      memories,
      recallResponses: responses,
      memoryBlock: renderMemoryBlock(memories),
      diagnostics: responses
        .map((response) => response.diagnostics)
        .filter((diagnostics): diagnostics is NonNullable<RecallMemoryResponse["diagnostics"]> => Boolean(diagnostics)),
    };
  }

  private async guard<T>(operation: () => Promise<T>, message: string): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (this.required && this.failureMode === "block") {
        throw new Error(`${message}: ${(error as Error).message}`);
      }
      return undefined;
    }
  }
}
