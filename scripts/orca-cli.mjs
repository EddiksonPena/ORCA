#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const workspaceRoot = resolve(new URL(".", import.meta.url).pathname, "..");
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const command = args[0] ?? "help";
const defaultOutputDir = resolve(workspaceRoot, "generated", "harness");

const option = (name, fallback) => {
  const direct = args.find((entry) => entry.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
};

const baseUrl = () => option("base-url", process.env.ORCA_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/u, "");
const apiKey = () => option("api-key", process.env.ORCA_API_KEY ?? "");
const destinationDir = () => option("destination", option("dest", ""));

const print = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const harnessAliases = {
  codex: "codex",
  "codex-cli": "codex",
  cursor: "cursor",
  "cursor-cli": "cursor",
  claude: "claude-code",
  "claude-code": "claude-code",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  opencode: "opencode",
  "open-code": "opencode",
  antigravity: "antigravity",
  pi: "pi",
  "factory-droid": "factory-droid",
  droid: "factory-droid",
  generic: "generic",
  universal: "universal",
};

const canonicalTarget = (target) => harnessAliases[target] ?? target;
const safeTarget = (target) => canonicalTarget(target).replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+/u, "custom") || "universal";

const lifecycleContract = [
  {
    stage: "session_start",
    aliases: ["SessionStart", "session_start", "on_session_start", "startup", "resume"],
    purpose: "health check and bootstrap recall",
    orcaAction: "POST /v1/memories/recall",
  },
  {
    stage: "pre_prompt",
    aliases: ["UserPromptSubmit", "pre_prompt", "prompt_submit", "pre_llm_call", "before_model", "pre_chat"],
    purpose: "recall and inject relevant context",
    orcaAction: "POST /v1/memories/recall",
  },
  {
    stage: "pre_tool",
    aliases: ["PreToolUse", "pre_tool", "pretool", "before_tool", "pre_tool_call"],
    purpose: "recall tool-relevant procedures and risks",
    orcaAction: "POST /v1/memories/recall",
  },
  {
    stage: "post_tool",
    aliases: ["PostToolUse", "post_tool", "posttool", "after_tool", "post_tool_call"],
    purpose: "ingest tool result and operational facts",
    orcaAction: "POST /v1/memories/ingest",
  },
  {
    stage: "post_response",
    aliases: ["PostResponse", "post_response", "post_llm_call", "after_model", "after_chat"],
    purpose: "ingest completed assistant turn",
    orcaAction: "POST /v1/memories/ingest",
  },
  {
    stage: "session_end",
    aliases: ["Stop", "SessionEnd", "session_end", "on_session_end", "shutdown"],
    purpose: "compact and persist session summary",
    orcaAction: "POST /v1/memories/compact",
  },
];

const adapterNotes = (target) => {
  const known = {
    codex: {
      ruleFiles: ["AGENTS.md", ".codex/config.toml", "project instructions"],
      hooks: "Use hooks.codex.example.json as a Codex-style starting point; enable Codex hooks in config if supported.",
      mcp: "Merge codex.mcp.json into the Codex MCP config surface.",
      modelRouting: "Set OPENAI_BASE_URL to ORCA_PROXY_URL when using an OpenAI-compatible provider.",
    },
    "claude-code": {
      ruleFiles: ["CLAUDE.md"],
      hooks: "Claude-style installations usually rely on instructions + MCP; use the abstract lifecycle contract for any available hook/plugin layer.",
      mcp: "Merge claude-code.mcp.json into .mcp.json or the configured MCP surface.",
      modelRouting: "Use proxy routing only if the runtime exposes provider base URL configuration.",
    },
    cursor: {
      ruleFiles: [".cursor/rules/*.md", "cursor rules"],
      hooks: "Cursor support varies by environment; use the abstract lifecycle contract or external wrapper scripts where direct lifecycle hooks are unavailable.",
      mcp: "Merge cursor.mcp.json into .cursor/mcp.json.",
      modelRouting: "Use proxy routing only where Cursor/provider settings allow a custom OpenAI-compatible base URL.",
    },
    "gemini-cli": {
      ruleFiles: ["GEMINI.md"],
      hooks: "Gemini CLI installations should merge rules/MCP first, then adapt the lifecycle contract to any local wrapper or extension surface.",
      mcp: "Merge gemini-cli.mcp.json into the Gemini settings MCP section.",
      modelRouting: "Use proxy routing if the CLI supports OpenAI-compatible base URLs or wrap calls through ORCA_PROXY_URL.",
    },
    opencode: {
      ruleFiles: ["AGENTS.md", "opencode instructions"],
      hooks: "Merge the abstract lifecycle contract into OpenCode hook/plugin config where available.",
      mcp: "Merge opencode.mcp.json into opencode.json.",
      modelRouting: "Set provider base URL to ORCA_PROXY_URL when supported.",
    },
    antigravity: {
      ruleFiles: ["AGENTS.md", "ANTIGRAVITY.md", "project rules"],
      hooks: "Map the abstract lifecycle contract onto Antigravity's available agent rules, tools, or wrapper hooks.",
      mcp: "Install the generated MCP config if Antigravity exposes MCP configuration.",
      modelRouting: "Prefer ORCA_PROXY_URL for model calls when a custom base URL is supported.",
    },
    pi: {
      ruleFiles: ["AGENTS.md", "PI.md", "project rules"],
      hooks: "Use the abstract lifecycle contract; install only lifecycle events Pi exposes.",
      mcp: "Install the generated MCP config if Pi exposes MCP configuration.",
      modelRouting: "Prefer ORCA_PROXY_URL for OpenAI-compatible model calls.",
    },
    "factory-droid": {
      ruleFiles: ["AGENTS.md", "DROID.md", "FACTORY.md", "project rules"],
      hooks: "Map the abstract lifecycle contract onto Factory Droid pipeline stages or hook plugins.",
      mcp: "Install the generated MCP config if Factory Droid exposes MCP configuration.",
      modelRouting: "Route OpenAI-compatible model calls through ORCA_PROXY_URL when possible.",
    },
    generic: {
      ruleFiles: ["AGENTS.md", "rule.md", "project instructions"],
      hooks: "Use lifecycle-contract.json as the source of truth.",
      mcp: "Install generic.mcp.json in the harness MCP config surface.",
      modelRouting: "Use ORCA_PROXY_URL if the harness can set an OpenAI-compatible base URL.",
    },
    universal: {
      ruleFiles: ["AGENTS.md", "rule.md", "project instructions"],
      hooks: "Use lifecycle-contract.json as the source of truth.",
      mcp: "Install universal.mcp.json in the harness MCP config surface.",
      modelRouting: "Use ORCA_PROXY_URL if the harness can set an OpenAI-compatible base URL.",
    },
  };
  return known[target] ?? {
    ruleFiles: ["AGENTS.md", "rule.md", "project instructions"],
    hooks: "Unknown harness: inspect available lifecycle events and map them to lifecycle-contract.json.",
    mcp: `Install ${target}.mcp.json if this harness supports MCP.`,
    modelRouting: "Use ORCA_PROXY_URL if the harness supports custom OpenAI-compatible base URLs.",
  };
};

