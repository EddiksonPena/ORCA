#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(new URL(".", import.meta.url).pathname, "..");
const defaultEnvPath = resolve(workspaceRoot, ".env");
const defaultProductionEnvPath = resolve(workspaceRoot, ".env.production.example");

const args = process.argv.slice(2);
const command = args[0] ?? "help";

const option = (name, fallback) => {
  const direct = args.find((entry) => entry.startsWith(`--${name}=`));
  if (direct) {
    return direct.slice(name.length + 3);
  }

  const index = args.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }

  return fallback;
};

const parseInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseEnv = (raw) => {
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    entries.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return entries;
};

const loadEnvFile = async (path) => {
  const targetPath = resolve(path);
  if (!existsSync(targetPath)) {
    throw new Error(`Env file not found: ${targetPath}`);
  }
  return {
    path: targetPath,
    values: parseEnv(await readFile(targetPath, "utf8")),
  };
};

const print = (value) => {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
};

const addCheck = (checks, id, ok, details) => {
  checks.push({ id, ok, details });
};

const hasPlaceholder = (value) =>
  !value
  || /replace-me|<.+>|example\.com|changeme|your-|paste-your/i.test(value);

const addHeaderAuth = (headers, apiKey, bearerToken) => {
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
};

const checkUrl = async (name, url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { id: name, ok: response.ok, details: `${url} -> HTTP ${response.status}` };
  } catch (error) {
    return { id: name, ok: false, details: `${url} -> ${(error).message}` };
  }
};

const requireValue = (checks, warnings, values, key, { allowPlaceholder = false, warnIfLocalhost = false } = {}) => {
  const value = values.get(key)?.trim() ?? "";
  if (!value) {
    addCheck(checks, key, false, `${key} is missing.`);
    return;
  }

  if (!allowPlaceholder && hasPlaceholder(value)) {
    addCheck(checks, key, false, `${key} still contains a placeholder value.`);
    return;
  }

  if (warnIfLocalhost && /localhost|127\.0\.0\.1/i.test(value)) {
    warnings.push({ id: `${key}-localhost`, details: `${key} points to localhost; replace it before production deployment.` });
  }

  addCheck(checks, key, true, `${key} is configured.`);
};

const preflight = async () => {
  const envFile = option("env-file", existsSync(defaultEnvPath) ? defaultEnvPath : defaultProductionEnvPath);
  const { path, values } = await loadEnvFile(envFile);
  const checks = [];
  const warnings = [];

  const authMode = values.get("ORCA_AUTH_MODE")?.trim() || "none";
  const memoryStateBackend = values.get("MEMORY_STATE_BACKEND")?.trim() || "file";

  addCheck(
    checks,
    "memory-state-backend",
    memoryStateBackend === "redis",
    memoryStateBackend === "redis"
      ? "MEMORY_STATE_BACKEND is set to redis."
      : `MEMORY_STATE_BACKEND is ${memoryStateBackend}; production deployments should use redis.`,
  );

  requireValue(checks, warnings, values, "REDIS_URL", { warnIfLocalhost: true });
  requireValue(checks, warnings, values, "WEAVIATE_HTTP_URL", { warnIfLocalhost: true });
  requireValue(checks, warnings, values, "NEO4J_URI", { warnIfLocalhost: true });
  requireValue(checks, warnings, values, "NEO4J_USERNAME");
  requireValue(checks, warnings, values, "NEO4J_PASSWORD");
  requireValue(checks, warnings, values, "TEMPORAL_ADDRESS", { warnIfLocalhost: true });
  requireValue(checks, warnings, values, "TEMPORAL_NAMESPACE");
  requireValue(checks, warnings, values, "TEMPORAL_WORKFLOW_TASK_QUEUE");

  addCheck(
    checks,
    "auth-mode",
    authMode !== "none",
    authMode !== "none"
      ? `ORCA_AUTH_MODE is ${authMode}.`
      : "ORCA_AUTH_MODE is none; production deployments should require auth.",
  );

  if (authMode === "api-key") {
    warnings.push({
      id: "auth-mode-api-key",
      details: "API-key-only auth works, but hybrid or jwt mode is a stronger production default.",
    });
  }

  if (authMode === "api-key" || authMode === "hybrid") {
    requireValue(checks, warnings, values, "ORCA_API_KEY");
  }

  if (authMode === "jwt" || authMode === "hybrid") {
    requireValue(checks, warnings, values, "ORCA_JWT_ISSUER");
    requireValue(checks, warnings, values, "ORCA_JWT_AUDIENCE");

    const jwksUrl = values.get("ORCA_JWKS_URL")?.trim()
      || (() => {
        const issuer = values.get("ORCA_JWT_ISSUER")?.trim();
        if (!issuer || hasPlaceholder(issuer)) {
          return "";
        }
        return new URL("/.well-known/jwks.json", issuer).toString();
      })();

    if (jwksUrl) {
      addCheck(checks, "jwks-url", true, `JWT verification will use ${jwksUrl}.`);

      if (!option("skip-network", "")) {
        const jwksCheck = await checkUrl("jwks-reachable", jwksUrl);
        checks.push(jwksCheck);
      }
    } else {
      addCheck(checks, "jwks-url", false, "No JWKS URL could be derived from the JWT settings.");
    }
  }

  const otel = values.get("OTEL_EXPORTER_OTLP_ENDPOINT")?.trim();
  if (!otel) {
    warnings.push({
      id: "otel-missing",
      details: "OTEL_EXPORTER_OTLP_ENDPOINT is blank. Metrics still work, but trace export is not configured.",
    });
  }

  const result = {
    envFile: path,
    ok: checks.every((check) => check.ok),
    checks,
    warnings,
  };

  print(result);
  process.exit(result.ok ? 0 : 1);
};

