#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const workspaceRoot = resolve(new URL(".", import.meta.url).pathname, "..");
const args = process.argv.slice(2);

const option = (name, fallback) => {
  const direct = args.find((entry) => entry.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
};

const keepData = args.includes("--keep-data");
const skipBuild = args.includes("--skip-build");
const timeoutMs = Number(option("timeout-ms", "120000"));
const requestTimeoutMs = Number(option("request-timeout-ms", "10000"));

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const getFreePort = async () => {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  if (!address || typeof address !== "object") {
    throw new Error("Unable to allocate a free localhost port.");
  }
  return address.port;
};

const readJson = async (response) => {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
};

const request = async ({ method = "GET", url, apiKey, body }) => {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: await readJson(response),
  };
};

const streamRequest = async ({ method = "POST", url, body }) => {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
};

const run = (command, runArgs, env = {}) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, runArgs, {
      cwd: workspaceRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      resolvePromise({
        ok: false,
        exitCode: 1,
        command: [command, ...runArgs].join(" "),
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        ok: code === 0,
        exitCode: code ?? 1,
        command: [command, ...runArgs].join(" "),
        stdout,
        stderr,
      });
    });
  });

const spawnService = (name, command, serviceArgs, env) => {
  const logs = { stdout: "", stderr: "" };
  const child = spawn(command, serviceArgs, {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs.stderr += chunk.toString(); });
  return {
    name,
    child,
    logs,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolvePromise) => child.once("exit", resolvePromise)),
        sleep(2500).then(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }),
      ]);
    },
  };
};

