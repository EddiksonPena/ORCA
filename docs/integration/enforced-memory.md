# Enforced Memory Integration

Orca should be wired as mandatory harness middleware when it must run on every session and every prompt. MCP tools are still useful, but tool availability alone does not guarantee that an agent will call memory.

## Recommended Modes

### Middleware Mode

Use this when you control the agent runtime.

```ts
import { EnforcedMemoryHarness } from "@orca/harness";

const memory = new EnforcedMemoryHarness({
  required: true,
  failureMode: "block",
  defaultScope: "workspace",
});

const before = await memory.beforePrompt({
  sessionId,
  prompt: userPrompt,
  messages,
});

const response = await agent.run(before.messages);

await memory.afterResponse({
  sessionId,
  prompt: userPrompt,
  response: response.text,
});
```

The middleware performs recall before the model call, injects an Orca memory block into the message list, and ingests the completed turn after the response.

### OpenAI-Compatible Proxy Mode

Use this when the harness can point at an OpenAI-compatible base URL but cannot be modified internally.

```bash
export ORCA_BASE_URL=http://127.0.0.1:4000
export ORCA_PROXY_URL=http://127.0.0.1:4030
export ORCA_REQUIRED=true
export ORCA_FAILURE_MODE=block
export ORCA_PROXY_UPSTREAM_BASE_URL=https://api.openai.com
export OPENAI_API_KEY=<provider-key>

pnpm orca:proxy
```

Then configure the harness model provider base URL as:

```bash
OPENAI_BASE_URL=http://127.0.0.1:4030
```

Every `POST /v1/chat/completions` call is intercepted, recalled against Orca, forwarded upstream, then persisted back into Orca. The proxy supports both normal JSON responses and OpenAI-style Server-Sent Events when the request includes `stream: true`.

Proxy metrics are exposed at:

```bash
curl http://127.0.0.1:4030/metrics
```

Current counters include requests, upstream requests, recall success/failure,
streaming requests, ingest success/failure, injected-memory count, blocked
requests, and degraded requests.

Control memory injection budget with:

```bash
ORCA_PROXY_MEMORY_BLOCK_MAX_CHARS=6000
ORCA_PROXY_MAX_REQUEST_BYTES=1048576
```

### MCP Mode

Use MCP for explicit memory operations:

- `orca_remember`
- `orca_recall`
- `orca_compact`
- `orca_feedback`
- `orca_list`
- `orca_health`

MCP should be paired with middleware or proxy mode when memory must be mandatory.

## Failure Policy

Use strict mode when Orca is the primary memory module:

```bash
ORCA_REQUIRED=true
ORCA_FAILURE_MODE=block
```

Use degraded mode when local development should continue while memory is unavailable:

```bash
ORCA_REQUIRED=true
ORCA_FAILURE_MODE=degraded
```

## Session Scope

Use stable scopes for predictable recall:

- `user-profile` for durable user preferences
- `workspace` for repository-wide facts
- `project:<id>` for project-specific context
- `session:<id>` for active conversation continuity
- `skill:<id>` for reusable workflow memory

The enforced harness recalls across bootstrap scopes plus the active session scope before every prompt.

## Install Bundle Generation

Generate a harness-specific activation bundle:

```bash
pnpm orca:cli -- install universal --enforce --destination ./orca-agent-install
pnpm orca:cli -- install codex --enforce
pnpm orca:cli -- install cursor --enforce
pnpm orca:cli -- install claude-code --enforce
pnpm orca:cli -- install opencode --enforce
pnpm orca:cli -- install gemini-cli --enforce
pnpm orca:cli -- install antigravity --enforce
pnpm orca:cli -- install pi --enforce
pnpm orca:cli -- install factory-droid --enforce
```

Each target bundle is written under `generated/harness/<target>/` by default, or
directly into the folder passed to `--destination`. For agent self-install,
point the coding agent at the destination folder and ask it to run `npm install`,
`npm run orca:detect`, and `npm run orca:verify`. Bundles include:

- `AGENT_INSTALL.md` for harness-agnostic self-install instructions.
- `INSTALL_PROMPT.md` for asking the target agent to merge the bundle into its own config surface.
- `ADAPTER_NOTES.md` for target-specific installation guidance and fallback order.
- `RULE.md` for the harness governing rule file.
- `package.json`, `scripts/detect-harness.mjs`, and `scripts/verify-install.mjs` for npm-compatible setup, runtime detection, and installation verification.
- `lifecycle-contract.json`, `hooks.abstract.json`, and `hooks/orca-hook.mjs` for lifecycle recall, ingest, and compaction.
- `hooks.codex.example.json` as an example adapter for Codex-style command hooks.
- `skills/orca-memory/SKILL.md` for skill-capable harnesses.
- `<target>.mcp.json` for the Orca MCP bridge.
- `cli/orca-memory.sh` for CLI-capable harnesses.
- `pipeline.json` describing the asynchronous primary-memory workflow.

The generated pipeline is intentionally layered and harness-agnostic: rules set
behavioral policy, lifecycle contracts map native events to Orca stages, hooks
invoke memory where supported, MCP exposes explicit memory tools, the skill
teaches when to use them, the CLI gives deterministic fallback access, and the
proxy/middleware captures full model turns.