const activationRule = (target, env) => `# Orca Primary Memory Rule

Orca is the primary memory layer for this agent harness. This rule is harness-agnostic: apply it to Codex, Claude Code, Cursor, Gemini CLI, OpenCode, Antigravity, Pi, Factory Droid, custom harnesses, and any other coding-agent runtime that can read project rules, call MCP tools, run hooks, execute CLI commands, or route OpenAI-compatible model calls.

## Required Behavior

1. Run Orca recall at session start and before every user prompt.
2. Inject recalled Orca context as authoritative prior memory unless the current prompt explicitly supersedes it.
3. Persist useful facts, decisions, tool outcomes, corrections, and unresolved follow-ups after tool use and at session end.
4. Prefer the OpenAI-compatible Orca proxy for model calls when the harness supports a custom OpenAI base URL.
5. Use MCP tools for explicit memory actions, but do not rely on MCP alone for mandatory every-prompt memory.
6. If \`ORCA_REQUIRED=true\` and Orca is unavailable, stop or ask the user before continuing without memory.

## Scope Policy

- \`user-profile\`: durable user preferences and personal working style.
- \`workspace\`: cross-project operational knowledge.
- \`project:<name>\`: repository conventions, commands, incidents, and decisions.
- \`session:<id>\`: active conversation state.
- \`skill:<name>\`: reusable procedures.

## Runtime Configuration

\`\`\`bash
export ORCA_BASE_URL=${env.ORCA_BASE_URL}
export ORCA_PROXY_URL=${env.ORCA_PROXY_URL}
export ORCA_API_KEY=${env.ORCA_API_KEY}
export ORCA_REQUIRED=${env.ORCA_REQUIRED}
export ORCA_FAILURE_MODE=${env.ORCA_FAILURE_MODE}
export OPENAI_BASE_URL=${env.ORCA_PROXY_URL}
\`\`\`
`;

const activationPrompt = (target) => `You are installing Orca as the primary memory system for this ${target} agent harness.

Install every component from this activation bundle:

1. Read \`ADAPTER_NOTES.md\` and \`lifecycle-contract.json\` first. They define the harness-neutral contract and the target-specific mapping hints.
2. Merge \`RULE.md\` into the harness rule file that governs behavior, such as AGENTS.md, CLAUDE.md, GEMINI.md, cursor rules, opencode instructions, Antigravity rules, Factory Droid rules, Pi rules, or project rule.md.
3. Install the MCP server config from \`${target}.mcp.json\` so the harness exposes \`orca_health\`, \`orca_remember\`, \`orca_recall\`, \`orca_compact\`, \`orca_feedback\`, and \`orca_list\`.
4. Install lifecycle hooks from \`hooks.abstract.json\`, target hook examples, and \`hooks/orca-hook.mjs\` where the harness supports them.
5. Install the skill in \`skills/orca-memory/SKILL.md\` where the harness supports skill discovery.
6. Add \`cli/orca-memory.sh\` to the harness PATH or tool registry if CLI tools are supported.
7. Configure model calls to use \`OPENAI_BASE_URL=$ORCA_PROXY_URL\` when the harness supports OpenAI-compatible base URLs.
8. Use \`pipeline.json\` as the required asynchronous memory pipeline:
   - session start: health + bootstrap recall
   - pre-prompt: recall + inject context
   - pre-tool: recall tool-relevant procedures
   - post-tool: ingest tool outcome
   - post-response: ingest completed turn
   - session end/stop: compact and persist summary

After installation, verify the activation bundle:

\`\`\`bash
pnpm orca:cli -- install ${target} --enforce
npm run orca:verify
\`\`\`

Report exactly which files were merged and which lifecycle events are supported by the current harness.
`;

