#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const workspaceRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const envExamplePath = resolve(workspaceRoot, ".env.example");
const envPath = resolve(workspaceRoot, ".env");
const harnessDir = resolve(workspaceRoot, "generated", "harness");

const command = process.argv[2] ?? "help";

const run = (bin, args) =>
  new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolvePromise({
        command: [bin, ...args].join(" "),
        ok: false,
        exitCode: 1,
        stdout: stdout.trim(),
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`.trim(),
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        command: [bin, ...args].join(" "),
        ok: code === 0,
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });

const runStreaming = (bin, args) =>
  new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      resolvePromise({
        command: [bin, ...args].join(" "),
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: error.message,
      });
    });

    child.on("close", (code) => {
      resolvePromise({
        command: [bin, ...args].join(" "),
        ok: code === 0,
        exitCode: code ?? 1,
        stdout: "",
        stderr: "",
      });
    });
  });

const parseEnv = (raw) => {
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    entries.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return entries;
};

const serializeEnv = (raw, patch) => {
  const seen = new Set();
  const lines = raw.split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    if (index === -1) {
      return line;
    }
    const key = line.slice(0, index).trim();
    if (!(key in patch)) {
      return line;
    }
    seen.add(key);
    return `${key}=${patch[key]}`;
  });

  for (const [key, value] of Object.entries(patch)) {
    if (!seen.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
};

const createApiKey = () => randomBytes(24).toString("hex");

const ensureEnv = async () => {
  let created = false;
  if (!existsSync(envPath)) {
    await writeFile(envPath, await readFile(envExamplePath, "utf8"), "utf8");
    created = true;
  }

  const current = await readFile(envPath, "utf8");
  const values = parseEnv(current);
  const apiKey = values.get("ORCA_API_KEY") ?? "";
  let generated = false;

  if (!apiKey.trim()) {
    generated = true;
    const updated = serializeEnv(current, { ORCA_API_KEY: createApiKey() });
    await writeFile(envPath, updated, "utf8");
  }

  return {
    created,
    generated,
    values: parseEnv(await readFile(envPath, "utf8")),
  };
};

const healthCheck = async (name, url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { name, url, ok: response.ok, details: `HTTP ${response.status}` };
  } catch (error) {
    return { name, url, ok: false, details: error.message };
  }
};

const doctor = async () => {
  const checks = await Promise.all([
    run("node", ["--version"]),
    run("pnpm", ["--version"]),
    run("docker", ["--version"]),
    run("docker", ["compose", "version"]),
  ]);
  const compose = await run("docker", ["compose", "ps"]);
  const services = await Promise.all([
    healthCheck("memory-api", "http://127.0.0.1:4000/health"),
    healthCheck("worker", "http://127.0.0.1:4010/health"),
    healthCheck("weaviate", "http://127.0.0.1:8080/v1/.well-known/ready"),
    healthCheck("temporal-ui", "http://127.0.0.1:8233"),
  ]);
  return {
    workspaceRoot,
    envFile: envPath,
    checks,
    compose,
    services,
  };
};

const connect = async () => {
  await ensureEnv();
  const env = parseEnv(await readFile(envPath, "utf8"));
  const apiKey = env.get("ORCA_API_KEY") ?? "<your-api-key>";
  const manifest = {
    name: "orca",
    transport: "http+mcp+proxy",
    baseUrl: "http://127.0.0.1:4000",
    proxyUrl: "http://127.0.0.1:4030",
    apiKeyEnv: "ORCA_API_KEY",
    requiredEnv: "ORCA_REQUIRED",
    failureModeEnv: "ORCA_FAILURE_MODE",
    endpoints: {
      ingest: "/v1/memories/ingest",
      recall: "/v1/memories/recall",
      feedback: "/v1/memories/feedback",
      compact: "/v1/memories/compact",
    },
    enforcedMemory: {
      beforePrompt: "recall relevant memory and inject it as a system context block",
      afterResponse: "ingest the completed turn as episodic memory",
      compaction: "compact long sessions through /v1/memories/compact",
      proxy: "send OpenAI-compatible chat completions to ORCA_PROXY_URL so every prompt is intercepted",
    },
  };

  await mkdir(harnessDir, { recursive: true });
  const jsonPath = resolve(harnessDir, "orca-harness-config.json");
  const mdPath = resolve(harnessDir, "orca-harness-config.md");

  const envSnippet = [
    "export ORCA_BASE_URL=http://127.0.0.1:4000",
    "export ORCA_PROXY_URL=http://127.0.0.1:4030",
    `export ORCA_API_KEY=${apiKey}`,
    "export ORCA_REQUIRED=true",
    "export ORCA_FAILURE_MODE=block",
  ].join("\n");

  const nodeSnippet = `import { EnforcedMemoryHarness } from "@orca/harness";\n\nconst memory = new EnforcedMemoryHarness({\n  required: true,\n  failureMode: "block",\n  defaultScope: "workspace",\n});\n\nconst before = await memory.beforePrompt({\n  sessionId: "local-session",\n  prompt: userPrompt,\n  messages: [{ role: "user", content: userPrompt }],\n});\n\nconst response = await agent.run(before.messages);\n\nawait memory.afterResponse({\n  sessionId: "local-session",\n  prompt: userPrompt,\n  response: response.text,\n});`;

  const proxySnippet = `export ORCA_PROXY_UPSTREAM_BASE_URL=https://api.openai.com\nexport OPENAI_API_KEY=<your-provider-api-key>\n\npnpm orca:proxy\n\n# Configure your harness, not the proxy process, with:\n# OPENAI_BASE_URL=\${ORCA_PROXY_URL}\n# Any OpenAI-compatible chat completion sent to http://127.0.0.1:4030/v1/chat/completions\n# is recalled before the model call and ingested after the model response.`;

  const mcpSnippet = JSON.stringify({
    mcpServers: {
      orca: {
        command: "uv",
        args: ["run", "python", "integrations/mcp-server/server.py"],
        env: {
          ORCA_BASE_URL: "http://127.0.0.1:4000",
          ORCA_API_KEY: apiKey,
        },
      },
    },
  }, null, 2);

  const markdown = [
    "# Orca Harness Bundle",
    "",
    "## Environment",
    "```bash",
    envSnippet,
    "```",
    "",
    "## Manifest",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "",
    "## Node Example",
    "```ts",
    nodeSnippet,
    "```",
    "",
    "## Enforced OpenAI-Compatible Proxy",
    "```bash",
    proxySnippet,
    "```",
    "",
    "## MCP Server Config",
    "```json",
    mcpSnippet,
    "```",
  ].join("\n");

  await writeFile(jsonPath, JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(mdPath, markdown, "utf8");

  return {
    envFile: envPath,
    generatedJsonPath: jsonPath,
    generatedMarkdownPath: mdPath,
    manifest,
    snippets: {
      env: envSnippet,
      node: nodeSnippet,
      proxy: proxySnippet,
      mcp: mcpSnippet,
    },
  };
};

const print = (value) => {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
};

if (command === "help" || command === "--help" || command === "-h") {
  print([
    "Orca bootstrap commands",
    "",
    "node scripts/bootstrap.mjs init",
    "node scripts/bootstrap.mjs doctor",
    "node scripts/bootstrap.mjs connect",
    "pnpm orca:proxy",
    "node scripts/bootstrap.mjs ui",
    "node scripts/bootstrap.mjs down",
    "node scripts/production-readiness.mjs preflight",
    "node scripts/production-readiness.mjs smoke",
    "node scripts/production-readiness.mjs load",
  ].join("\n"));
  process.exit(0);
}

if (command === "doctor") {
  const report = await doctor();
  print(report);
  process.exit(report.checks.every((check) => check.ok) ? 0 : 1);
}

if (command === "connect") {
  print(await connect());
  process.exit(0);
}

if (command === "down") {
  const result = await run("docker", ["compose", "--profile", "app", "down"]);
  print(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === "ui") {
  if (!existsSync(resolve(workspaceRoot, "node_modules"))) {
    const install = await run("pnpm", ["install", "--frozen-lockfile"]);
    if (!install.ok) {
      print(install);
      process.exit(1);
    }
  }

  const result = await runStreaming("pnpm", ["--filter", "@orca/onboarding-ui", "start"]);
  process.exit(result.ok ? 0 : 1);
}

if (command === "init") {
  const env = await ensureEnv();
  const steps = [
    {
      id: "env",
      ok: true,
      details: env.created ? "Created .env." : "Using existing .env.",
    },
    await run("pnpm", ["install", "--frozen-lockfile"]),
    await run("docker", ["compose", "up", "-d"]),
    await run("docker", ["compose", "--profile", "app", "up", "-d", "--build"]),
  ];
  const report = {
    steps,
    doctor: await doctor(),
  };
  print(report);
  const ok = steps.every((step) => step.ok);
  process.exit(ok ? 0 : 1);
}

print("Unknown command.");
process.exit(1);
