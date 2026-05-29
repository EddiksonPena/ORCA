# Setup and Usage

## Overview

This guide explains how to set up `Orca`, launch the local stack, and exercise the system end to end.

## Prerequisites

- `Node.js` 22+
- `pnpm`
- `Docker` with `docker compose`

## Install

```bash
pnpm install
```

To prefetch the default product embedding model outside Docker, run:

```bash
pnpm orca:warm-embeddings
```

The default embedding runtime is local/private:
`onnx-community/Qwen3-Embedding-0.6B-ONNX` with `EMBEDDING_DTYPE=q8`. Docker
Compose warms this model during app image builds unless
`WARM_EMBEDDING_MODEL=false` is set.

## Configure

Copy the sample environment file:

```bash
cp .env.example .env
```

Set `ORCA_API_KEY` before calling non-health endpoints, or run
`pnpm orca:init` to generate one during bootstrap.

Defaults are designed for local development:

- API: `127.0.0.1:4000`
- Worker: `127.0.0.1:4010`
- Embeddings: quantized Qwen via Transformers.js
- Redis: `127.0.0.1:6380`
- Weaviate: `127.0.0.1:8080`
- Neo4j HTTP: `127.0.0.1:7474`
- Neo4j Bolt: `127.0.0.1:7687`

### Optional Ollama Cloud embeddings

Use Ollama Cloud when you prefer managed embedding inference:

```bash
EMBEDDING_PROVIDER=ollama
OLLAMA_HOST=https://ollama.com
OLLAMA_API_KEY=<your-ollama-api-key>
EMBEDDING_MODEL=qwen3-embedding:4b
EMBEDDING_DIMENSIONS=2560
```

Use `qwen3-embedding:8b` for quality-first deployments when latency and cost are
acceptable. Keep the model and dimensions stable after indexing memory.

## Start Infrastructure

```bash
docker compose up -d
```

Check container status:

```bash
docker compose ps
```

## Start Services

Use two terminals:

```bash
pnpm --filter @orca/memory-api dev
pnpm --filter @orca/worker dev
```

## Verify Health

```bash
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4010/health
```

Export your API key for the request examples:

```bash
export ORCA_API_KEY="$(grep '^ORCA_API_KEY=' .env | cut -d= -f2-)"
```

## Fully Containerized App Stack

To run the API and worker in Docker as well:

```bash
cp .env.production.example .env
# Set ORCA_API_KEY and replace production placeholders first.
docker compose --profile app up -d --build
```

The app image build warms `onnx-community/Qwen3-Embedding-0.6B-ONNX` with
`EMBEDDING_DTYPE=q8` by default. Set `WARM_EMBEDDING_MODEL=false` to skip
Transformers model warmup, or set `EMBEDDING_PROVIDER=ollama` to use local
Ollama or Ollama Cloud.

## Ingest

```bash
curl -X POST http://127.0.0.1:4000/v1/memories/ingest \
  -H 'content-type: application/json' \
  -H "x-api-key: ${ORCA_API_KEY:?set ORCA_API_KEY from .env}" \
  -d '{
    "scope": "workspace",
    "source": "setup-guide",
    "tags": ["docs", "demo"],
    "content": "UAT Suite Memory OS scenario. The Retrieval Orchestrator uses Redis for working memory, Weaviate for semantic search, and Neo4j for graph reasoning."
  }'
```

Expected outcome:

- a root memory artifact is created
- a chunk artifact is created
- the chunk is mirrored into `Weaviate`
- recent IDs are pushed to `Redis`
- entities and relationships are written into `Neo4j`

## Recall

```bash
curl -X POST http://127.0.0.1:4000/v1/memories/recall \
  -H 'content-type: application/json' \
  -H "x-api-key: ${ORCA_API_KEY:?set ORCA_API_KEY from .env}" \
  -d '{
    "query": "What does the Retrieval Orchestrator use for working memory and graph reasoning?",
    "scope": "workspace",
    "includeDiagnostics": true
  }'
```

Expected outcome:

- relevant context is returned
- diagnostics report `working-memory`, `semantic-store`, and `graph-store`
- ranking reflects lexical, semantic, graph, and working-memory signals

## Feedback

```bash
curl -X POST http://127.0.0.1:4000/v1/memories/feedback \
  -H 'content-type: application/json' \
  -H "x-api-key: ${ORCA_API_KEY:?set ORCA_API_KEY from .env}" \
  -d '{
    "artifactId": "<artifact-id>",
    "useful": true
  }'
```

## Reindex

```bash
curl -X POST http://127.0.0.1:4010/workflows/reindex \
  -H "x-api-key: ${ORCA_API_KEY:?set ORCA_API_KEY from .env}"
```

Expected outcome:

- graph state is rebuilt from persisted artifacts
- Weaviate is refreshed from current chunks
- counts increase in health output when new data exists

## Direct Store Checks

### Redis

```bash
redis-cli -p 6380 --raw LRANGE memory:recent:workspace:episodic 0 10
```

### Weaviate

```bash
curl -H 'content-type: application/json' http://127.0.0.1:8080/v1/graphql \
  -d '{"query":"{ Get { OrcaEpisodicChunk(limit: 5) { artifactId scope content } } }"}'
```

### Neo4j

```bash
docker exec orca-knowledge-graph-store-1 cypher-shell -u neo4j -p orca \
  'MATCH (e:Entity) RETURN e.name LIMIT 10;'
```

## Browser Usage

For local browser checks, prefer:

- `http://127.0.0.1:4000/health`
- `http://127.0.0.1:4000/v1/memories`

Using `127.0.0.1` is more reliable than `localhost` on this machine because the UAT run showed Safari connectivity differences between the two.
