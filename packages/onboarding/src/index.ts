import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd?: string;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export interface CheckStatus {
  id: string;
  label: string;
  ok: boolean;
  details: string;
}

export interface ServiceHealth {
  name: string;
  url: string;
  ok: boolean;
  details: string;
}

export interface DoctorReport {
  workspaceRoot: string;
  envFile: string;
  checks: CheckStatus[];
  services: ServiceHealth[];
  composeStatus: CheckStatus;
}

export interface BootstrapStep {
  id: string;
  label: string;
  ok: boolean;
  details: string;
}

export interface BootstrapReport {
  workspaceRoot: string;
  envFile: string;
  steps: BootstrapStep[];
  doctor: DoctorReport;
}

export interface HarnessSnippet {
  id: string;
  label: string;
  language: string;
  content: string;
}

export interface HarnessBundle {
  envFile: string;
  generatedJsonPath: string;
  generatedMarkdownPath: string;
  apiKeyPresent: boolean;
  snippets: HarnessSnippet[];
}

export interface BootstrapOptions {
  installDependencies?: boolean;
  startInfrastructure?: boolean;
  startApplications?: boolean;
  generateApiKey?: boolean;
}

const defaultBootstrapOptions: Required<BootstrapOptions> = {
  installDependencies: true,
  startInfrastructure: true,
  startApplications: true,
  generateApiKey: true,
};

const workspaceRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");

const envExamplePath = resolve(workspaceRoot, ".env.example");
const envPath = resolve(workspaceRoot, ".env");
const harnessOutputDir = resolve(workspaceRoot, "generated", "harness");

const localServices = [
  { name: "memory-api", url: "http://127.0.0.1:4000/health" },
  { name: "worker", url: "http://127.0.0.1:4010/health" },
  { name: "weaviate", url: "http://127.0.0.1:8080/v1/.well-known/ready" },
  { name: "temporal-ui", url: "http://127.0.0.1:8233" },
] as const;

const commandDisplay = (command: string, args: string[]): string =>
  [command, ...args].join(" ");