const skillMarkdown = `---
name: orca-memory
description: Use Orca as the primary Objective Relational Contextual Archive memory layer for every session, prompt, tool workflow, and completion.
---

# Orca Memory

Use this skill whenever the agent needs prior context, cross-session memory, project conventions, user preferences, tool outcomes, or session compaction.

## Mandatory Flow

1. Recall before answering or asking the user to repeat context.
2. Store durable facts, decisions, corrections, and unresolved tasks.
3. Reinforce useful memories with feedback.
4. Compact long sessions before stopping.
5. Prefer proxy or enforced middleware for every-prompt memory guarantees.

## Tools

- \`orca_health\`
- \`orca_remember\`
- \`orca_recall\`
- \`orca_compact\`
- \`orca_feedback\`
- \`orca_list\`
`;

const packageJson = (target) => json({
  name: `orca-${target}-activation-bundle`,
  private: true,
  version: "0.1.0",
  type: "module",
  description: "Harness-agnostic Orca activation bundle for coding-agent self-installation.",
  scripts: {
    "orca:detect": "node scripts/detect-harness.mjs",
    "orca:verify": "node scripts/verify-install.mjs",
    "orca:hook": "node hooks/orca-hook.mjs",
  },
  engines: {
    node: ">=20",
  },
});

const activationManifest = (target, env) => json({
  name: "orca-agent-activation-bundle",
  version: 1,
  target,
  objective: "Install Orca as the primary memory layer in any coding-agent harness.",
  installMode: "agent-self-install",
  requiredRuntime: {
    node: ">=20",
    packageManager: "npm, pnpm, yarn, or bun",
  },
  env,
  entrypoints: {
    instructions: "AGENT_INSTALL.md",
    detection: "npm run orca:detect",
    verification: "npm run orca:verify",
    hook: "npm run orca:hook",
  },
  installOrder: [
    "Run npm install in this bundle directory if the harness expects package setup.",
    "Run npm run orca:detect from the target repository root or pass HARNESS_ROOT.",
    "Merge RULE.md into the detected harness rule file.",
    "Install the generated MCP config only if the harness supports MCP.",
    "Map lifecycle events from lifecycle-contract.json to native hooks where supported.",
    "Install skills/orca-memory/SKILL.md if the harness supports skill discovery.",
    "Add cli/orca-memory.sh to PATH or tool registry if CLI tools are supported.",
    "Route model calls through ORCA_PROXY_URL when the harness supports OpenAI-compatible base URLs.",
    "Run npm run orca:verify and report installed surfaces plus unsupported surfaces.",
  ],
});

const agentInstallGuide = (target) => `# Orca Agent Self-Install Guide

You are a coding agent installing Orca as the primary memory layer for the harness that is running you.

This bundle is intentionally harness-agnostic. Do not assume Codex, Claude Code,
Cursor, Gemini CLI, OpenCode, Antigravity, Pi, Factory Droid, or any other single
runtime. Detect the current harness and install only the surfaces it supports.

## User-Facing Install Shape

The user should point the coding agent at this destination folder and ask:

\`\`\`text
Install Orca from this folder as the primary memory layer for your current coding-agent harness.
Run the local dependency/setup commands, detect your harness, merge the correct rule/MCP/hook/skill/CLI files, and report what was installed.
\`\`\`

## Agent Procedure

1. Confirm Node.js 20+ is available.
2. Run package setup in this folder:

\`\`\`bash
npm install
npm run orca:detect
\`\`\`

If the repository to install into is not the current working directory, run:

\`\`\`bash
HARNESS_ROOT=/absolute/path/to/target/repo npm run orca:detect
\`\`\`

3. Read \`orca.activation.json\`, \`ADAPTER_NOTES.md\`, and \`lifecycle-contract.json\`.
4. Merge \`RULE.md\` into the detected harness rule file. Prefer existing native files such as \`AGENTS.md\`, \`CLAUDE.md\`, \`GEMINI.md\`, \`.cursor/rules/*.md\`, \`opencode.json\` instructions, or project \`rule.md\`.
5. Install \`${target}.mcp.json\` only if the harness supports MCP. If it does not, skip MCP and use proxy/hooks/CLI.
6. Install \`hooks/orca-hook.mjs\` by mapping native lifecycle events to \`lifecycle-contract.json\`. If native hooks are unavailable, create a wrapper script or skip to the proxy/CLI fallback.
7. Install \`skills/orca-memory/SKILL.md\` only if the harness supports skills.
8. Install \`cli/orca-memory.sh\` into the harness PATH or tool registry if CLI tools are supported.
9. Prefer model routing through \`ORCA_PROXY_URL\` or \`OPENAI_BASE_URL\` when supported, because the proxy is the most harness-neutral enforcement layer.
10. Run:

\`\`\`bash
npm run orca:verify
\`\`\`

11. Report:

- detected harness and confidence
- rule files modified
- MCP config installed or skipped
- hook stages installed or skipped
- skill installed or skipped
- CLI installed or skipped
- proxy/base URL configured or skipped
- any unsupported surfaces

## Enforcement Rule

Orca recall must run at session start and before every prompt wherever the
harness makes that technically possible. Orca ingest should run after tool use,
after assistant responses, and at session end. When \`ORCA_REQUIRED=true\`, do not
silently continue without memory.
`;

