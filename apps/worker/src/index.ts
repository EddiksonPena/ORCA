import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { NativeConnection, Worker } from "@temporalio/worker";
import { createRequestAuthorizer } from "@orca/auth";
import { loadConfig } from "@orca/config";
import { createMemoryOs, renderModuleMetricsPrometheus } from "@orca/core";
import type { WorkerHeartbeat } from "@orca/schemas";

const config = loadConfig();
const memoryOs = createMemoryOs(config);
const authorizer = createRequestAuthorizer(config);
const persistenceTarget =
  config.memoryStateBackend === "redis"
    ? `${config.redisUrl}#${config.memoryStateRedisKey}`
    : config.memoryDataFile;
const temporalRuntime = {
  status: "starting" as "starting" | "running" | "disabled" | "failed",
  taskQueue: config.temporalWorkflowTaskQueue,
  error: undefined as string | undefined,
};

void startTemporalWorker();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const memory = await memoryOs.getHealth();
      const heartbeat: WorkerHeartbeat & { memory: typeof memory } = {
        service: "worker",
        status: "ok",
        timestamp: new Date().toISOString(),
        memory,
      };

      return sendJson(res, 200, {
        ...heartbeat,
        temporalRuntime,
      });
    }

    const authorization = await authorizer.authorize(req);
    if (!authorization.authorized) {
      return sendJson(res, 401, {
        error: "unauthorized",
        message:
          config.orcaAuthMode === "jwt" || config.orcaAuthMode === "hybrid"
            ? "A valid API key or JWT bearer token is required."
            : "A valid API key is required.",
        ...(authorization.reason ? { reason: authorization.reason } : {}),
      });
    }

    if (req.method === "POST" && url.pathname === "/workflows/reindex") {
      const response = await memoryOs.reindex();
      return sendJson(res, 202, {
        ...response,
        temporalAddress: config.temporalAddress,
      });
    }

    if (req.method === "GET" && url.pathname === "/workflows/definitions") {
      const workflows = await memoryOs.getWorkflowDefinitions();
      return sendJson(res, 200, {
        temporalAddress: config.temporalAddress,
        workflows,
      });
    }

    if (req.method === "GET" && url.pathname === "/workflows/runs") {
      const runs = await memoryOs.getWorkflowRuns();
      return sendJson(res, 200, {
        temporalAddress: config.temporalAddress,
        runs,
      });
    }

    if (req.method === "GET" && url.pathname === "/metrics/modules") {
      const modules = await memoryOs.getModuleMetrics();
      return sendJson(res, 200, {
        temporalAddress: config.temporalAddress,
        modules,
      });
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      const health = await memoryOs.getHealth();
      const modules = await memoryOs.getModuleMetrics();
      const runs = await memoryOs.getWorkflowRuns();
      return sendText(
        res,
        200,
        renderModuleMetricsPrometheus(modules, health, runs, "worker"),
        { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      );
    }

    if (req.method === "POST" && url.pathname === "/workflows/execute") {
      const payload = (await readJson(req)) as { workflowId?: string };
      if (!payload.workflowId) {
        return sendJson(res, 400, {
          error: "missing_workflow_id",
        });
      }

      const result = await memoryOs.executeWorkflow(payload.workflowId);
      return sendJson(res, result.executed ? 202 : 404, {
        temporalAddress: config.temporalAddress,
        result,
      });
    }

    return sendJson(res, 404, {
      error: "not_found",
    });
  } catch (error) {
    const candidate = error as Error;
    return sendJson(res, 500, {
      error: "worker_failed",
      message: candidate.message,
    });
  }
});

server.listen(config.workerPort, () => {
  console.log(
    JSON.stringify({
      service: "worker",
      event: "listening",
      port: config.workerPort,
      temporalAddress: config.temporalAddress,
      persistenceTarget,
    }),
  );
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(JSON.stringify({ service: "worker", event: "shutdown_requested", signal }));
  const forceExit = setTimeout(() => {
    console.error(JSON.stringify({ service: "worker", event: "shutdown_forced", signal }));
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      console.error(
        JSON.stringify({
          service: "worker",
          event: "shutdown_failed",
          signal,
          message: (error as Error).message,
        }),
      );
      process.exit(1);
    }

    console.log(JSON.stringify({ service: "worker", event: "shutdown_complete", signal }));
    process.exit(0);
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function sendJson(
  res: import("node:http").ServerResponse<import("node:http").IncomingMessage>,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(
  res: import("node:http").ServerResponse<import("node:http").IncomingMessage>,
  statusCode: number,
  body: string,
  headers: Record<string, string>,
): void {
  res.writeHead(statusCode, headers);
  res.end(body);
}

async function startTemporalWorker(): Promise<void> {
  const workflowsPath = resolve(
    config.baseDir,
    "packages/core/dist/core/src/temporal/workflows.js",
  );

  if (!existsSync(workflowsPath)) {
    temporalRuntime.status = "disabled";
    temporalRuntime.error = "Temporal workflow bundle not found. Run pnpm build before worker startup.";
    return;
  }

  try {
    const connection = await NativeConnection.connect({
      address: config.temporalAddress,
    });

    const worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      workflowsPath,
      taskQueue: config.temporalWorkflowTaskQueue,
      activities: {
        executeModuleWorkflowActivity: async (workflowId: string, runId?: string) => {
          const result = await memoryOs.executeWorkflowDirect(workflowId);
          if (runId) {
            await memoryOs.completeWorkflowRun(runId, {
              ...result,
              mode: "temporal",
            });
          }
          return result;
        },
      },
    });

    temporalRuntime.status = "running";
    void worker.run().catch((error) => {
      temporalRuntime.status = "failed";
      temporalRuntime.error = (error as Error).message;
    });
  } catch (error) {
    temporalRuntime.status = "failed";
    temporalRuntime.error = (error as Error).message;
  }
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const rawBody = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const destroyableReq = req as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };

    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > config.maxRequestBytes) {
        reject(new Error(`Request body exceeds MAX_REQUEST_BYTES (${config.maxRequestBytes}).`));
        destroyableReq.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

  return rawBody ? (JSON.parse(rawBody) as unknown) : {};
}
