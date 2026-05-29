---
name: orca-memory
category: mlops
description: Extend Hermes' memory with Orca — a multi-modal memory OS (Redis/Weaviate/Neo4j). Provides semantic recall, graph relationships, episodic memory, adaptive compaction, and feedback-driven reinforcement. Use when the flat memory tool is insufficient, or when cross-session learning is needed.
---

# orca-memory

Orca gives Hermes a true memory operating system — not just flat key-value facts, but semantic search, entity graphs, episodic recall, and automated lifecycle management across Redis (working), Weaviate (semantic), and Neo4j (graph).

## Trigger Conditions

**Use when:**
- Current session context is large and needs compaction
- User references something from "a while ago" that keyword search won't find
- A session produced important decisions/procedures that should persist
- The flat `memory` tool is at capacity or can't express relationships
- Cross-project patterns are emerging (e.g., "user always picks this palette")
- Session ending — compact conversation into durable memory

**Do NOT use when:**
- Storing a single quick fact under 500 chars → use `memory` tool
- The user hasn't set up Orca yet → guide them through setup first
- Orca health check fails → diagnose before using

## Architecture

```
Agent (Hermes)
    │
    ├─ memory tool        ← flat facts, ≤5KB, exact match
    ├─ session_search     ← full-text past sessions
    └─ Orca API     ← semantic + graph + episodic
         │
         ├─ POST /v1/memories/ingest    (store fact/decision/event)
         ├─ POST /v1/memories/recall     (semantic + graph search)
         ├─ POST /v1/memories/feedback   (reinforce/demote)
         ├─ POST /v1/memories/compact    (session → durable memory)
         └─ GET  /v1/metrics/modules     (memory health)
```

## Pre-flight Health Check

```bash
curl -s http://127.0.0.1:4000/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('status')=='ok' else 'FAIL: '+str(d))"
```

Expected: `{"service":"memory-api","status":"ok","timestamp":"..."}`

If it fails:
```bash
cd ~/projects/orca
docker compose ps                          # infrastructure up?
docker compose up -d                       # start if down
pnpm --filter @orca/memory-api dev & # start API
pnpm --filter @orca/worker dev &     # start worker
```

## Operations

### Ingest Memory

Store facts, decisions, patterns, and discoveries:

```bash
curl -s -X POST http://127.0.0.1:4000/v1/memories/ingest \
  -H 'content-type: application/json' \
  -d '{
    "scope": "<scope>",
    "source": "<source>",
    "tags": ["<tag1>", "<tag2>"],
    "content": "<the fact or discovery>"
  }'
```

**scope conventions:**
- `user-profile` — who the user is, preferences, communication style
- `project:<name>` — project-specific conventions and decisions
- `skill:<name>` — skill-related patterns and pitfalls
- `workspace` — general environment facts
- `session:<id>` — ephemeral session context

**When to ingest:**
- User corrects you → ingest the corrected approach
- New convention discovered → ingest with rationale
- Important decision made → ingest with why
- Bug fix pattern identified → ingest the resolution
- New tool installed/configured → ingest the setup

### Recall Memory

Semantic search across all memory layers:

```bash
curl -s -X POST http://127.0.0.1:4000/v1/memories/recall \
  -H 'content-type: application/json' \
  -d '{
    "query": "<natural language query>",
    "scope": "<scope or null>",
    "includeDiagnostics": true
  }'
```

**When to recall:**
- Session start → load all user profile + relevant project context
- User mentions something familiar → search before asking them to repeat
- Starting work on project X → recall its conventions
- Debugging → search for similar past issues

**Response shape:**
```json
{
  "results": [
    {
      "artifactId": "...",
      "content": "...",
      "score": 0.92,
      "metadata": {"scope": "...", "source": "...", "tags": [...]}
    }
  ],
  "diagnostics": {
    "sources": ["weaviate", "redis", "neo4j"],
    "totalCandidates": 12,
    "rerankedCount": 5
  }
}
```

### Provide Feedback

Reinforce useful memories, demote noise:

```bash
curl -s -X POST http://127.0.0.1:4000/v1/memories/feedback \
  -H 'content-type: application/json' \
  -d '{
    "artifactId": "<artifact-id>",
    "useful": true
  }'
```

**When:** After a recall, confirm whether the retrieved context was actually helpful. This builds a reinforcement signal.

