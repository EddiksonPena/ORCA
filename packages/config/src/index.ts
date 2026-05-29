import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

export interface AppConfig {
  baseDir: string;
  memoryApiPort: number;
  workerPort: number;
  redisUrl: string;
  memoryStateBackend: "file" | "redis";
  memoryStateRedisKey: string;
  orcaAuthMode: "none" | "api-key" | "jwt" | "hybrid";
  orcaJwtIssuer: string | undefined;
  orcaJwtAudience: string | undefined;
  orcaJwksUrl: string | undefined;
  orcaJwtRequiredScopes: string[];
  weaviateHttpUrl: string;
  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalWorkflowTaskQueue: string;
  temporalExecutionMode: "auto" | "local" | "temporal";
  autoTriggerWorkflows: boolean;
  otelExporterEndpoint: string | undefined;
  embeddingProvider: "hash" | "transformers" | "ollama";
  embeddingModel: string;
  embeddingDtype: "fp32" | "fp16" | "q8" | "int8" | "uint8";
  embeddingDimensions: number;
  embeddingQueryInstruction: string;
  embeddingCacheDir: string;
  ollamaHost: string;
  ollamaApiKey: string | undefined;
  rerankerModel: string;
  extractionModel: string;
  temporalGraphBackend: "neo4j-temporal" | "graphiti-python" | "graphiti-scaffold";
  graphitiPythonBin: string;
  graphitiBridgeScript: string;
  graphitiGroupId: string;
  memoryDataDir: string;
  memoryDataFile: string;
  maxRequestBytes: number;
  shutdownTimeoutMs: number;
  orcaApiKey: string | undefined;
}

const resolvePath = (baseDir: string, candidate: string): string =>
  isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);

const parseCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const findWorkspaceRoot = (startDir: string): string => {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): AppConfig => {
  const baseDir = findWorkspaceRoot(env.PWD ?? env.INIT_CWD ?? process.cwd());
  const memoryDataDir = resolvePath(baseDir, env.MEMORY_DATA_DIR ?? "./data");
  const memoryDataFile = resolvePath(
    baseDir,
    env.MEMORY_DATA_FILE ?? `${memoryDataDir}/orca-memory-os.json`,
  );
  const apiKey = env.ORCA_API_KEY?.trim() || undefined;
  const jwtIssuer = env.ORCA_JWT_ISSUER?.trim() || undefined;
  const jwtAudience = env.ORCA_JWT_AUDIENCE?.trim() || undefined;
  const jwksUrl = env.ORCA_JWKS_URL?.trim() || undefined;
  const authMode =
    env.ORCA_AUTH_MODE === "none"
      ? "none"
      : env.ORCA_AUTH_MODE === "jwt"
        ? "jwt"
        : env.ORCA_AUTH_MODE === "hybrid"
          ? "hybrid"
          : env.ORCA_AUTH_MODE === "api-key"
            ? "api-key"
            : jwtIssuer || jwksUrl
              ? apiKey
                ? "hybrid"
                : "jwt"
              : apiKey
                ? "api-key"
                : "none";

  return {
    baseDir,
    memoryApiPort: parseNumber(env.MEMORY_API_PORT, 4000),
    workerPort: parseNumber(env.WORKER_PORT, 4010),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6380",
    memoryStateBackend: env.MEMORY_STATE_BACKEND === "redis" ? "redis" : "file",
    memoryStateRedisKey: env.MEMORY_STATE_REDIS_KEY ?? "orca:state:v1",
    orcaAuthMode: authMode,
    orcaJwtIssuer: jwtIssuer,
    orcaJwtAudience: jwtAudience,
    orcaJwksUrl: jwksUrl,
    orcaJwtRequiredScopes: parseCsv(env.ORCA_JWT_REQUIRED_SCOPES),
    weaviateHttpUrl: env.WEAVIATE_HTTP_URL ?? "http://localhost:8080",
    neo4jUri: env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4jUsername: env.NEO4J_USERNAME ?? "neo4j",
    neo4jPassword: env.NEO4J_PASSWORD ?? "orca",
    temporalAddress: env.TEMPORAL_ADDRESS ?? "localhost:7233",
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? "default",
    temporalWorkflowTaskQueue: env.TEMPORAL_WORKFLOW_TASK_QUEUE ?? "orca-memory-module",
    temporalExecutionMode:
      env.TEMPORAL_EXECUTION_MODE === "local"
        ? "local"
        : env.TEMPORAL_EXECUTION_MODE === "temporal"
          ? "temporal"
          : "auto",
    autoTriggerWorkflows: parseBoolean(env.AUTO_TRIGGER_WORKFLOWS, true),
    otelExporterEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    embeddingProvider:
      env.EMBEDDING_PROVIDER === "hash"
        ? "hash"
        : env.EMBEDDING_PROVIDER === "ollama"
          ? "ollama"
          : "transformers",
    embeddingModel: env.EMBEDDING_MODEL ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    embeddingDtype:
      env.EMBEDDING_DTYPE === "fp32"
        ? "fp32"
        : env.EMBEDDING_DTYPE === "fp16"
          ? "fp16"
          : env.EMBEDDING_DTYPE === "int8"
            ? "int8"
            : env.EMBEDDING_DTYPE === "uint8"
              ? "uint8"
              : "q8",
    embeddingDimensions: parseNumber(env.EMBEDDING_DIMENSIONS, 1024),
    embeddingQueryInstruction:
      env.EMBEDDING_QUERY_INSTRUCTION ??
      "Given an agent memory recall query, retrieve relevant memories that answer or contextualize the query",
    embeddingCacheDir: resolvePath(baseDir, env.EMBEDDING_CACHE_DIR ?? "./data/models/transformers"),
    ollamaHost: (env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/u, ""),
    ollamaApiKey: env.OLLAMA_API_KEY?.trim() || undefined,
    rerankerModel: env.RERANKER_MODEL ?? "bge-reranker-base",
    extractionModel: env.EXTRACTION_MODEL ?? "qwen2.5:14b",
    temporalGraphBackend:
      env.TEMPORAL_GRAPH_BACKEND === "graphiti-python"
        ? "graphiti-python"
        : env.TEMPORAL_GRAPH_BACKEND === "graphiti-scaffold"
          ? "graphiti-scaffold"
          : "neo4j-temporal",
    graphitiPythonBin: env.GRAPHITI_PYTHON_BIN ?? "python3",
    graphitiBridgeScript: resolvePath(baseDir, env.GRAPHITI_BRIDGE_SCRIPT ?? "./scripts/graphiti_bridge.py"),
    graphitiGroupId: env.GRAPHITI_GROUP_ID ?? "orca-episodic",
    memoryDataDir,
    memoryDataFile,
    maxRequestBytes: parseNumber(env.MAX_REQUEST_BYTES, 1024 * 1024),
    shutdownTimeoutMs: parseNumber(env.SHUTDOWN_TIMEOUT_MS, 10000),
    orcaApiKey: apiKey,
  };
};
