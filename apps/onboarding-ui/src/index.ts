import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildHarnessBundle,
  ensureEnvFile,
  getWorkspaceRoot,
  runBootstrap,
  runDoctor,
  stopStack,
} from "@orca/onboarding";

const port = Number(process.env.ONBOARDING_UI_PORT ?? 4020);
const publicDir = resolve(getWorkspaceRoot(), "apps/onboarding-ui/public");

const sendJson = (res: import("node:http").ServerResponse, statusCode: number, body: unknown): void => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
};

const memoryHeaders = async (): Promise<Record<string, string>> => {
  const env = await ensureEnvFile(false);
  const apiKey = env.values.get("ORCA_API_KEY") ?? "";
  return apiKey.trim() ? { "x-api-key": apiKey.trim() } : {};
};

const memoryBaseUrl = async (): Promise<string> => {
  const env = await ensureEnvFile(false);
  const explicit = env.values.get("ORCA_BASE_URL");
  if (explicit?.trim()) {
    return explicit.trim().replace(/\/$/u, "");
  }
  const port = env.values.get("MEMORY_API_PORT")?.trim() || "4000";
  return `http://127.0.0.1:${port}`;
};

const fetchMemoryJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const baseUrl = await memoryBaseUrl();
  const headers = {
    ...(await memoryHeaders()),
    ...(init.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
};

const loadMemoryOverview = async (): Promise<Record<string, unknown>> => {
  const [health, memories, metrics, workflows] = await Promise.allSettled([
    fetchMemoryJson("/health"),
    fetchMemoryJson("/v1/memories"),
    fetchMemoryJson("/v1/metrics/modules"),
    fetchMemoryJson("/v1/workflows/runs"),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    health: health.status === "fulfilled" ? health.value : null,
    memories: memories.status === "fulfilled" ? memories.value : { memories: [] },
    metrics: metrics.status === "fulfilled" ? metrics.value : { modules: [] },
    workflows: workflows.status === "fulfilled" ? workflows.value : { runs: [] },
    errors: [health, memories, metrics, workflows]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)),
  };
};

const seedMemoryDemo = async (): Promise<Record<string, unknown>> => {
  const samples = [
    {
      scope: "workspace",
      source: "visual-console-demo",
      typeHint: "semantic",
      tags: ["qwen", "semantic", "retrieval"],
      content:
        "Orca uses a quantized Qwen embedding model through Transformers.js to create semantic vectors for memory recall.",
    },
    {
      scope: "workspace",
      source: "visual-console-demo",
      typeHint: "episodic",
      tags: ["docker", "installation", "warmup"],
      content:
        "The Docker app profile warms the Qwen q8 embedding model during image builds so the product container starts with the model cached.",
    },
    {
      scope: "workspace",
      source: "visual-console-demo",
      typeHint: "procedural",
      tags: ["workflow", "maintenance", "reindex"],
      content:
        "When memory changes, Orca can run workflows that reindex semantic chunks, rebuild graph state, and compact conversation context.",
    },
  ];

  const results = [];
  for (const sample of samples) {
    results.push(
      await fetchMemoryJson("/v1/memories/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sample),
      }),
    );
  }

  return {
    seeded: results.length,
    results,
    overview: await loadMemoryOverview(),
  };
};

const sendFile = async (
  res: import("node:http").ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> => {
  const body = await readFile(filePath);
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
};

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { service: "onboarding-ui", status: "ok" });
    }

    if (method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, await runDoctor());
    }

    if (method === "GET" && url.pathname === "/api/connect") {
      return sendJson(res, 200, await buildHarnessBundle());
    }

    if (method === "GET" && url.pathname === "/api/memory/overview") {
      return sendJson(res, 200, await loadMemoryOverview());
    }

    if (method === "POST" && url.pathname === "/api/memory/seed-demo") {
      return sendJson(res, 200, await seedMemoryDemo());
    }

    if (method === "POST" && url.pathname === "/api/actions/init") {
      return sendJson(res, 200, await runBootstrap());
    }

    if (method === "POST" && url.pathname === "/api/actions/down") {
      return sendJson(res, 200, await stopStack());
    }

    if (method === "GET" && url.pathname === "/") {
      return sendFile(res, resolve(publicDir, "index.html"), "text/html; charset=utf-8");
    }

    if (method === "GET" && url.pathname === "/app.js") {
      return sendFile(res, resolve(publicDir, "app.js"), "text/javascript; charset=utf-8");
    }

    if (method === "GET" && url.pathname === "/styles.css") {
      return sendFile(res, resolve(publicDir, "styles.css"), "text/css; charset=utf-8");
    }

    if (method === "GET" && url.pathname.startsWith("/vendor/three.")) {
      const fileName = url.pathname.split("/").pop() ?? "";
      return sendFile(
        res,
        resolve(getWorkspaceRoot(), "apps/onboarding-ui/node_modules/three/build", fileName),
        "text/javascript; charset=utf-8",
      );
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: "onboarding_ui_failed",
      message: (error as Error).message,
    });
  }
});

server.listen(port, () => {
  console.log(JSON.stringify({ service: "onboarding-ui", event: "listening", port }));
});