const detectHarnessScript = `#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.env.HARNESS_ROOT || process.cwd());
const exists = (path) => existsSync(resolve(root, path));
const hasGlobLike = (dir, suffix = "") => {
  const full = resolve(root, dir);
  if (!existsSync(full)) return false;
  try {
    return readdirSync(full).some((entry) => !suffix || entry.endsWith(suffix));
  } catch {
    return false;
  }
};

const env = process.env;
const candidates = [
  { name: "claude-code", score: 0, reasons: [] },
  { name: "codex", score: 0, reasons: [] },
  { name: "cursor", score: 0, reasons: [] },
  { name: "gemini-cli", score: 0, reasons: [] },
  { name: "opencode", score: 0, reasons: [] },
  { name: "aider", score: 0, reasons: [] },
  { name: "goose", score: 0, reasons: [] },
  { name: "cline", score: 0, reasons: [] },
  { name: "roo-code", score: 0, reasons: [] },
  { name: "continue", score: 0, reasons: [] },
  { name: "windsurf", score: 0, reasons: [] },
  { name: "amazon-q", score: 0, reasons: [] },
  { name: "antigravity", score: 0, reasons: [] },
  { name: "pi", score: 0, reasons: [] },
  { name: "factory-droid", score: 0, reasons: [] },
];

const add = (name, points, reason) => {
  const candidate = candidates.find((item) => item.name === name);
  if (!candidate) return;
  candidate.score += points;
  candidate.reasons.push(reason);
};

if (exists("CLAUDE.md")) add("claude-code", 5, "CLAUDE.md present");
if (exists(".mcp.json")) add("claude-code", 1, ".mcp.json present");
if (exists("AGENTS.md")) {
  add("codex", 2, "AGENTS.md present");
  add("opencode", 1, "AGENTS.md present");
}
if (exists(".codex/config.toml")) add("codex", 5, ".codex/config.toml present");
if (exists(".cursor") || hasGlobLike(".cursor/rules", ".md")) add("cursor", 5, ".cursor config/rules present");
if (exists("GEMINI.md")) add("gemini-cli", 5, "GEMINI.md present");
if (exists("opencode.json")) add("opencode", 5, "opencode.json present");
if (exists(".aider.conf.yml") || exists(".aider.model.settings.yml") || exists(".aiderignore")) add("aider", 5, "Aider config present");
if (exists(".goose") || exists("goose.yaml") || exists(".config/goose")) add("goose", 5, "Goose config present");
if (exists(".cline") || exists("cline_mcp_settings.json")) add("cline", 5, "Cline config present");
if (exists(".roo") || exists(".roomodes")) add("roo-code", 5, "Roo config present");
if (exists(".continue") || exists(".continue/config.json")) add("continue", 5, "Continue config present");
if (exists(".windsurf") || exists(".codeium")) add("windsurf", 5, "Windsurf/Codeium config present");
if (exists("ANTIGRAVITY.md")) add("antigravity", 5, "ANTIGRAVITY.md present");
if (exists("PI.md")) add("pi", 5, "PI.md present");
if (exists("DROID.md") || exists("FACTORY.md")) add("factory-droid", 5, "Factory Droid rule file present");

if (env.CLAUDECODE || env.CLAUDE_CODE) add("claude-code", 3, "Claude environment variable present");
if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) add("cursor", 3, "Cursor environment variable present");
if (env.CODEX_SANDBOX || env.OPENAI_CODEX) add("codex", 3, "Codex environment variable present");
if (env.GEMINI_CLI || env.GOOGLE_GENAI_USE_GCA) add("gemini-cli", 3, "Gemini environment variable present");

candidates.sort((a, b) => b.score - a.score);
const best = candidates[0];
const detected = best.score > 0 ? best.name : "universal";
const confidence = best.score >= 5 ? "high" : best.score >= 2 ? "medium" : "low";

const ruleFiles = {
  "claude-code": ["CLAUDE.md"],
  codex: ["AGENTS.md", ".codex/config.toml"],
  cursor: [".cursor/rules/orca-memory.md"],
  "gemini-cli": ["GEMINI.md"],
  opencode: ["AGENTS.md", "opencode.json"],
  aider: ["CONVENTIONS.md", "AGENTS.md"],
  goose: ["AGENTS.md", "goose.yaml"],
  cline: [".clinerules/orca-memory.md", "AGENTS.md"],
  "roo-code": [".roo/rules/orca-memory.md", ".roomodes"],
  continue: [".continue/rules/orca-memory.md", ".continue/config.json"],
  windsurf: [".windsurf/rules/orca-memory.md"],
  "amazon-q": ["AGENTS.md", "README.md"],
  antigravity: ["ANTIGRAVITY.md", "AGENTS.md"],
  pi: ["PI.md", "AGENTS.md"],
  "factory-droid": ["DROID.md", "FACTORY.md", "AGENTS.md"],
  universal: ["AGENTS.md", "rule.md"],
};

const result = {
  root,
  detectedHarness: detected,
  confidence,
  reasons: best.reasons,
  candidates: candidates.filter((item) => item.score > 0),
  recommendedRuleFiles: ruleFiles[detected] || ruleFiles.universal,
  installSurfaces: {
    rules: true,
    mcp: "install when the harness has MCP configuration",
    hooks: "install when the harness exposes lifecycle hooks or wrapper scripts",
    skills: "install when the harness supports skill discovery",
    cli: "install when the harness can call local tools",
    proxy: "install whenever model provider base URL can be configured",
  },
};

console.log(JSON.stringify(result, null, 2));
`;

