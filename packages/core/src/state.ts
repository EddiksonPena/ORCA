import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createClient } from "redis";
import type { AppConfig } from "@orca/config";

import { EMPTY_STATE, type PersistedState, type StateStore } from "./types.js";

const normalizeState = (state: Partial<PersistedState>): PersistedState => ({
  artifacts: Array.isArray(state.artifacts) ? state.artifacts : structuredClone(EMPTY_STATE.artifacts),
  chunks: Array.isArray(state.chunks) ? state.chunks : structuredClone(EMPTY_STATE.chunks),
  graphNodes: Array.isArray(state.graphNodes) ? state.graphNodes : structuredClone(EMPTY_STATE.graphNodes),
  graphEdges: Array.isArray(state.graphEdges) ? state.graphEdges : structuredClone(EMPTY_STATE.graphEdges),
  workflowRuns: Array.isArray(state.workflowRuns)
    ? state.workflowRuns
    : structuredClone(EMPTY_STATE.workflowRuns),
  moduleMetrics: {
    semantic: {
      ...EMPTY_STATE.moduleMetrics.semantic,
      ...(state.moduleMetrics?.semantic ?? {}),
      moduleId: "semantic",
    },
    episodic: {
      ...EMPTY_STATE.moduleMetrics.episodic,
      ...(state.moduleMetrics?.episodic ?? {}),
      moduleId: "episodic",
    },
    procedural: {
      ...EMPTY_STATE.moduleMetrics.procedural,
      ...(state.moduleMetrics?.procedural ?? {}),
      moduleId: "procedural",
    },
  },
});

const tryParseWithTrailingRecovery = (raw: string): PersistedState => {
  try {
    return normalizeState(JSON.parse(raw) as Partial<PersistedState>);
  } catch (error) {
    const candidate = error as Error;
    const match = /position (\d+)/.exec(candidate.message);
    if (!match) {
      throw error;
    }

    const cutoff = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(cutoff) || cutoff <= 0) {
      throw error;
    }

    return normalizeState(JSON.parse(raw.slice(0, cutoff)) as Partial<PersistedState>);
  }
};

const serializeState = (state: PersistedState): string => JSON.stringify(state, null, 2);

const cloneState = (state: PersistedState): PersistedState => structuredClone(state);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });

export class JsonStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  describe(): string {
    return this.filePath;
  }

  async read(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = tryParseWithTrailingRecovery(raw);
      const canonical = serializeState(parsed);
      if (raw !== canonical) {
        await this.write(parsed);
      }
      return parsed;
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException;
      if (candidate.code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  async write(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const serialized = serializeState(normalizeState(state));
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, serialized);
    await rename(tempPath, this.filePath);
  }

  async update<T>(mutate: (state: PersistedState) => Promise<T> | T): Promise<T> {
    const state = await this.read();
    const result = await mutate(state);
    await this.write(state);
    return result;
  }
}

export class RedisStateStore implements StateStore {
  constructor(
    private readonly redisUrl: string,
    private readonly key: string,
  ) {}

  describe(): string {
    return `${this.redisUrl}#${this.key}`;
  }

  async read(): Promise<PersistedState> {
    const client = createClient({ url: this.redisUrl });
    try {
      await client.connect();
      const raw = await client.get(this.key);
      return raw ? tryParseWithTrailingRecovery(raw) : structuredClone(EMPTY_STATE);
    } finally {
      if (client.isOpen) {
        await client.disconnect();
      }
    }
  }

  async write(state: PersistedState): Promise<void> {
    const client = createClient({ url: this.redisUrl });
    try {
      await client.connect();
      await client.set(this.key, serializeState(normalizeState(state)));
    } finally {
      if (client.isOpen) {
        await client.disconnect();
      }
    }
  }

  async update<T>(mutate: (state: PersistedState) => Promise<T> | T): Promise<T> {
    const client = createClient({ url: this.redisUrl });
    const attempts = 16;

    try {
      await client.connect();

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await client.watch(this.key);
          const raw = await client.get(this.key);
          const state = raw ? tryParseWithTrailingRecovery(raw) : structuredClone(EMPTY_STATE);
          const working = cloneState(state);
          const result = await mutate(working);
          const transaction = client.multi();
          transaction.set(this.key, serializeState(normalizeState(working)));
          const committed = await transaction.exec();
          if (committed) {
            return result;
          }
        } catch (error) {
          const message = (error as Error).message;
          if (message.includes("watched keys has been changed")) {
            await client.unwatch();
            await sleep(Math.min(5 * (attempt + 1), 40));
            continue;
          }

          throw error;
        }

        await client.unwatch();
        await sleep(Math.min(5 * (attempt + 1), 40));
      }

      throw new Error(`Redis state update failed after ${attempts} optimistic retries.`);
    } finally {
      if (client.isOpen) {
        await client.disconnect();
      }
    }
  }
}

export const createStateStore = (config: AppConfig): StateStore =>
  config.memoryStateBackend === "redis"
    ? new RedisStateStore(config.redisUrl, config.memoryStateRedisKey)
    : new JsonStateStore(config.memoryDataFile || `${config.memoryDataDir}/orca-memory-os.json`);