const runCommand = async (
  command: string,
  args: string[],
  cwd = workspaceRoot,
): Promise<CommandResult> =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
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
        command: commandDisplay(command, args),
        exitCode: 1,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${(error as Error).message}`.trim(),
        ok: false,
      });
    });

    child.on("close", (code) => {
      resolvePromise({
        command: commandDisplay(command, args),
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ok: code === 0,
      });
    });
  });

const parseEnv = (raw: string): Map<string, string> => {
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    entries.set(key, value);
  }
  return entries;
};

const serializeEnv = (raw: string, patch: Record<string, string>): string => {
  const seen = new Set<string>();
  const updated = raw.split(/\r?\n/).map((line) => {
    const separator = line.indexOf("=");
    if (separator === -1) {
      return line;
    }
    const key = line.slice(0, separator).trim();
    if (!(key in patch)) {
      return line;
    }
    seen.add(key);
    return `${key}=${patch[key]}`;
  });

  for (const [key, value] of Object.entries(patch)) {
    if (!seen.has(key)) {
      updated.push(`${key}=${value}`);
    }
  }

  return `${updated.join("\n").replace(/\n+$/u, "")}\n`;
};

const createApiKey = (): string => randomBytes(24).toString("hex");

export const getWorkspaceRoot = (): string => workspaceRoot;

export const ensureEnvFile = async (generateApiKey = true): Promise<{
  path: string;
  created: boolean;
  apiKeyGenerated: boolean;
  values: Map<string, string>;
}> => {
  const created = !existsSync(envPath);
  if (created) {
    const template = await readFile(envExamplePath, "utf8");
    await writeFile(envPath, template, "utf8");
  }

  const current = await readFile(envPath, "utf8");
  const values = parseEnv(current);
  const currentApiKey = values.get("ORCA_API_KEY") ?? "";
  const apiKeyGenerated = generateApiKey && currentApiKey.trim().length === 0;

  if (!apiKeyGenerated) {
    return {
      path: envPath,
      created,
      apiKeyGenerated: false,
      values,
    };
  }

  const nextApiKey = createApiKey();
  const updated = serializeEnv(current, { ORCA_API_KEY: nextApiKey });
  await writeFile(envPath, updated, "utf8");

  return {
    path: envPath,
    created,
    apiKeyGenerated: true,
    values: parseEnv(updated),
  };
};

const commandCheck = async (
  id: string,
  label: string,
  command: string,
  args: string[],
): Promise<CheckStatus> => {
  const result = await runCommand(command, args);
  return {
    id,
    label,
    ok: result.ok,
    details: result.ok
      ? result.stdout || `${label} is available.`
      : result.stderr || `${label} is not available.`,
  };
};

const fetchHealth = async (name: string, url: string): Promise<ServiceHealth> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return {
      name,
      url,
      ok: response.ok,
      details: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      details: (error as Error).message,
    };
  }
};

export const runDoctor = async (): Promise<DoctorReport> => {
  const checks = await Promise.all([
    commandCheck("node", "Node.js", "node", ["--version"]),
    commandCheck("pnpm", "pnpm", "pnpm", ["--version"]),
    commandCheck("docker", "Docker CLI", "docker", ["--version"]),
    commandCheck("docker-compose", "Docker Compose", "docker", ["compose", "version"]),
  ]);

  const composeResult = await runCommand("docker", ["compose", "ps"]);
  const services = await Promise.all(localServices.map((service) => fetchHealth(service.name, service.url)));

  return {
    workspaceRoot,
    envFile: envPath,
    checks,
    services,
    composeStatus: {
      id: "compose-ps",
      label: "Docker Compose status",
      ok: composeResult.ok,
      details: composeResult.ok
        ? composeResult.stdout || "Compose command completed."
        : composeResult.stderr || "Compose status unavailable.",
    },
  };
};

const reportStep = (id: string, label: string, result: CommandResult): BootstrapStep => ({
  id,
  label,
  ok: result.ok,
  details: [result.command, result.stdout, result.stderr].filter(Boolean).join("\n\n"),
});

export const runBootstrap = async (
  options: BootstrapOptions = {},
): Promise<BootstrapReport> => {
  const settings = { ...defaultBootstrapOptions, ...options };
  const steps: BootstrapStep[] = [];

  const envResult = await ensureEnvFile(settings.generateApiKey);
  steps.push({
    id: "env",
    label: "Prepare .env",
    ok: true,
    details: [
      envResult.created ? `Created ${envResult.path} from .env.example.` : `Using existing ${envResult.path}.`,
      envResult.apiKeyGenerated ? "Generated ORCA_API_KEY." : "Kept existing ORCA_API_KEY.",
    ].join(" "),
  });

  if (settings.installDependencies) {
    const install = await runCommand("pnpm", ["install", "--frozen-lockfile"]);
    steps.push(reportStep("install", "Install dependencies", install));
  }

  if (settings.startInfrastructure) {
    const infra = await runCommand("docker", ["compose", "up", "-d"]);
    steps.push(reportStep("infra", "Start infrastructure", infra));
  }

  if (settings.startApplications) {
    const apps = await runCommand("docker", ["compose", "--profile", "app", "up", "-d", "--build"]);
    steps.push(reportStep("apps", "Start application services", apps));
  }

  const doctor = await runDoctor();
  return {
    workspaceRoot,
    envFile: envPath,
    steps,
    doctor,
  };
};

export const stopStack = async (): Promise<CommandResult> =>
  runCommand("docker", ["compose", "--profile", "app", "down"]);

export const buildHarnessBundle = async (): Promise<HarnessBundle> => {
  const ensuredEnv = await ensureEnvFile(true);
  const apiKey = ensuredEnv.values.get("ORCA_API_KEY") ?? "";
  const apiKeyPresent = apiKey.trim().length > 0;

  await mkdir(harnessOutputDir, { recursive: true });

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
      workflows: "/v1/workflows/runs",
      metrics: "/v1/metrics/modules",
    },
    worker: {
      baseUrl: "http://127.0.0.1:4010",
      reindex: "/workflows/reindex",
      execute: "/workflows/execute",
    },
    notes: [
      "Use the enforced harness middleware when you control the agent runtime.",
      "Use the OpenAI-compatible proxy when you need every chat completion intercepted without deeper harness changes.",
      "Use the MCP bridge for explicit memory tools alongside enforced middleware or proxy mode.",
    ],
    enforcedMemory: {
      beforePrompt: "recall relevant memory and inject it as system context",
      afterResponse: "ingest completed turns as episodic memory",
      proxy: "route OpenAI-compatible chat completions through ORCA_PROXY_URL",
    },
  };

  const genericEnv = [
    "export ORCA_BASE_URL=http://127.0.0.1:4000",
    "export ORCA_PROXY_URL=http://127.0.0.1:4030",
    apiKeyPresent ? `export ORCA_API_KEY=${apiKey}` : "export ORCA_API_KEY=<paste-your-key>",
    "export ORCA_REQUIRED=true",
    "export ORCA_FAILURE_MODE=block",
  ].join("\n");

  const nodeSnippet = `import { EnforcedMemoryHarness } from "@orca/harness";\n\nconst memory = new EnforcedMemoryHarness({\n  required: true,\n  failureMode: "block",\n  defaultScope: "workspace",\n});\n\nconst before = await memory.beforePrompt({\n  sessionId: "local-session",\n  prompt: userPrompt,\n  messages: [{ role: "user", content: userPrompt }],\n});\n\nconst response = await agent.run(before.messages);\n\nawait memory.afterResponse({\n  sessionId: "local-session",\n  prompt: userPrompt,\n  response: response.text,\n});`;

  const proxySnippet = `export ORCA_PROXY_URL=http://127.0.0.1:4030\nexport ORCA_PROXY_UPSTREAM_BASE_URL=https://api.openai.com\nexport OPENAI_API_KEY=<your-provider-api-key>\npnpm orca:proxy\n\n# Configure the harness with OPENAI_BASE_URL=\${ORCA_PROXY_URL}`;

  const mcpSnippet = JSON.stringify({
    mcpServers: {
      orca: {
        command: "uv",
        args: ["run", "python", "integrations/mcp-server/server.py"],
        env: {
          ORCA_BASE_URL: "http://127.0.0.1:4000",
          ORCA_API_KEY: apiKeyPresent ? apiKey : "<your-api-key>",
        },
      },
    },
  }, null, 2);

  const curlSnippet = `curl -X POST http://127.0.0.1:4000/v1/memories/recall \\\n  -H 'content-type: application/json' \\\n  -H 'x-api-key: ${apiKeyPresent ? apiKey : "<your-api-key>"}' \\\n  -d '{\n    "query": "What should I remember from the current session?",\n    "scope": "workspace",\n    "includeDiagnostics": true\n  }'`;

  const snippets: HarnessSnippet[] = [
    {
      id: "env",
      label: "Harness environment",
      language: "bash",
      content: genericEnv,
    },
    {
      id: "manifest",
      label: "Harness manifest",
      language: "json",
      content: JSON.stringify(manifest, null, 2),
    },
    {
      id: "node-fetch",
      label: "Enforced middleware example",
      language: "ts",
      content: nodeSnippet,
    },
    {
      id: "proxy",
      label: "OpenAI-compatible proxy",
      language: "bash",
      content: proxySnippet,
    },
    {
      id: "mcp",
      label: "MCP tool bridge",
      language: "json",
      content: mcpSnippet,
    },
    {
      id: "curl",
      label: "Connection smoke test",
      language: "bash",
      content: curlSnippet,
    },
  ];

  const generatedJsonPath = resolve(harnessOutputDir, "orca-harness-config.json");
  const generatedMarkdownPath = resolve(harnessOutputDir, "orca-harness-config.md");

  await writeFile(generatedJsonPath, JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(
    generatedMarkdownPath,
    [
      "# Orca Harness Bundle",
      "",
      "## Environment",
      "```bash",
      genericEnv,
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
      "## Enforced Proxy",
      "```bash",
      proxySnippet,
      "```",
      "",
      "## MCP Bridge",
      "```json",
      mcpSnippet,
      "```",
      "",
      "## Smoke Test",
      "```bash",
      curlSnippet,
      "```",
    ].join("\n"),
    "utf8",
  );

  return {
    envFile: envPath,
    generatedJsonPath,
    generatedMarkdownPath,
    apiKeyPresent,
    snippets,
  };
};