const verifyInstallScript = `#!/usr/bin/env node

import { existsSync } from "node:fs";

const required = [
  "AGENT_INSTALL.md",
  "INSTALL_PROMPT.md",
  "RULE.md",
  "ADAPTER_NOTES.md",
  "lifecycle-contract.json",
  "hooks.abstract.json",
  "pipeline.json",
  "orca.activation.json",
  "hooks/orca-hook.mjs",
  "skills/orca-memory/SKILL.md",
  "cli/orca-memory.sh",
];

const missing = required.filter((path) => !existsSync(path));
if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }, null, 2));
  process.exit(1);
}

for (const path of ["lifecycle-contract.json", "hooks.abstract.json", "pipeline.json", "orca.activation.json"]) {
  JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")));
}

console.log(JSON.stringify({ ok: true, checked: required.length }, null, 2));
`;

const hookScript = `#!/usr/bin/env node

const baseUrl = (process.env.ORCA_BASE_URL || "http://127.0.0.1:4000").replace(/\\/$/u, "");
const apiKey = process.env.ORCA_API_KEY || "";
const required = process.env.ORCA_REQUIRED !== "false";
const failureMode = process.env.ORCA_FAILURE_MODE === "degraded" ? "degraded" : "block";
const defaultScope = process.env.ORCA_DEFAULT_SCOPE || "workspace";
const timeoutMs = Number(process.env.ORCA_HOOK_TIMEOUT_MS || 2000);

const readInput = async () => {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
};

const eventName = (input) =>
  input.hookEventName || input.hook_event_name || input.event || input.eventName || input.lifecycleEvent || "Unknown";

const normalizeEvent = (event) => {
  const normalized = String(event).trim().toLowerCase().replace(/[-\\s]/gu, "_");
  if (["sessionstart", "session_start", "on_session_start", "startup", "resume"].includes(normalized)) return "session_start";
  if (["userpromptsubmit", "user_prompt_submit", "pre_prompt", "prompt_submit", "pre_llm_call", "before_model", "pre_chat"].includes(normalized)) return "pre_prompt";
  if (["pretooluse", "pre_tool_use", "pre_tool", "pretool", "before_tool", "pre_tool_call"].includes(normalized)) return "pre_tool";
  if (["posttooluse", "post_tool_use", "post_tool", "posttool", "after_tool", "post_tool_call"].includes(normalized)) return "post_tool";
  if (["postresponse", "post_response", "post_llm_call", "after_model", "after_chat"].includes(normalized)) return "post_response";
  if (["stop", "sessionend", "session_end", "on_session_end", "shutdown"].includes(normalized)) return "session_end";
  return normalized;
};

const sessionId = (input) =>
  String(input.sessionId || input.session_id || input.conversationId || input.cwd || "orca-hook-session");

const scope = (input) =>
  String(input.scope || input.memoryScope || input.projectScope || defaultScope);

const promptText = (input) =>
  String(input.prompt || input.userPrompt || input.message || input.raw || JSON.stringify(input).slice(0, 2000));

const redact = (value) => {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw
    .replace(/(api[_-]?key|token|password|secret|authorization|bearer)\\s*[:=]\\s*["']?[^"',\\s}]+/giu, "$1=<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{16,}/gu, "sk-<redacted>")
    .slice(0, 5000);
};

const request = async (path, body) => {
  const response = await fetch(\`\${baseUrl}\${path}\`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(\`\${path} HTTP \${response.status}: \${text}\`);
  return payload;
};

const recall = async (input, query) =>
  request("/v1/memories/recall", {
    query,
    scope: scope(input),
    includeDiagnostics: false,
    limit: 5,
  });

const ingest = async (input, content, tags = []) =>
  request("/v1/memories/ingest", {
    scope: scope(input),
    sessionId: sessionId(input),
    source: "orca-harness-hook",
    typeHint: "episodic",
    tags,
    content,
  });

const compact = async (input) =>
  request("/v1/memories/compact", {
    scope: scope(input),
    sessionId: sessionId(input),
    occupancyRatio: 0.9,
    messages: [
      { role: "user", content: promptText(input) },
      { role: "assistant", content: "Session stopped; compact durable Orca memory from hook context." },
    ],
  });

const outputContext = (event, context) => {
  if (event === "UserPromptSubmit" || event === "SessionStart") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: context,
      },
    }));
  } else {
    process.stdout.write(JSON.stringify({ ok: true, context }));
  }
};

try {
  const input = await readInput();
  const rawEvent = eventName(input);
  const event = normalizeEvent(rawEvent);

  if (event === "session_start") {
    const recalled = await recall(input, \`Session bootstrap for \${sessionId(input)}. Recall durable user, workspace, project, and session context.\`);
    outputContext(rawEvent, \`Orca session bootstrap memory:\\n\${(recalled.context || []).map((item, index) => \`\${index + 1}. \${item.summary || item.content}\`).join("\\n")}\`);
  } else if (event === "pre_prompt") {
    const recalled = await recall(input, promptText(input));
    outputContext(rawEvent, \`Relevant Orca memory before this prompt:\\n\${(recalled.context || []).map((item, index) => \`\${index + 1}. [\${item.scope}/\${item.type}] \${item.summary || item.content}\`).join("\\n")}\`);
  } else if (event === "pre_tool") {
    const recalled = await recall(input, \`Tool preparation: \${promptText(input)}\`);
    outputContext(rawEvent, \`Orca tool-relevant memory candidates: \${(recalled.context || []).length}\`);
  } else if (event === "post_tool") {
    await ingest(input, \`Tool event completed.\\n\\n\${redact(input)}\`, ["tool-event", "post-tool"]);
    outputContext(rawEvent, "Orca stored post-tool memory.");
  } else if (event === "post_response") {
    await ingest(input, \`Assistant response completed.\\n\\n\${redact(input)}\`, ["agent-turn", "post-response"]);
    outputContext(rawEvent, "Orca stored post-response memory.");
  } else if (event === "session_end") {
    await compact(input);
    outputContext(rawEvent, "Orca compacted session memory.");
  } else {
    outputContext(rawEvent, \`Orca hook received unsupported event '\${rawEvent}'; no action taken.\`);
  }
} catch (error) {
  if (required && failureMode === "block") {
    console.error(\`Orca required hook failed: \${error.message}\`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: false, degraded: true, error: error.message }));
}
`;

