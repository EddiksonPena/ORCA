# Orca Setup Guide

Full installation and configuration for Orca memory OS.

## Prerequisites

- **Node.js** 22+ (we have 25.9.0 ✓)
- **pnpm** (installed globally ✓)
- **Docker** with `docker compose` (installed, needs group membership)

## Installation

### 1. Clone

```bash
git clone https://github.com/EddiksonPena/Orca.git ~/projects/orca
cd ~/projects/orca
```

### 2. Install Dependencies

```bash
pnpm install
# Approve builds if prompted:
pnpm approve-builds
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Default ports (all localhost):
- Memory API: `4000`
- Worker: `4010`
- Redis: `6380` (offset to avoid host Redis on 6379)
- Weaviate: `8080`
- Neo4j HTTP: `7474`, Bolt: `7687`
- Temporal: `7233`
- Grafana: `3001`
- Prometheus: `9090`

### 4. Fix Docker Permissions (if needed)

```bash
# Run from a real terminal (not through Hermes):
sudo usermod -aG docker $USER
# Then log out and back in
```

Verify:
```bash
docker ps
```

### 5. Start Infrastructure

```bash
docker compose up -d
```

Wait for all services:
```bash
docker compose ps
# All should show "healthy" or "running"
```

Services started:
- Redis (port 6380)
- Weaviate (port 8080)
- Neo4j (ports 7474, 7687)
- Temporal + PostgreSQL (port 7233)
- OpenTelemetry Collector (port 4318)
- Prometheus (port 9090)
- Grafana (port 3001)

### 6. Start Orca Services

In separate terminals:

```bash
pnpm --filter @orca/memory-api dev
pnpm --filter @orca/worker dev
```

### 7. Verify

```bash
curl http://127.0.0.1:4000/health
# Expected: {"service":"memory-api","status":"ok","timestamp":"..."}

curl http://127.0.0.1:4010/health
# Expected: {"service":"worker","status":"ok","timestamp":"..."}
```

### 8. Smoke Test

```bash
# Ingest a test memory
curl -s -X POST http://127.0.0.1:4000/v1/memories/ingest \
  -H 'content-type: application/json' \
  -d '{
    "scope": "workspace",
    "source": "setup-test",
    "tags": ["test"],
    "content": "Orca is running on port 4000 and the worker is on 4010."
  }'

# Recall it
curl -s -X POST http://127.0.0.1:4000/v1/memories/recall \
  -H 'content-type: application/json' \
  -d '{
    "query": "What port is Orca running on?",
    "scope": "workspace"
  }' | python3 -m json.tool
```

## Teardown

```bash
docker compose down           # stop but keep data volumes
docker compose down -v        # stop and remove volumes (fresh start)
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Docker permission denied | `sudo usermod -aG docker $USER` + re-login |
| Port conflicts | Change ports in .env |
| Weaviate fails to start | Check Docker memory allocation |
| Neo4j password wrong | Check NEO4J_PASSWORD in .env |
| No embeddings generated | Ensure nomic-embed-text pullable |
| Worker can't connect to Temporal | Wait for Temporal to finish booting (~30s) |
