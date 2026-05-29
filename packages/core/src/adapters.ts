import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import type { AppConfig } from "@orca/config";
import type { MemoryArtifact, MemoryScope } from "@orca/schemas";
import { createClient } from "redis";

import type {
  MemoryModuleId,
  PersistedState,
  StoredChunk,
  TemporalGraphAdapter,
  TemporalEpisodeUpsert,
} from "./types.js";
import {
  escapeGraphQl,
  neo4jHttpUrl,
  roundScore,
  tokenize,
  toUuid,
} from "./utils.js";
import type { EmbeddingService } from "./embeddings.js";

const WEAVIATE_CLASSES: Record<MemoryModuleId, string> = {
  semantic: "OrcaSemanticChunk",
  episodic: "OrcaEpisodicChunk",
  procedural: "OrcaProceduralChunk",
};

interface GraphitiBridgeRequest {
  command: "upsert_episode" | "search";
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  groupId: string;
  payload: Record<string, unknown>;
}

interface GraphitiBridgeResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

interface GraphitiSearchHit {
  fact: string;
  uuid?: string;
  name?: string;
}

export class RedisWorkingMemoryAdapter {
  constructor(private readonly url: string) {}

  async rememberRecent(
    scope: MemoryScope,
    moduleId: MemoryModuleId,
    ...artifactIds: string[]
  ): Promise<boolean> {
    if (artifactIds.length === 0) {
      return true;
    }

    return this.run(async (client) => {
      await client.lPush(this.key(scope, moduleId), artifactIds);
      await client.lTrim(this.key(scope, moduleId), 0, 49);
      return true;
    }, false);
  }

  async getRecent(scope: MemoryScope | undefined, moduleId: MemoryModuleId): Promise<string[]> {
    if (!scope) {
      return [];
    }

    return this.run(async (client) => {
      return client.lRange(this.key(scope, moduleId), 0, 24);
    }, []);
  }

  private key(scope: MemoryScope, moduleId: MemoryModuleId): string {
    return `memory:recent:${scope}:${moduleId}`;
  }

  private async run<T>(
    callback: (client: ReturnType<typeof createClient>) => Promise<T>,
    fallback?: T,
  ): Promise<T> {
    let client: ReturnType<typeof createClient> | undefined;
    try {
      client = createClient({ url: this.url });
      await client.connect();
      return await callback(client);
    } catch {
      return fallback as T;
    } finally {
      if (client?.isOpen) {
        try {
          await client.disconnect();
        } catch {
          // Ignore cleanup errors so successful reads/writes are not masked.
        }
      }
    }
  }
}

export class WeaviateSemanticAdapter {
  private readonly schemaReady = new Set<string>();

  constructor(
    private readonly baseUrl: string,
    private readonly embeddings: EmbeddingService,
  ) {}