const waitFor = async (name, url, apiKey) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const result = await request({ url, apiKey });
      if (result.ok) return result;
      lastError = `HTTP ${result.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`${name} did not become ready at ${url}: ${lastError}`);
};

const addCheck = (checks, id, ok, details, extra = undefined) => {
  checks.push({
    id,
    ok,
    details,
    ...(extra === undefined ? {} : { extra }),
  });
};

const createMockOpenAi = async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(payload);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const memoryInjected = messages.some((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("OrcaProxyRecall"),
      );
      if (payload.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        const content = memoryInjected
          ? "Mock upstream streamed OrcaProxyRecall memory context."
          : "Mock upstream streamed without Orca memory context.";
        for (const token of content.split(" ")) {
          res.write(`data: ${JSON.stringify({
            id: "sandbox-chatcmpl-stream",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: `${token} ` }, finish_reason: null }],
          })}\n\n`);
          await sleep(5);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "sandbox-chatcmpl",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: memoryInjected
              ? "Mock upstream observed OrcaProxyRecall memory context."
              : "Mock upstream did not observe Orca memory context.",
          },
          finish_reason: "stop",
        }],
      }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Unable to start mock OpenAI upstream.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
};

const main = async () => {
  const checks = [];
  const services = [];
  const apiKey = `sandbox-${randomBytes(16).toString("hex")}`;
  const dataDir = await mkdtemp(join(tmpdir(), "orca-sandbox-"));
  const [memoryPort, workerPort, proxyPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
  const mockOpenAi = await createMockOpenAi();

  const baseEnv = {
    MEMORY_API_PORT: String(memoryPort),
    WORKER_PORT: String(workerPort),
    ORCA_PROXY_PORT: String(proxyPort),
    ORCA_BASE_URL: `http://127.0.0.1:${memoryPort}`,
    ORCA_API_KEY: apiKey,
    ORCA_AUTH_MODE: "api-key",
    ORCA_REQUIRED: "true",
    ORCA_FAILURE_MODE: "block",
    ORCA_DEFAULT_SCOPE: "workspace",
    MEMORY_STATE_BACKEND: "file",
    MEMORY_DATA_DIR: dataDir,
    MEMORY_DATA_FILE: join(dataDir, "orca-memory-os.json"),
    EMBEDDING_PROVIDER: "hash",
    EMBEDDING_DIMENSIONS: "32",
    TEMPORAL_EXECUTION_MODE: "local",
    AUTO_TRIGGER_WORKFLOWS: "true",
    REDIS_URL: "redis://127.0.0.1:1",
    WEAVIATE_HTTP_URL: "http://127.0.0.1:1",
    NEO4J_URI: "bolt://127.0.0.1:1",
    ORCA_PROXY_UPSTREAM_BASE_URL: mockOpenAi.baseUrl,
    OPENAI_API_KEY: "sandbox-upstream-key",
  };

  try {
    if (!skipBuild) {
      const build = await run("pnpm", ["build"], baseEnv);
      addCheck(checks, "build", build.ok, build.ok ? "pnpm build completed." : build.stderr || build.stdout);
      if (!build.ok) {
        throw new Error("Build failed.");
      }
    }

    services.push(spawnService("memory-api", "pnpm", ["--filter", "@orca/memory-api", "start"], baseEnv));
    services.push(spawnService("worker", "pnpm", ["--filter", "@orca/worker", "start"], baseEnv));
    services.push(spawnService("proxy", "pnpm", ["--filter", "@orca/proxy", "start"], baseEnv));

    const baseUrl = `http://127.0.0.1:${memoryPort}`;
    const workerUrl = `http://127.0.0.1:${workerPort}`;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const [apiHealth, workerHealth, proxyHealth] = await Promise.all([
      waitFor("memory-api", `${baseUrl}/health`),
      waitFor("worker", `${workerUrl}/health`),
      waitFor("proxy", `${proxyUrl}/health`),
    ]);
    addCheck(checks, "memory-api-health", apiHealth.ok, `HTTP ${apiHealth.status}`, apiHealth.body);
    addCheck(checks, "worker-health", workerHealth.ok, `HTTP ${workerHealth.status}`, workerHealth.body);
    addCheck(checks, "proxy-health", proxyHealth.ok, `HTTP ${proxyHealth.status}`, proxyHealth.body);

    const unauthorized = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/ingest`,
      body: { scope: "workspace", source: "sandbox", content: "unauthorized write" },
    });
    addCheck(checks, "auth-required", unauthorized.status === 401, `POST without x-api-key -> HTTP ${unauthorized.status}`);

    const semantic = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/ingest`,
      apiKey,
      body: {
        scope: "workspace",
        source: "sandbox-smoke",
        typeHint: "semantic",
        tags: ["sandbox", "semantic"],
        content: "Orca SandboxAlpha uses enforced middleware, OpenAI-compatible proxy routing, and MCP bridge snippets for plug-and-play agent memory.",
      },
    });
    addCheck(checks, "semantic-ingest", semantic.ok && semantic.body.accepted === true, `HTTP ${semantic.status}`, semantic.body);

    const episodic = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/ingest`,
      apiKey,
      body: {
        scope: "workspace",
        source: "sandbox-smoke",
        typeHint: "episodic",
        tags: ["sandbox", "timeline"],
        content: "Incident event. Sandbox Team reviewed the HydraRollback timeline and confirmed worker reindex routes stayed available.",
      },
    });
    addCheck(checks, "episodic-ingest", episodic.ok && episodic.body.accepted === true, `HTTP ${episodic.status}`, episodic.body);

    const procedural = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/ingest`,
      apiKey,
      body: {
        scope: "workspace",
        source: "sandbox-smoke",
        typeHint: "procedural",
        tags: ["sandbox", "runbook"],
        content: "Workflow steps: first start Orca in sandbox mode, then recall SandboxAlpha, then route a proxy prompt, finally verify metrics and compaction.",
      },
    });
    addCheck(checks, "procedural-ingest", procedural.ok && procedural.body.accepted === true, `HTTP ${procedural.status}`, procedural.body);

    const recall = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/recall`,
      apiKey,
      body: {
        scope: "workspace",
        query: "How does SandboxAlpha use proxy routing and enforced middleware?",
        includeDiagnostics: true,
        limit: 5,
      },
    });
    const recallText = JSON.stringify(recall.body);
    addCheck(
      checks,
      "semantic-recall",
      recall.ok && recallText.includes("SandboxAlpha"),
      `HTTP ${recall.status}; returned ${recall.body.context?.length ?? 0} context items.`,
      recall.body,
    );

    const artifactId = recall.body.context?.[0]?.id;
    const feedback = artifactId
      ? await request({
          method: "POST",
          url: `${baseUrl}/v1/memories/feedback`,
          apiKey,
          body: { artifactId, useful: true },
        })
      : { ok: false, status: 0, body: { error: "missing recall artifact" } };
    addCheck(checks, "feedback", feedback.ok && feedback.body.updated === true, `HTTP ${feedback.status}`, feedback.body);

    const compaction = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/compact`,
      apiKey,
      body: {
        scope: "workspace",
        sessionId: "sandbox-session",
        occupancyRatio: 0.82,
        messages: [
          { role: "user", content: "SandboxProxy requires OrcaProxyRecall to be injected before every model call." },
          { role: "assistant", content: "First recall memory, then call the model, then ingest the response." },
          { role: "user", content: "Follow up on production proxy deployment hardening." },
        ],
      },
    });
    addCheck(
      checks,
      "compaction",
      compaction.ok && compaction.body.triggered === true && compaction.body.promoted?.episodic?.length >= 1,
      `HTTP ${compaction.status}`,
      compaction.body,
    );

    const proxySeed = await request({
      method: "POST",
      url: `${baseUrl}/v1/memories/ingest`,
      apiKey,
      body: {
        scope: "workspace",
        source: "sandbox-proxy-seed",
        typeHint: "semantic",
        tags: ["proxy", "enforced-memory"],
        content: "OrcaProxyRecall must appear in proxy-injected memory when testing the OpenAI-compatible proxy.",
      },
    });
    addCheck(checks, "proxy-seed-ingest", proxySeed.ok, `HTTP ${proxySeed.status}`, proxySeed.body);

    const proxyResponse = await request({
      method: "POST",
      url: `${proxyUrl}/v1/chat/completions`,
      body: {
        model: "mock-model",
        metadata: { scope: "workspace", sessionId: "sandbox-proxy-session" },
        messages: [
          { role: "user", content: "Please use OrcaProxyRecall context before answering." },
        ],
      },
    });
    const proxyObservedMemory =
      proxyResponse.ok &&
      JSON.stringify(proxyResponse.body).includes("observed OrcaProxyRecall") &&
      Number(proxyResponse.headers.get("x-orca-memory-count") ?? "0") > 0;
    addCheck(
      checks,
      "proxy-enforced-recall",
      proxyObservedMemory,
      `HTTP ${proxyResponse.status}; memory-count=${proxyResponse.headers.get("x-orca-memory-count") ?? "missing"}`,
      { response: proxyResponse.body, upstreamCalls: mockOpenAi.calls.length },
    );

    const streamingProxyResponse = await streamRequest({
      url: `${proxyUrl}/v1/chat/completions`,
      body: {
        model: "mock-model",
        stream: true,
        metadata: { scope: "workspace", sessionId: "sandbox-proxy-stream-session" },
        messages: [
          { role: "user", content: "Please stream with OrcaProxyRecall context before answering." },
        ],
      },
    });
    const streamingObservedMemory =
      streamingProxyResponse.ok &&
      streamingProxyResponse.text.includes("streamed ") &&
      streamingProxyResponse.text.includes("OrcaProxyRecall") &&
      streamingProxyResponse.text.includes("data: [DONE]") &&
      Number(streamingProxyResponse.headers.get("x-orca-memory-count") ?? "0") > 0;
    addCheck(
      checks,
      "proxy-streaming-enforced-recall",
      streamingObservedMemory,
      `HTTP ${streamingProxyResponse.status}; memory-count=${streamingProxyResponse.headers.get("x-orca-memory-count") ?? "missing"}`,
    );

    const proxyMetrics = await fetch(`${proxyUrl}/metrics`, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const proxyMetricsText = await proxyMetrics.text();
    addCheck(
      checks,
      "proxy-metrics",
      proxyMetrics.ok &&
        proxyMetricsText.includes("orca_proxy_recall_success") &&
        proxyMetricsText.includes("orca_proxy_streaming_requests"),
      `HTTP ${proxyMetrics.status}`,
    );

    const list = await request({ url: `${baseUrl}/v1/memories?scope=workspace`, apiKey });
    addCheck(
      checks,
      "list-memories",
      list.ok && Array.isArray(list.body.memories) && list.body.memories.length >= 8,
      `HTTP ${list.status}; memories=${list.body.memories?.length ?? 0}`,
    );

    const metrics = await request({ url: `${baseUrl}/v1/metrics/modules`, apiKey });
    addCheck(
      checks,
      "module-metrics",
      metrics.ok && Array.isArray(metrics.body.modules) && metrics.body.modules.some((entry) => entry.ingestCount > 0),
      `HTTP ${metrics.status}`,
      metrics.body,
    );

    const prometheus = await fetch(`${baseUrl}/metrics`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const prometheusText = await prometheus.text();
    addCheck(
      checks,
      "prometheus-metrics",
      prometheus.ok && prometheusText.includes("orca_memory_artifact_count"),
      `HTTP ${prometheus.status}`,
    );

    const workflowDefinitions = await request({ url: `${workerUrl}/workflows/definitions`, apiKey });
    addCheck(
      checks,
      "worker-definitions",
      workflowDefinitions.ok && workflowDefinitions.body.workflows?.length >= 6,
      `HTTP ${workflowDefinitions.status}; workflows=${workflowDefinitions.body.workflows?.length ?? 0}`,
    );

    const reindex = await request({
      method: "POST",
      url: `${workerUrl}/workflows/reindex`,
      apiKey,
      body: {},
    });
    addCheck(checks, "worker-reindex", reindex.ok && reindex.body.accepted === true, `HTTP ${reindex.status}`, reindex.body);

    const loadRequests = Number(option("load-requests", "24"));
    const startedLoad = performance.now();
    const loadResults = await Promise.all(
      Array.from({ length: loadRequests }, (_, index) =>
        request({
          method: "POST",
          url: `${baseUrl}/v1/memories/recall`,
          apiKey,
          body: {
            scope: "workspace",
            query: `sandbox load recall ${index} SandboxAlpha HydraRollback OrcaProxyRecall`,
            limit: 3,
          },
        }).then((result) => ({
          ok: result.ok,
          status: result.status,
          elapsedMs: performance.now() - startedLoad,
        })),
      ),
    );
    addCheck(
      checks,
      "load-recall-batch",
      loadResults.every((result) => result.ok),
      `${loadResults.filter((result) => result.ok).length}/${loadRequests} recall requests succeeded.`,
      {
        statusCounts: loadResults.reduce((accumulator, result) => {
          accumulator[result.status] = (accumulator[result.status] ?? 0) + 1;
          return accumulator;
        }, {}),
      },
    );

    const ok = checks.every((check) => check.ok);
    const report = {
      ok,
      sandbox: {
        dataDir,
        keepData,
        ports: {
          memoryApi: memoryPort,
          worker: workerPort,
          proxy: proxyPort,
          mockOpenAi: mockOpenAi.baseUrl,
        },
      },
      checks,
      serviceLogs: Object.fromEntries(
        services.map((service) => [
          service.name,
          {
            stdout: service.logs.stdout.split("\n").slice(-20).join("\n"),
            stderr: service.logs.stderr.split("\n").slice(-20).join("\n"),
          },
        ]),
      ),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    const report = {
      ok: false,
      sandbox: {
        dataDir,
        keepData,
        ports: {
          memoryApi: memoryPort,
          worker: workerPort,
          proxy: proxyPort,
          mockOpenAi: mockOpenAi.baseUrl,
        },
      },
      error: error.message,
      checks,
      serviceLogs: Object.fromEntries(
        services.map((service) => [
          service.name,
          {
            stdout: service.logs.stdout.split("\n").slice(-20).join("\n"),
            stderr: service.logs.stderr.split("\n").slice(-20).join("\n"),
          },
        ]),
      ),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(services.map((service) => service.stop()));
    await mockOpenAi.close().catch(() => {});
    if (!keepData) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
};

await main();