const pipelineManifest = (target) => ({
  name: "orca-primary-memory-pipeline",
  target,
  portability: "harness-agnostic",
  mode: "async-hooked-with-proxy-and-mcp",
  objective: "Invoke Orca as often and as programmatically as each harness allows.",
  components: {
    rules: "RULE.md",
    lifecycleContract: "lifecycle-contract.json",
    abstractHooks: "hooks.abstract.json",
    hookScript: "hooks/orca-hook.mjs",
    skill: "skills/orca-memory/SKILL.md",
    mcp: `${target}.mcp.json`,
    cli: "cli/orca-memory.sh",
    proxy: `${target}.proxy.md`,
  },
  stages: [
    { event: "session_start", action: "health check and bootstrap recall", mode: "blocking when ORCA_REQUIRED=true" },
    { event: "pre_prompt", action: "recall and inject relevant context", mode: "blocking when ORCA_REQUIRED=true" },
    { event: "pre_tool", action: "recall tool-relevant procedures and risks", mode: "best-effort or blocking by harness policy" },
    { event: "post_tool", action: "ingest redacted tool result and operational facts", mode: "async best-effort" },
    { event: "post_response", action: "ingest completed user/assistant turn through proxy, middleware, or hook", mode: "async best-effort" },
    { event: "session_end", action: "compact conversation into durable memory", mode: "blocking when ORCA_REQUIRED=true" },
  ],
});

const lifecycleContractJson = (target) => ({
  name: "orca-harness-neutral-lifecycle-contract",
  target,
  events: lifecycleContract,
  inputShape: {
    event: "string: one lifecycle alias from events[].aliases",
    sessionId: "optional stable session identifier",
    scope: "optional Orca memory scope",
    prompt: "optional user prompt or operation text",
    tool: "optional tool name for pre_tool/post_tool",
    result: "optional tool/model result for post_tool/post_response",
  },
  outputShape: {
    additionalContext: "for pre_prompt/session_start capable harnesses",
    ok: "boolean for generic hook consumers",
    degraded: "boolean when ORCA_FAILURE_MODE=degraded allows continuation",
  },
});