### Compact Session

Turn a long conversation into durable episodic/semantic/procedural memory:

```bash
curl -s -X POST http://127.0.0.1:4000/v1/memories/compact \
  -H 'content-type: application/json' \
  -d '{
    "scope": "workspace",
    "occupancyRatio": <0.0-1.0>,
    "sessionId": "<session-id>",
    "messages": [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "..."}
    ]
  }'
```

**When:**
- Session ending → compact key moments
- Context window filling (>70%) → compact mid-session
- Important milestone reached → compact the phase

**Response:**
```json
{
  "triggered": true,
  "occupancyRatio": 0.74,
  "workingSummary": "...",
  "openLoops": ["..."],
  "promoted": [
    {"type": "semantic", "artifactId": "...", "content": "..."},
    {"type": "procedural", "artifactId": "...", "content": "..."}
  ]
}
```

### Inspect Memory Health

```bash
curl -s http://127.0.0.1:4000/v1/metrics/modules | python3 -m json.tool
```

## Preferred Integration Path (MCP + Code Execution)

Orca now has a native MCP server at `~/projects/orca-mcp-server/`. Combined with `mcp-code-execution`, this is the **recommended path** — it eliminates the 98.7% context bloat of loading tool definitions and round-tripping raw results through the model.

### One-time setup:
```bash
cd ~/projects/orca-mcp-server
# Wrappers regenerate if Orca adds new tools:
uv run python generate_mcp_wrappers.py \
  --server orca \
  --transport stdio \
  --command "uv" \
  --args '["run", "--directory", ".", "python", "server.py"]'
```

### From within Hermes (via execute_code):
```python
from mcp_servers.orca import (
    orca_recall_sync, orca_remember_sync,
    orca_compact_sync, orca_feedback_sync,
    orca_health_sync
)

# Session start — bootstrap context (results processed in code, not context)
ctx = orca_recall_sync("user preferences", scope="user-profile")
print(json.dumps({"preferences": ctx["context"][:2]}, indent=2))

# Store discoveries
orca_remember_sync("workspace", "New pattern: ...",
                         source="hermes-agent", tags=["pattern"])

# Session end — compact
result = orca_compact_sync("session-abc", messages)
print(f"Compacted: {result['triggered']}, promoted {len(result['promoted'])}")
```

### Fallback: Direct HTTP API (when MCP server is unavailable):
Use the curl commands documented below. Load `references/api-reference.md` for full details.

## Session Lifecycle Pattern

```
SESSION START
  → orca_recall("user preferences", scope="user-profile")
  → orca_recall("<current project>", scope="project:<name>")
  → orca_recall("<relevant skill>", scope="skill:<name>")

DURING SESSION
  → orca_remember(corrections)      # user corrects something
  → orca_remember(decisions)        # important decision made
  → orca_remember(patterns)         # new pattern discovered
  → orca_compact(mid-session)       # if context pressure >70%

SESSION END
  → orca_compact(full-session)      # derive durable memories
  → orca_feedback(recall-results)   # rate what was useful
```

## When to Use Which Memory Tool

| Situation | Tool |
|-----------|------|
| Quick fact, <500 chars, exact lookup later | `memory` |
| Keyword search past conversations | `session_search` |
| Conceptual search ("things like X") | Orca `recall` |
| Entity relationships ("what relates to X?") | Orca `recall` |
| Cross-session learning | Orca full lifecycle |
| Session compaction | Orca `compact` |
| Reusable procedure identified | Create a `skill` + Orca `ingest` |

## Setup Reference

See `references/setup.md` for the full installation guide.

Quick start:
```bash
git clone https://github.com/EddiksonPena/Orca.git ~/projects/orca
cd ~/projects/orca
pnpm install
cp .env.example .env
docker compose up -d
pnpm --filter @orca/memory-api dev &
pnpm --filter @orca/worker dev &
curl http://127.0.0.1:4000/health
```

## Reference Files

| File | Contents |
|------|----------|
| `references/setup.md` | Full installation and configuration guide |
| `references/api-reference.md` | Complete API endpoint reference |
| `references/integration-patterns.md` | When/how to integrate with Hermes tools |
| `references/pitfalls.md` | Common failures and recovery |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/healthcheck.sh` | Verify Orca is healthy before using |
