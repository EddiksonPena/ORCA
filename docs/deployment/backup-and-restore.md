# Backup And Restore

## Goal

This runbook defines the minimum backup and restore expectations for a production-grade `Orca` deployment.

The system’s durable state spans:

- `Redis` for shared state and working-memory recency
- `PostgreSQL` for `Temporal` persistence
- `Weaviate` for semantic memory
- `Neo4j` for graph memory

`Orca` application pods are stateless in the deployment reference and do not require direct filesystem backup for core memory state.

## Baseline Policy

Recommended minimum baseline:

- hourly logical backups for `Temporal PostgreSQL`
- hourly or more frequent persistence snapshots for `Redis`
- daily durable backups for `Neo4j`
- daily durable backups for `Weaviate`
- backup retention long enough to cover operator error, bad deploys, and silent corruption windows
- quarterly restore drills in a staging or recovery namespace

## Redis

What matters:

- shared state key:
  `orca:state:v1`
- recent working-memory lists and cache-style recency state

Recommended approach:

- enable AOF or RDB persistence
- snapshot the persistent volume or export `dump.rdb`
- ship backups to object storage

Restore outline:

1. Stop app writes or scale `memory-api` and `worker` down.
2. Restore the Redis volume or import the snapshot into a replacement Redis pod.
3. Verify that `orca:state:v1` exists.
4. Scale the app layer back up.
5. Run a recall verification and verify `/health` on both services.

## Temporal PostgreSQL

What matters:

- workflow persistence for `Temporal`
- workflow history and execution durability

Recommended approach:

- run regular `pg_dump` backups plus storage snapshots
- test point-in-time recovery if your database platform supports it

Restore outline:

1. Restore the `Temporal PostgreSQL` database into a new or cleaned instance.
2. Bring `temporal-frontend` up against the restored database.
3. Verify `Temporal` health and namespace access.
4. Start or restart the `worker` deployment.
5. Confirm workflow execution and `/workflows/definitions`.

## Weaviate

What matters:

- semantic chunk objects
- embeddings and metadata

Recommended approach:

- use the Weaviate backup API with an object storage backend when available
- supplement with volume snapshots if required by your platform

Restore outline:

1. Restore the Weaviate data volume or backup API snapshot.
2. Wait for `/v1/.well-known/ready`.
3. Run a recall verification on a known semantic memory.
4. If needed, trigger `POST /workflows/reindex` to rebuild dependent derived state.

## Neo4j

What matters:

- graph nodes and edges
- episodic temporal link projections

Recommended approach:

- use `neo4j-admin database dump` or your managed backup facility
- store dumps in encrypted object storage

Restore outline:

1. Restore the Neo4j database from a dump or platform snapshot.
2. Verify Bolt connectivity.
3. Run a graph-sensitive recall query.
4. Trigger reindex or episodic timeline rebuild workflows if graph projections need refreshing.

## Full Recovery Sequence

If you need a full stack restore:

1. Restore `Redis`.
2. Restore `Temporal PostgreSQL`.
3. Restore `Weaviate`.
4. Restore `Neo4j`.
5. Bring up `Temporal`.
6. Bring up `memory-api` and `worker`.
7. Run verification checks:
   - `GET /health`
   - `GET /metrics`
   - authenticated `POST /v1/memories/recall`
   - `GET /workflows/definitions`
8. If any store-specific derived state appears stale, run `POST /workflows/reindex`.

## Verification Checklist

After restore, verify:

- both app deployments are healthy
- `Temporal` is reachable and workers are polling
- Redis-backed shared state is readable
- a known memory can be recalled
- metrics scrape still works
- no authentication failures are caused by missing secrets

## Repo References

- Kubernetes backup examples:
  [`deploy/k8s/platform/backup-cronjobs.example.yaml`](../../deploy/k8s/platform/backup-cronjobs.example.yaml)
- Full deployment reference:
  [`deploy/k8s/README.md`](../../deploy/k8s/README.md)
