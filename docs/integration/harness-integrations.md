# Harness integrations (OpenAI, LangGraph-style, CrewAI-style)

Orca exposes a **plain HTTP** Memory API. Agent frameworks differ, but the integration pattern is always the same:

1. **Recall** before you call the model (`POST /v1/memories/recall`).
2. Inject the returned `context[]` into your prompt or tool output.
3. **Ingest** notable outcomes after each turn or task (`POST /v1/memories/ingest`).
4. Optionally **compact** long threads (`POST /v1/memories/compact`) when context pressure grows.

If Orca must be used on every session and every prompt, prefer the enforced middleware or OpenAI-compatible proxy in [enforced memory integration](enforced-memory.md). The examples below are manual HTTP patterns for harnesses where you control the request flow.

Operational helpers are available through:

```bash
pnpm orca:cli -- install universal --enforce --destination ./orca-agent-install
pnpm orca:cli -- install codex --enforce
pnpm orca:cli -- export --scope workspace
pnpm orca:cli -- wipe --scope project:demo
```

The install command emits `AGENT_INSTALL.md`, `INSTALL_PROMPT.md`,
`ADAPTER_NOTES.md`, `RULE.md`, `package.json`, npm detection/verification scripts,
`lifecycle-contract.json`, `hooks.abstract.json`, MCP config, a skill, a CLI
shim, and `pipeline.json`. Point the target coding agent at the destination
folder and ask it to run `npm install`, `npm run orca:detect`, then merge only
the files/events it actually supports. Targets can be known harnesses such as
Codex, Claude Code, Cursor, Gemini CLI, OpenCode, Antigravity, Pi, Factory
Droid, or any custom identifier for a private harness.

Set `ORCA_BASE_URL`, `ORCA_API_KEY`, and send `x-api-key` on every non-health call (unless `ORCA_AUTH_MODE=none` locally).

---

## Minimal HTTP helper (TypeScript)

```typescript
const base = process.env.ORCA_BASE_URL ?? "http://127.0.0.1:4000";
const key = process.env.ORCA_API_KEY ?? "";

const headers = {
  "content-type": "application/json",
  ...(key ? { "x-api-key": key } : {}),
} as Record<string, string>;

export async function recallForAgent(query: string, scope: string) {
  const res = await fetch(`${base}/v1/memories/recall`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      scope,
      includeDiagnostics: true,
      limit: 8,
    }),
  });
  if (!res.ok) throw new Error(`recall ${res.status}`);
  return res.json() as Promise<{
    context: { id: string; content: string; summary?: string }[];
  }>;
}

export async function ingestFromAgent(input: {
  scope: string;
  source: string;
  content: string;
  tags?: string[];
}) {
  const res = await fetch(`${base}/v1/memories/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      scope: input.scope,
      source: input.source,
      tags: input.tags ?? [],
      content: input.content,
    }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
  return res.json();
}
```

Compose `context[].content` (and optional `summary`) into a single `system` or `user` block prefixed with something like: *“Relevant prior memory (Orca)”*.

---

## OpenAI Responses / Chat Completions

**Pattern:** one extra system message before the user turn.

```typescript
// npm install openai
import OpenAI from "openai";
import { recallForAgent, ingestFromAgent } from "./orca.js";

const openai = new OpenAI();
const scope = "workspace";

export async function reply(userText: string) {
  const recalled = await recallForAgent(userText, scope);
  const memoryBlock =
    recalled.context.length === 0
      ? ""
      : `Prior memory (structured recall):\n${recalled.context.map((c) => c.summary ?? c.content).join("\n---\n")}`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    messages: [
      ...(memoryBlock
        ? [{ role: "system" as const, content: memoryBlock }]
        : []),
      { role: "user", content: userText },
    ],
  });

  const answer = completion.choices[0]?.message?.content ?? "";

  await ingestFromAgent({
    scope,
    source: "openai-bridge",
    tags: ["assistant-turn"],
    content: `User: ${userText}\nAssistant: ${answer}`,
  });

  return answer;
}
```

For **tool-calling** flows, run `recallForAgent` inside the tool dispatcher (or once per user message) instead of only at the top level.

---

## LangGraph-style graphs

Model a **state** object with `{ messages, scope }` and add a node that prepends memory:

```text
fetch_memory → llm_call → (optional tools) → persist_memory
```

- **`fetch_memory` node:** `POST /v1/memories/recall` using the latest user utterance (or a synthesized query from state).
- **`llm_call` node:** Your usual LLM step; pass recalled text as `system` content.
- **`persist_memory` node:** `POST /v1/memories/ingest` with the final assistant message or a distilled summary (smaller payloads ingest faster and dedupe better).

When the graph’s token estimate crosses your window policy, insert a **`compact` node** that calls `POST /v1/memories/compact` with `messages` + `occupancyRatio`, then replace the sliding window with the returned `workingSummary`.

LangGraph specifics (checkpointing, `Send`, etc.) are orthogonal—this API stays side-effect oriented.

---

## CrewAI-style crews and tools

Wrap Orca calls as **tools** or **before/after callbacks**:

| Hook | Orca endpoint |
|------|---------------------|
| Before `AgentExecutor` kicks off | `/v1/memories/recall` with task description as `query` |
| After task completes | `/v1/memories/ingest` with consolidated task output |
| Long collaboration loop | `/v1/memories/compact` nightly or when `occupancyRatio` spikes |

Expose two Python functions (`recall_tasks`, `memorize_tasks`) that mirror the TypeScript `fetch` body shapes from [`packages/schemas/src/index.ts`](../../packages/schemas/src/index.ts) (`RecallMemoryRequest`, `IngestMemoryRequest`).

---

## Scope and tenancy tips

- Use **`workspace`** until you introduce real multi-tenant identity; migrate to finer scopes (`session`, `agent`, `user`) when callers carry stable IDs.
- Keep **`source`** unique per harness (`openai-sales-bot`, `crew-research-lead`) to simplify provenance audits.
- Pass **`sessionId`** on ingest/recall when your framework exposes a durable session identifier—it tightens retrieval for episodic overlaps.

---

## Further reading

- [Setup and usage](../setup/setup-and-usage.md)
- [System overview](../architecture/system-overview.md)
- Generated snippets after bootstrap: [`generated/harness/orca-harness-config.md`](../../generated/harness/orca-harness-config.md) (created when you run the bootstrap CLI)
- Type definitions: [`packages/schemas/src/index.ts`](../../packages/schemas/src/index.ts)