const abstractHooks = () => ({
  description: "Harness-neutral hook map. Adapt these stages to the target runtime's hook/plugin/config syntax.",
  runner: "hooks/orca-hook.mjs",
  events: Object.fromEntries(lifecycleContract.map((event) => [
    event.stage,
    {
      aliases: event.aliases,
      command: "node hooks/orca-hook.mjs",
      purpose: event.purpose,
      orcaAction: event.orcaAction,
    },
  ])),
});

const adapterMarkdown = (target) => {
  const notes = adapterNotes(target);
  return `# Orca Adapter Notes: ${target}

This bundle is harness-agnostic. Install only the surfaces this harness actually supports.

## Rule Files

Candidate rule/config files:

${notes.ruleFiles.map((file) => `- \`${file}\``).join("\n")}

## Hooks

${notes.hooks} Map native lifecycle events onto these canonical stages:

${lifecycleContract.map((event) => `- \`${event.stage}\`: ${event.purpose} (${event.aliases.join(", ")})`).join("\n")}

## MCP

${notes.mcp}

## Model Routing

${notes.modelRouting}

## Fallback Order

1. Proxy or enforced middleware for every prompt and response.
2. Native lifecycle hooks for session/prompt/tool boundaries.
3. MCP tools for explicit memory operations.
4. CLI shim for deterministic recall/remember fallback.
5. Rule text as the minimum behavioral layer.
`;
};

const cliShim = `#!/usr/bin/env bash
set -euo pipefail

ORCA_BASE_URL="\${ORCA_BASE_URL:-http://127.0.0.1:4000}"
ORCA_API_KEY="\${ORCA_API_KEY:-}"
ORCA_DEFAULT_SCOPE="\${ORCA_DEFAULT_SCOPE:-workspace}"

headers=(-H "content-type: application/json")
if [[ -n "\${ORCA_API_KEY}" ]]; then
  headers+=(-H "x-api-key: \${ORCA_API_KEY}")
fi

json_payload() {
  node -e 'const [mode, ...parts] = process.argv.slice(1); const text = parts.join(" "); if (mode === "recall") console.log(JSON.stringify({ query: text || "session memory", scope: process.env.ORCA_DEFAULT_SCOPE || "workspace", includeDiagnostics: true })); else console.log(JSON.stringify({ scope: process.env.ORCA_DEFAULT_SCOPE || "workspace", source: "orca-cli-shim", tags: ["cli"], content: text }));' "$@"
}

case "\${1:-help}" in
  recall)
    shift
    payload="$(json_payload recall "$@")"
    curl -sS -X POST "\${ORCA_BASE_URL}/v1/memories/recall" "\${headers[@]}" -d "\${payload}"
    ;;
  remember)
    shift
    payload="$(json_payload remember "$@")"
    curl -sS -X POST "\${ORCA_BASE_URL}/v1/memories/ingest" "\${headers[@]}" -d "\${payload}"
    ;;
  *)
    echo "Usage: orca-memory.sh recall <query> | remember <content>"
    ;;