  async upsertChunks(chunks: StoredChunk[], moduleId: MemoryModuleId): Promise<boolean> {
    if (chunks.length === 0) {
      return true;
    }

    const className = WEAVIATE_CLASSES[moduleId];

    try {
      await this.ensureSchema(className);
      const objects = await Promise.all(
        chunks.map(async (chunk) => ({
          class: className,
          id: toUuid(chunk.artifact.id),
          vector: await this.embeddings.embed(chunk.artifact.content, "document"),
          properties: {
            artifactId: chunk.artifact.id,
            parentId: chunk.parentId,
            scope: chunk.artifact.scope,
            type: chunk.artifact.type,
            moduleId,
            content: chunk.artifact.content,
            summary: chunk.artifact.summary ?? "",
            tags: chunk.artifact.tags,
            entities: chunk.entities,
            salience: chunk.artifact.salience ?? 0,
            createdAt: chunk.artifact.createdAt,
          },
        })),
      );
      const response = await fetch(`${this.baseUrl}/v1/batch/objects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objects,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(
    query: string,
    limit: number,
    scope: MemoryScope | undefined,
    moduleId: MemoryModuleId,
  ): Promise<Map<string, number>> {
    const className = WEAVIATE_CLASSES[moduleId];

    try {
      await this.ensureSchema(className);
      const vector = await this.embeddings.embed(query, "query");
      const whereClause = scope
        ? `where:{path:[\"scope\"],operator:Equal,valueText:\"${escapeGraphQl(scope)}\"},`
        : "";
      const graphQl = {
        query: `{
          Get {
            ${className}(
              ${whereClause}
              limit:${limit}
              nearVector:{vector:[${vector.join(",")}]}
            ) {
              artifactId
              _additional { distance }
            }
          }
        }`,
      };
      const response = await fetch(`${this.baseUrl}/v1/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(graphQl),
      });
      const payload = (await response.json()) as {
        data?: {
          Get?: Record<
            string,
            Array<{
              artifactId?: string;
              _additional?: { distance?: number };
            }>
          >;
        };
      };

      const hits = new Map<string, number>();
      for (const result of payload.data?.Get?.[className] ?? []) {
        if (!result.artifactId) {
          continue;
        }
        const score = 1 - Math.min(result._additional?.distance ?? 1, 1);
        hits.set(result.artifactId, roundScore(score));
      }
      return hits;
    } catch {
      return new Map();
    }
  }

  private async ensureSchema(className: string): Promise<void> {
    if (this.schemaReady.has(className)) {
      return;
    }

    const response = await fetch(`${this.baseUrl}/v1/schema/${className}`);
    if (response.ok) {
      this.schemaReady.add(className);
      return;
    }

    const created = await fetch(`${this.baseUrl}/v1/schema`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        class: className,
        vectorizer: "none",
        properties: [
          { name: "artifactId", dataType: ["text"] },
          { name: "parentId", dataType: ["text"] },
          { name: "scope", dataType: ["text"] },
          { name: "type", dataType: ["text"] },
          { name: "moduleId", dataType: ["text"] },
          { name: "content", dataType: ["text"] },
          { name: "summary", dataType: ["text"] },
          { name: "tags", dataType: ["text[]"] },
          { name: "entities", dataType: ["text[]"] },
          { name: "salience", dataType: ["number"] },
          { name: "createdAt", dataType: ["date"] },
        ],
      }),
    });

    if (!created.ok) {
      throw new Error(`Failed to create Weaviate schema class ${className}: HTTP ${created.status}.`);
    }
    this.schemaReady.add(className);
  }
}

export class Neo4jGraphAdapter {
  private readonly httpUrl: string;
  private readonly authHeader: string;

  constructor(config: AppConfig) {
    this.httpUrl = neo4jHttpUrl(config.neo4jUri);
    this.authHeader = `Basic ${Buffer.from(
      `${config.neo4jUsername}:${config.neo4jPassword}`,
    ).toString("base64")}`;
  }

  async upsertMemory(
    rootArtifact: MemoryArtifact,
    chunks: StoredChunk[],
    moduleId: MemoryModuleId,
  ): Promise<boolean> {
    if (chunks.length === 0) {
      return true;
    }

    const rows = chunks.map((chunk) => ({
      artifactId: chunk.artifact.id,
      parentId: rootArtifact.id,
      entities: chunk.entities,
      scope: chunk.artifact.scope,
      moduleId,
    }));

    const memoryWrite = await this.query(
      `
      UNWIND $rows AS row
      MERGE (m:Memory {artifactId: row.artifactId, moduleId: row.moduleId})
      SET m.scope = row.scope, m.parentId = row.parentId
      WITH row, m
      UNWIND row.entities AS entityName
      MERGE (e:Entity {name: entityName, moduleId: row.moduleId})
      MERGE (m)-[:MENTIONS]->(e)
      `,
      { rows },
    );
    let ok = memoryWrite.ok;

    for (const chunk of chunks) {
      const edgeWrite = await this.query(
        `
        WITH $entities AS entities, $moduleId AS moduleId
        UNWIND range(0, size(entities) - 2) AS idx
        WITH entities[idx] AS fromName, entities[idx + 1] AS toName, moduleId
        MERGE (from:Entity {name: fromName, moduleId: moduleId})
        MERGE (to:Entity {name: toName, moduleId: moduleId})
        MERGE (from)-[r:CO_OCCURS_WITH {moduleId: moduleId}]-(to)
        ON CREATE SET r.weight = 1
        ON MATCH SET r.weight = r.weight + 1
        `,
        { entities: chunk.entities, moduleId },
      );
      ok = ok && edgeWrite.ok;
    }

    return ok;
  }

  async searchRelatedEntities(
    queryEntities: string[],
    moduleId: MemoryModuleId,
  ): Promise<Map<string, number>> {
    if (queryEntities.length === 0) {
      return new Map();
    }

    const payload = await this.query(
      `
      MATCH (e:Entity)-[r:CO_OCCURS_WITH {moduleId: $moduleId}]-(other:Entity)
      WHERE e.moduleId = $moduleId
        AND other.moduleId = $moduleId
        AND toLower(e.name) IN $queryEntities
      RETURN other.name AS entity, sum(r.weight) AS weight
      ORDER BY weight DESC
      LIMIT 20
      `,
      {
        queryEntities: queryEntities.map((entity) => entity.toLowerCase()),
        moduleId,
      },
    );

    const hits = new Map<string, number>();
    for (const row of payload.rows) {
      const entity = String(row.entity ?? "");
      const weight = Number(row.weight ?? 0);
      if (!entity) {
        continue;
      }
      hits.set(entity.toLowerCase(), weight);
    }
    return hits;
  }

  async reindexFromState(state: PersistedState): Promise<boolean> {
    const clear = await this.query("MATCH (n) DETACH DELETE n", {});
    let ok = clear.ok;
    const groups = new Map<string, StoredChunk[]>();
    for (const chunk of state.chunks) {
      const current = groups.get(chunk.parentId) ?? [];
      current.push(chunk);
      groups.set(chunk.parentId, current);
    }

    for (const [parentId, chunks] of groups) {
      const root = state.artifacts.find((artifact) => artifact.id === parentId);
      if (!root) {
        continue;
      }

      const moduleId =
        root.type === "episodic"
          ? "episodic"
          : root.type === "procedural"
            ? "procedural"
            : "semantic";
      ok = (await this.upsertMemory(root, chunks, moduleId)) && ok;
    }

    return ok;
  }

  private async query(
    statement: string,
    parameters: Record<string, unknown>,
  ): Promise<{ ok: boolean; rows: Record<string, unknown>[] }> {
    try {
      const response = await fetch(this.httpUrl, {
        method: "POST",
        headers: {
          authorization: this.authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          statements: [{ statement, parameters }],
        }),
      });

      const payload = (await response.json()) as {
        errors?: Array<{ message?: string }>;
        results?: Array<{
          columns?: string[];
          data?: Array<{ row?: unknown[] }>;
        }>;
      };
      if (payload.errors?.length) {
        return { ok: false, rows: [] };
      }

      const result = payload.results?.[0];
      if (!result?.columns?.length || !result.data?.length) {
        return { ok: response.ok, rows: [] };
      }

      return {
        ok: response.ok,
        rows: result.data.map((entry) => {
        const row = entry.row ?? [];
        return result.columns!.reduce<Record<string, unknown>>((accumulator, column, index) => {
          accumulator[column] = row[index];
          return accumulator;
        }, {});
        }),
      };
    } catch {
      return { ok: false, rows: [] };
    }
  }
}

export class Neo4jTemporalGraphAdapter implements TemporalGraphAdapter {
  readonly backend = "neo4j-temporal" as const;
  private readonly httpUrl: string;
  private readonly authHeader: string;

  constructor(config: AppConfig) {
    this.httpUrl = neo4jHttpUrl(config.neo4jUri);
    this.authHeader = `Basic ${Buffer.from(
      `${config.neo4jUsername}:${config.neo4jPassword}`,
    ).toString("base64")}`;
  }

  async upsertEpisode(
    rootArtifact: MemoryArtifact,
    chunks: StoredChunk[],
  ): Promise<TemporalEpisodeUpsert> {
    if (chunks.length === 0) {
      return {
        backend: this.backend,
        episodesWritten: 0,
      };
    }

    const rows = chunks.map((chunk) => ({
      artifactId: chunk.artifact.id,
      parentId: rootArtifact.id,
      content: chunk.artifact.content,
      observedAt: String(rootArtifact.provenance.observedAt),
      createdAt: rootArtifact.createdAt,
      entities: chunk.entities,
      scope: chunk.artifact.scope,
    }));

    await this.query(
      `
      UNWIND $rows AS row
      MERGE (episode:Episode {artifactId: row.artifactId, moduleId: 'episodic'})
      SET episode.parentId = row.parentId,
          episode.scope = row.scope,
          episode.content = row.content,
          episode.observedAt = row.observedAt,
          episode.createdAt = row.createdAt
      WITH row, episode
      UNWIND row.entities AS entityName
      MERGE (entity:TemporalEntity {name: entityName, moduleId: 'episodic'})
      MERGE (episode)-[:OBSERVED_ENTITY]->(entity)
      `,
      { rows },
    );

    await this.query(
      `
      UNWIND $rows AS row
      WITH row
      ORDER BY row.observedAt ASC, row.artifactId ASC
      WITH collect(row) AS ordered
      UNWIND range(0, size(ordered) - 2) AS idx
      WITH ordered[idx] AS current, ordered[idx + 1] AS next
      MATCH (a:Episode {artifactId: current.artifactId, moduleId: 'episodic'})
      MATCH (b:Episode {artifactId: next.artifactId, moduleId: 'episodic'})
      MERGE (a)-[:NEXT_EPISODE]->(b)
      `,
      { rows },
    );

    return {
      backend: this.backend,
      episodesWritten: rows.length,
    };
  }

  async searchTimeline(
    queryEntities: string[],
    _candidateChunks: StoredChunk[],
  ): Promise<Map<string, number>> {
    if (queryEntities.length === 0) {
      return new Map();
    }

    const rows = await this.query(
      `
      MATCH (entity:TemporalEntity {moduleId: 'episodic'})<-[:OBSERVED_ENTITY]-(episode:Episode {moduleId: 'episodic'})
      WHERE toLower(entity.name) IN $queryEntities
      RETURN episode.artifactId AS artifactId, count(entity) AS matches
      ORDER BY matches DESC, episode.observedAt DESC
      LIMIT 25
      `,
      {
        queryEntities: queryEntities.map((entity) => entity.toLowerCase()),
      },
    );

    const hits = new Map<string, number>();
    for (const row of rows) {
      const artifactId = String(row.artifactId ?? "");
      const matches = Number(row.matches ?? 0);
      if (!artifactId) {
        continue;
      }
      hits.set(artifactId, roundScore(Math.min(matches / 5, 1)));
    }
    return hits;
  }

  async reindexEpisodes(state: PersistedState): Promise<void> {
    await this.query(
      "MATCH (n {moduleId: 'episodic'}) WHERE n:Episode OR n:TemporalEntity DETACH DELETE n",
      {},
    );

    const groups = new Map<string, StoredChunk[]>();
    for (const chunk of state.chunks.filter((candidate) => candidate.artifact.type === "episodic")) {
      const current = groups.get(chunk.parentId) ?? [];
      current.push(chunk);
      groups.set(chunk.parentId, current);
    }

    for (const [parentId, chunks] of groups) {
      const root = state.artifacts.find((artifact) => artifact.id === parentId);
      if (!root) {
        continue;
      }
      await this.upsertEpisode(root, chunks);
    }
  }

  private async query(
    statement: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    try {
      const response = await fetch(this.httpUrl, {
        method: "POST",
        headers: {
          authorization: this.authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          statements: [{ statement, parameters }],
        }),
      });

      const payload = (await response.json()) as {
        errors?: Array<{ message?: string }>;
        results?: Array<{
          columns?: string[];
          data?: Array<{ row?: unknown[] }>;
        }>;
      };
      if (payload.errors?.length) {
        return [];
      }

      const result = payload.results?.[0];
      if (!result?.columns?.length || !result.data?.length) {
        return [];
      }

      return result.data.map((entry) => {
        const row = entry.row ?? [];
        return result.columns!.reduce<Record<string, unknown>>((accumulator, column, index) => {
          accumulator[column] = row[index];
          return accumulator;
        }, {});
      });
    } catch {
      return [];
    }
  }
}

export class GraphitiTemporalGraphAdapter implements TemporalGraphAdapter {
  readonly backend = "graphiti-scaffold" as const;
  private readonly delegate: Neo4jTemporalGraphAdapter;

  constructor(config: AppConfig) {
    this.delegate = new Neo4jTemporalGraphAdapter(config);
  }

  async upsertEpisode(
    rootArtifact: MemoryArtifact,
    chunks: StoredChunk[],
  ): Promise<TemporalEpisodeUpsert> {
    const result = await this.delegate.upsertEpisode(rootArtifact, chunks);
    return {
      backend: this.backend,
      episodesWritten: result.episodesWritten,
    };
  }

  async searchTimeline(queryEntities: string[], candidateChunks: StoredChunk[]): Promise<Map<string, number>> {
    return this.delegate.searchTimeline(queryEntities, candidateChunks);
  }

  async reindexEpisodes(state: PersistedState): Promise<void> {
    await this.delegate.reindexEpisodes(state);
  }
}

export class GraphitiPythonTemporalGraphAdapter implements TemporalGraphAdapter {
  readonly backend = "graphiti-python" as const;
  private readonly delegate: Neo4jTemporalGraphAdapter;

  constructor(private readonly config: AppConfig) {
    this.delegate = new Neo4jTemporalGraphAdapter(config);
  }

  async upsertEpisode(
    rootArtifact: MemoryArtifact,
    chunks: StoredChunk[],
  ): Promise<TemporalEpisodeUpsert> {
    if (chunks.length === 0) {
      return {
        backend: this.backend,
        episodesWritten: 0,
      };
    }

    try {
      await this.runBridge<{ episodesWritten?: number }>({
        command: "upsert_episode",
        payload: {
          referenceTime: String(rootArtifact.provenance.observedAt),
          sourceDescription: rootArtifact.provenance.source,
          scope: rootArtifact.scope,
          rootArtifactId: rootArtifact.id,
          chunks: chunks.map((chunk) => ({
            artifactId: chunk.artifact.id,
            content: chunk.artifact.content,
            observedAt: String(rootArtifact.provenance.observedAt),
            createdAt: chunk.artifact.createdAt,
            sourceDescription: rootArtifact.provenance.source,
          })),
        },
        rootScope: rootArtifact.scope,
      });

      return {
        backend: this.backend,
        episodesWritten: chunks.length,
      };
    } catch {
      return this.delegate.upsertEpisode(rootArtifact, chunks);
    }
  }

  async searchTimeline(
    queryEntities: string[],
    candidateChunks: StoredChunk[],
  ): Promise<Map<string, number>> {
    if (queryEntities.length === 0 || candidateChunks.length === 0) {
      return new Map();
    }

    try {
      const query = queryEntities.join(" ");
      const results = await this.runBridge<GraphitiSearchHit[]>({
        command: "search",
        payload: {
          query,
          limit: 8,
        },
      });

      if (results.length === 0) {
        return new Map();
      }

      const hits = new Map<string, number>();
      for (const result of results) {
        const resultTokens = new Set(tokenize([result.fact, result.name ?? ""].join(" ")));
        if (resultTokens.size === 0) {
          continue;
        }

        for (const chunk of candidateChunks) {
          const overlap = chunk.lexicalTokens.filter((token) => resultTokens.has(token)).length;
          if (overlap === 0) {
            continue;
          }

          const normalized = roundScore(
            Math.min(
              overlap / Math.max(Math.min(chunk.lexicalTokens.length, resultTokens.size), 1),
              1,
            ),
          );
          const existing = hits.get(chunk.artifact.id) ?? 0;
          hits.set(chunk.artifact.id, Math.max(existing, normalized));
        }
      }

      return hits;
    } catch {
      return this.delegate.searchTimeline(queryEntities, candidateChunks);
    }
  }

  async reindexEpisodes(state: PersistedState): Promise<void> {
    const groups = new Map<string, StoredChunk[]>();
    for (const chunk of state.chunks.filter((candidate) => candidate.artifact.type === "episodic")) {
      const current = groups.get(chunk.parentId) ?? [];
      current.push(chunk);
      groups.set(chunk.parentId, current);
    }

    for (const [parentId, chunks] of groups) {
      const root = state.artifacts.find((artifact) => artifact.id === parentId);
      if (!root) {
        continue;
      }
      await this.upsertEpisode(root, chunks);
    }
  }

  private async runBridge<T>({
    command,
    payload,
    rootScope,
  }: {
    command: GraphitiBridgeRequest["command"];
    payload: Record<string, unknown>;
    rootScope?: MemoryScope;
  }): Promise<T> {
    if (!existsSync(this.config.graphitiBridgeScript)) {
      throw new Error(`Graphiti bridge script not found at ${this.config.graphitiBridgeScript}.`);
    }

    const groupId = rootScope
      ? `${this.config.graphitiGroupId}_${rootScope.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      : this.config.graphitiGroupId;
    const request: GraphitiBridgeRequest = {
      command,
      neo4jUri: this.config.neo4jUri,
      neo4jUser: this.config.neo4jUsername,
      neo4jPassword: this.config.neo4jPassword,
      groupId,
      payload,
    };

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.graphitiPythonBin, [this.config.graphitiBridgeScript], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "";
      let errors = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        errors += chunk.toString();
      });
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(errors.trim() || `Graphiti bridge exited with code ${code ?? "unknown"}.`));
          return;
        }
        resolve(buffer);
      });

      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    });

    let parsed: GraphitiBridgeResponse<T>;
    try {
      parsed = JSON.parse(stdout) as GraphitiBridgeResponse<T>;
    } catch (error) {
      throw new Error(`Graphiti bridge returned invalid JSON: ${(error as Error).message}`);
    }

    if (!parsed.ok) {
      throw new Error(parsed.error ?? "Graphiti bridge returned an unknown error.");
    }

    return parsed.result as T;
  }
}
