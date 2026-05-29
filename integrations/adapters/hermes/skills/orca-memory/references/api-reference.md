# Orca API Reference

Complete endpoint reference for the Memory API (port 4000) and Worker (port 4010).

## Memory API (localhost:4000)

### GET /health
Health check for the memory API.
```bash
curl http://127.0.0.1:4000/health
```
**Response:** `{"service":"memory-api","status":"ok","timestamp":"2026-...","memory":{...}}`

### GET /v1/memories
List all memories, optionally filtered by scope.
```bash
curl "http://127.0.0.1:4000/v1/memories?scope=workspace"
```
**Response:** `{"memories": [...]}`

### POST /v1/memories/ingest
Store a new memory.
```json
{
  "scope": "user-profile | project:<name> | skill:<name> | workspace | session:<id>",
  "source": "who/what created this",
  "tags": ["categorical", "tags"],
  "content": "The memory content — fact, decision, pattern, or event"
}
```
**Response:** `{"artifactId":"...", "status":"accepted"}` (202)

### POST /v1/memories/recall
Semantic + graph search across all memory layers.
```json
{
  "query": "Natural language search query",
  "scope": "optional scope filter or null",
  "includeDiagnostics": true | false
}
```
**Response:**
```json
{
  "query": "...",
  "context": [
    {
      "id": "...",
      "type": "semantic | episodic | procedural",
      "scope": "...",
      "content": "Full memory content",
      "summary": "Concise summary",
      "confidence": 0.68,
      "tags": ["..."],
      "provenance": {"source": "...", "observedAt": "..."},
      "linkedArtifactIds": ["..."],
      "salience": 0.70,
      "reinforcementCount": 0,
      "lastAccessedAt": "..."
    }
  ],
  "candidates": [
    {
      "artifactId": "...",
      "score": 0.34,
      "source": "vector | working",
      "reasoning": "vector=0.45, graph=0, working=0.12, reinforcement=0"
    }
  ],
  "diagnostics": {
    "storesQueried": ["working-memory", "semantic-store", "graph-store"],
    "reranked": true,
    "totalCandidates": 3,
    "queryEntities": [],
    "appliedScope": "workspace",
    "elapsedMs": 27
  }
}
```

### POST /v1/memories/feedback
Reinforce or demote a memory.
```json
{
  "artifactId": "<id-from-recall-or-ingest>",
  "useful": true | false
}
```
**Response:** `{"updated":true,"artifactId":"..."}` (200) or `{"updated":false}` (404)

### POST /v1/memories/compact
Compact a conversation window into durable episodic/semantic/procedural memory.
```json
{
  "scope": "workspace",
  "occupancyRatio": 0.74,
  "sessionId": "session-abc",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```
**Response:**
```json
{
  "triggered": true,
  "occupancyRatio": 0.74,
  "workingSummary": "Concise summary of what mattered",
  "openLoops": ["Unresolved item 1"],
  "promoted": [
    {"type": "semantic", "artifactId": "...", "content": "..."},
    {"type": "procedural", "artifactId": "...", "content": "..."},
    {"type": "episodic", "artifactId": "...", "content": "..."}
  ]
}
```

### GET /v1/workflows/runs
Recent workflow execution history.
```bash
curl http://127.0.0.1:4000/v1/workflows/runs
```

### GET /v1/metrics/modules
Memory module health and usage metrics.
```bash
curl http://127.0.0.1:4000/v1/metrics/modules
```

### GET /metrics
Prometheus-format metrics.
```bash
curl http://127.0.0.1:4000/metrics
```

## Worker API (localhost:4010)

### GET /health
```bash
curl http://127.0.0.1:4010/health
```

### POST /workflows/reindex
Trigger a reindex workflow.
```bash
curl -X POST http://127.0.0.1:4010/workflows/reindex
```

### GET /workflows/definitions
Available workflow definitions.
```bash
curl http://127.0.0.1:4010/workflows/definitions
```

### GET /workflows/runs
Workflow execution history.
```bash
curl http://127.0.0.1:4010/workflows/runs
```

### GET /metrics/modules
Worker module metrics.
```bash
curl http://127.0.0.1:4010/metrics/modules
```

### GET /metrics
Prometheus-format metrics.
```bash
curl http://127.0.0.1:4010/metrics
```

### POST /workflows/execute
Execute a specified workflow.
```json
{
  "workflow": "reindex | cleanup | consolidate",
  "params": {}
}
```