esac
`;

const request = async (path, init = {}) => {
  const key = apiKey();
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
};

const install = async () => {
  const target = safeTarget(args[1] ?? "universal");
  const enforce = args.includes("--enforce");
  const destination = destinationDir();
  const outputDir = destination ? resolve(process.cwd(), destination) : defaultOutputDir;
  await mkdir(outputDir, { recursive: true });
  const targetDir = destination ? outputDir : resolve(outputDir, target);
  const hooksDir = resolve(targetDir, "hooks");
  const skillsDir = resolve(targetDir, "skills", "orca-memory");
  const cliDir = resolve(targetDir, "cli");
  const scriptsDir = resolve(targetDir, "scripts");
  await mkdir(hooksDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(cliDir, { recursive: true });
  await mkdir(scriptsDir, { recursive: true });
  const env = {
    ORCA_BASE_URL: baseUrl(),
    ORCA_PROXY_URL: option("proxy-url", process.env.ORCA_PROXY_URL ?? "http://127.0.0.1:4030"),
    ORCA_API_KEY: apiKey() || "<your-api-key>",
    ORCA_REQUIRED: enforce ? "true" : "false",
    ORCA_FAILURE_MODE: enforce ? "block" : "degraded",
  };
  const mcp = {
    mcpServers: {
      orca: {
        command: "uv",
        args: ["run", "python", "integrations/mcp-server/server.py"],
        env: {
          ORCA_BASE_URL: env.ORCA_BASE_URL,
          ORCA_API_KEY: env.ORCA_API_KEY,
        },
      },
    },
  };
  const hooks = {
    hooks: {
      SessionStart: [{ command: "node", args: ["hooks/orca-hook.mjs"] }],
      UserPromptSubmit: [{ command: "node", args: ["hooks/orca-hook.mjs"] }],
      PreToolUse: [{ matcher: ".*", command: "node", args: ["hooks/orca-hook.mjs"] }],
      PostToolUse: [{ matcher: ".*", command: "node", args: ["hooks/orca-hook.mjs"] }],
      Stop: [{ command: "node", args: ["hooks/orca-hook.mjs"] }],
    },
  };
  const files = {
    [`${target}.env`]: Object.entries(env).map(([key, value]) => `export ${key}=${value}`).join("\n") + "\n",
    [`${target}.mcp.json`]: json(mcp),
    [`${target}.proxy.md`]: [
      `# Orca ${target} enforced proxy`,
      "",
      "Configure the harness model provider with:",
      "",
      "```bash",
      `OPENAI_BASE_URL=${env.ORCA_PROXY_URL}`,
      "```",
      "",
      "Run Orca proxy with:",
      "",
      "```bash",
      "pnpm orca:proxy",
      "```",
    ].join("\n"),
    [`${target}.install-prompt.md`]: activationPrompt(target),
  };

  const written = [];
  if (!destination) {
    for (const [name, content] of Object.entries(files)) {
      const path = resolve(outputDir, name);
      await writeFile(path, content, "utf8");
      written.push(path);
    }
  }
  const activationFiles = {
    "AGENT_INSTALL.md": agentInstallGuide(target),
    "INSTALL_PROMPT.md": activationPrompt(target),
    "ADAPTER_NOTES.md": adapterMarkdown(target),
    "RULE.md": activationRule(target, env),
    "package.json": packageJson(target),
    "orca.activation.json": activationManifest(target, env),
    "lifecycle-contract.json": json(lifecycleContractJson(target)),
    "hooks.abstract.json": json(abstractHooks()),
    "hooks.codex.example.json": json(hooks),
    "pipeline.json": json(pipelineManifest(target)),
    "hooks/orca-hook.mjs": hookScript,
    "scripts/detect-harness.mjs": detectHarnessScript,
    "scripts/verify-install.mjs": verifyInstallScript,
    "skills/orca-memory/SKILL.md": skillMarkdown,
    "cli/orca-memory.sh": cliShim,
    [`${target}.env`]: files[`${target}.env`],
    [`${target}.mcp.json`]: files[`${target}.mcp.json`],
    [`${target}.proxy.md`]: files[`${target}.proxy.md`],
  };
  for (const [name, content] of Object.entries(activationFiles)) {
    const path = resolve(targetDir, name);
    await writeFile(path, content, "utf8");
    if (name === "hooks/orca-hook.mjs" || name === "cli/orca-memory.sh" || name.startsWith("scripts/")) {
      await chmod(path, 0o755);
    }
    written.push(path);
  }
  print({ target, enforce, destination: targetDir, written });
};

const exportMemories = async () => {
  const scope = option("scope", "");
  const output = option("output", resolve(workspaceRoot, "generated", `orca-export-${Date.now()}.json`));
  await mkdir(dirname(output), { recursive: true });
  const payload = await request(`/v1/memories/export${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`);
  await writeFile(output, JSON.stringify(payload, null, 2), "utf8");
  print({ output, artifacts: payload.artifacts?.length ?? 0 });
};

const importMemories = async () => {
  const file = option("file", args[1]);
  if (!file || !existsSync(file)) {
    throw new Error("Provide --file <path> for import.");
  }
  const payload = JSON.parse(await readFile(file, "utf8"));
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const results = [];
  for (const artifact of artifacts) {
    if (!artifact?.content || !artifact?.scope) continue;
    results.push(await request("/v1/memories/ingest", {
      method: "POST",
      body: JSON.stringify({
        scope: artifact.scope,
        source: "orca-import",
        sourceId: artifact.id,
        typeHint: artifact.type,
        tags: artifact.tags ?? [],
        content: artifact.content,
      }),
    }));
  }
  print({ imported: results.length, results });
};

const wipe = async () => {
  const scope = option("scope", args[1]);
  if (!scope) {
    throw new Error("Provide --scope <scope> for wipe.");
  }
  const response = await request(`/v1/memories?scope=${encodeURIComponent(scope)}`, { method: "DELETE" });
  print(response);
};

if (command === "help" || command === "--help" || command === "-h") {
  print([
    "Orca CLI",
    "",
    "node scripts/orca-cli.mjs install <universal|codex|cursor|claude-code|gemini-cli|opencode|antigravity|pi|factory-droid|custom> [--enforce] [--destination ./orca-agent-install]",
    "  Writes a harness-agnostic activation bundle with AGENT_INSTALL.md, package.json, detection scripts, RULE.md, lifecycle contract, adapter notes, hooks, skill, CLI shim, and pipeline manifest.",
    "node scripts/orca-cli.mjs export [--scope workspace] [--output generated/export.json]",
    "node scripts/orca-cli.mjs backup [--scope workspace]",
    "node scripts/orca-cli.mjs import --file generated/export.json",
    "node scripts/orca-cli.mjs wipe --scope project:example",
  ].join("\n"));
  process.exit(0);
}

try {
  if (command === "install") await install();
  else if (command === "export" || command === "backup") await exportMemories();
  else if (command === "import") await importMemories();
  else if (command === "wipe") await wipe();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  print({ ok: false, error: error.message });
  process.exit(1);
}