const readResponseJson = async (response) => {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
};

const requestTimeoutMs = () => {
  const parsed = Number(option("timeout-ms", process.env.ORCA_VERIFY_TIMEOUT_MS ?? "120000"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
};

const verify = async () => {
  const baseUrl = option("base-url", process.env.ORCA_BASE_URL ?? "http://127.0.0.1:4000");
  const workerUrl = option("worker-url", process.env.ORCA_WORKER_URL ?? "http://127.0.0.1:4010");
  const apiKey = option("api-key", process.env.ORCA_API_KEY ?? "");
  const bearerToken = option("bearer-token", process.env.ORCA_BEARER_TOKEN ?? "");
  const scope = option("scope", "project:production-readiness");
  const timeoutMs = requestTimeoutMs();
  const now = new Date().toISOString();
  const unique = `orca-production-verify-${Date.now()}`;
  const checks = [];

  const authHeaders = addHeaderAuth({ "content-type": "application/json" }, apiKey, bearerToken);

  const healthChecks = await Promise.all([
    checkUrl("memory-api-health", `${baseUrl}/health`),
    checkUrl("worker-health", `${workerUrl}/health`),
  ]);
  checks.push(...healthChecks);

  if (!apiKey && !bearerToken) {
    addCheck(checks, "auth-credentials", false, "Provide ORCA_API_KEY or ORCA_BEARER_TOKEN for authenticated verification.");
    print({ baseUrl, workerUrl, ok: false, checks });
    process.exit(1);
  }

  const ingestResponse = await fetch(`${baseUrl}/v1/memories/ingest`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      scope,
      source: "production-readiness-verify",
      tags: ["verification", "production"],
      content: `Production readiness verification memory ${unique} at ${now}.`,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  checks.push({
    id: "ingest-memory",
    ok: ingestResponse.ok,
    details: `POST /v1/memories/ingest -> HTTP ${ingestResponse.status}`,
  });

  const recallResponse = await fetch(`${baseUrl}/v1/memories/recall`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      scope,
      query: unique,
      includeDiagnostics: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const recallPayload = await readResponseJson(recallResponse);
  const recallMatches = JSON.stringify(recallPayload).includes(unique);
  checks.push({
    id: "recall-memory",
    ok: recallResponse.ok && recallMatches,
    details: recallResponse.ok
      ? recallMatches
        ? "Recall returned the injected verification memory."
        : "Recall request succeeded, but the injected verification memory was not found in the response."
      : `POST /v1/memories/recall -> HTTP ${recallResponse.status}`,
  });

  const appMetricsResponse = await fetch(`${baseUrl}/v1/metrics/modules`, {
    headers: addHeaderAuth({}, apiKey, bearerToken),
    signal: AbortSignal.timeout(timeoutMs),
  });
  checks.push({
    id: "app-module-metrics",
    ok: appMetricsResponse.ok,
    details: `GET /v1/metrics/modules -> HTTP ${appMetricsResponse.status}`,
  });

  const appPrometheusResponse = await fetch(`${baseUrl}/metrics`, {
    headers: addHeaderAuth({}, apiKey, bearerToken),
    signal: AbortSignal.timeout(timeoutMs),
  });
  checks.push({
    id: "app-prometheus-metrics",
    ok: appPrometheusResponse.ok,
    details: `GET /metrics -> HTTP ${appPrometheusResponse.status}`,
  });

  const workflowDefinitionsResponse = await fetch(`${workerUrl}/workflows/definitions`, {
    headers: addHeaderAuth({}, apiKey, bearerToken),
    signal: AbortSignal.timeout(timeoutMs),
  });
  checks.push({
    id: "worker-workflow-definitions",
    ok: workflowDefinitionsResponse.ok,
    details: `GET /workflows/definitions -> HTTP ${workflowDefinitionsResponse.status}`,
  });

  const workflowRunsResponse = await fetch(`${workerUrl}/workflows/runs`, {
    headers: addHeaderAuth({}, apiKey, bearerToken),
    signal: AbortSignal.timeout(timeoutMs),
  });
  checks.push({
    id: "worker-workflow-runs",
    ok: workflowRunsResponse.ok,
    details: `GET /workflows/runs -> HTTP ${workflowRunsResponse.status}`,
  });

  const workerPrometheusResponse = await fetch(`${workerUrl}/metrics`, {
    headers: addHeaderAuth({}, apiKey, bearerToken),
    signal: AbortSignal.timeout(timeoutMs),
  });
  checks.push({
    id: "worker-prometheus-metrics",
    ok: workerPrometheusResponse.ok,
    details: `GET /metrics -> HTTP ${workerPrometheusResponse.status}`,
  });

  const result = {
    baseUrl,
    workerUrl,
    ok: checks.every((check) => check.ok),
    checks,
  };
  print(result);
  process.exit(result.ok ? 0 : 1);
};

const runLoadBatch = async ({ baseUrl, apiKey, bearerToken, concurrency, batchSize, scope }) => {
  let successes = 0;
  let failures = 0;
  const latencies = [];
  const statusCounts = {};
  const errorSamples = [];

  const performRequest = async (requestNumber) => {
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/v1/memories/recall`, {
        method: "POST",
        headers: addHeaderAuth({ "content-type": "application/json" }, apiKey, bearerToken),
        body: JSON.stringify({
          scope,
          query: `load validation request ${requestNumber}`,
          includeDiagnostics: false,
        }),
        signal: AbortSignal.timeout(6000),
      });
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      if (response.ok) {
        successes += 1;
      } else {
        failures += 1;
        if (errorSamples.length < 5) {
          errorSamples.push({
            requestNumber,
            status: response.status,
            body: await response.text(),
          });
        }
      }
    } catch (error) {
      failures += 1;
      statusCounts.error = (statusCounts.error ?? 0) + 1;
      if (errorSamples.length < 5) {
        errorSamples.push({
          requestNumber,
          status: "error",
          body: (error).message,
        });
      }
    } finally {
      latencies.push(performance.now() - started);
    }
  };

  for (let cursor = 0; cursor < batchSize; cursor += concurrency) {
    const slice = [];
    for (let inner = 0; inner < concurrency && cursor + inner < batchSize; inner += 1) {
      slice.push(performRequest(cursor + inner + 1));
    }
    await Promise.all(slice);
  }

  latencies.sort((left, right) => left - right);
  const percentile = (ratio) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))] ?? 0;

  return {
    totalRequests: batchSize,
    successes,
    failures,
    successRate: batchSize === 0 ? 0 : successes / batchSize,
    averageLatencyMs: latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p95LatencyMs: percentile(0.95),
    p99LatencyMs: percentile(0.99),
    statusCounts,
    errorSamples,
  };
};

const load = async () => {
  const baseUrl = option("base-url", process.env.ORCA_BASE_URL ?? "http://127.0.0.1:4000");
  const apiKey = option("api-key", process.env.ORCA_API_KEY ?? "");
  const bearerToken = option("bearer-token", process.env.ORCA_BEARER_TOKEN ?? "");
  const concurrency = parseInteger(option("concurrency", "4"), 4);
  const requests = parseInteger(option("requests", "40"), 40);
  const scope = option("scope", "production-readiness");

  if (!apiKey && !bearerToken) {
    print({
      ok: false,
      message: "Provide ORCA_API_KEY or ORCA_BEARER_TOKEN for authenticated load checks.",
    });
    process.exit(1);
  }

  const summary = await runLoadBatch({
    baseUrl,
    apiKey,
    bearerToken,
    concurrency,
    batchSize: requests,
    scope,
  });
  const ok = summary.failures === 0;
  print({
    baseUrl,
    concurrency,
    ok,
    ...summary,
  });
  process.exit(ok ? 0 : 1);
};

if (command === "help" || command === "--help" || command === "-h") {
  print([
    "Orca production readiness commands",
    "",
    "node scripts/production-readiness.mjs preflight [--env-file .env.production.example]",
    "node scripts/production-readiness.mjs verify [--base-url http://127.0.0.1:4000] [--worker-url http://127.0.0.1:4010]",
    "node scripts/production-readiness.mjs load [--base-url http://127.0.0.1:4000] [--requests 40] [--concurrency 4]",
    "",
    "Auth for verify/load can be provided with:",
    "  ORCA_API_KEY=...",
    "  ORCA_BEARER_TOKEN=...",
  ].join("\n"));
  process.exit(0);
}

if (command === "preflight") {
  await preflight();
}

if (command === "verify") {
  await verify();
}

if (command === "load") {
  await load();
}

print("Unknown command.");
process.exit(1);
