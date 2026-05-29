# MVP Roadmap

## Objective

Deliver a usable memory operating system MVP that can ingest agent interactions, store structured memory across multiple substrates, retrieve context through a hybrid orchestration layer, and improve behavior through feedback and background maintenance.

## Success Criteria

- An agent can call one API to ingest and recall memory.
- Ingested content is routed into the right stores with provenance and scope metadata.
- Retrieval combines vector, sparse, and graph strategies into one ranked context package.
- Background workflows can reprocess, consolidate, and evaluate memory without blocking the request path.
- The full stack runs locally through Docker Compose.

## Non-Goals For MVP

- full autonomous memory curation
- complex trust arbitration across conflicting facts
- multimodal ingestion
- distributed multi-node synchronization
- enterprise-grade secret management

## Phase 0: Foundation

### Goal

Create the platform skeleton, local runtime, shared schemas, and explicit system boundaries.

### Deliverables

- repository layout for apps, packages, infra, and docs
- `docker-compose.yml` for Redis, Weaviate, Neo4j, Temporal, Prometheus, and Grafana
- shared config module with environment-driven settings
- shared schemas for memory records, retrieval requests, and workflow payloads
- health and readiness contract for each service

### Exit Criteria

- every dependency starts locally with persistent volumes
- the API process can validate config and connect to all services
- the worker process can register Temporal workflows

## Phase 1: Ingestion MVP

### Goal

Turn raw inputs into structured memory with enough metadata to support future retrieval and lifecycle management.

### Scope

- structure-aware chunking with overlap
- metadata enrichment
- embedding generation
- entity and relation extraction
- deduplication heuristics
- routing to Redis, Weaviate, and Neo4j

### Deliverables

- `POST /v1/memories/ingest`
- chunking pipeline module
- embedding adapter abstraction
- extraction adapter abstraction
- write paths for:
  - working memory in Redis
  - semantic memory in Weaviate
  - graph memory in Neo4j
- provenance model on every memory artifact

### Exit Criteria

- a single ingest request produces linked records in all intended stores
- duplicate inputs are detected or flagged
- ingestion emits traces, metrics, and structured logs

## Phase 2: Retrieval MVP

### Goal

Return the right context for the agent by combining multiple retrieval strategies under one orchestrator.

### Scope

- query intent and scope analysis
- dense retrieval from Weaviate
- sparse retrieval through hybrid search or keyword indexing
- graph expansion from Neo4j
- fusion and reranking
- context packaging for downstream agents

### Deliverables

- `POST /v1/memories/recall`
- retrieval plan object explaining which stores were queried
- fusion strategy for combining heterogeneous results
- reranker integration
- response payload with:
  - selected context
  - provenance
  - confidence
  - retrieval diagnostics

### Exit Criteria

- recall can answer using more than one substrate in a single request
- the orchestrator can constrain retrieval by scope, recency, and memory type
- top-ranked context is materially better than vector-only baseline in sample evaluations

## Phase 3: Background Control Plane

### Goal

Move maintenance and improvement loops into durable workflows.

### Scope

- re-embedding jobs
- graph consolidation
- periodic deduplication
- retrieval evaluation runs
- failure-aware retryable workflows

### Deliverables

- Temporal workflows and activities for each background job
- workflow status visibility in logs and metrics
- replay-safe task payloads
- scheduler for periodic evaluation and cleanup jobs

### Exit Criteria

- API remains responsive while maintenance jobs run asynchronously
- failed jobs can be retried without corrupting memory state
- model version changes can trigger controlled reprocessing

## Phase 4: Lifecycle And Feedback

### Goal

Make memory adaptive instead of purely accumulative.

### Scope

- salience scoring
- reinforcement when memories are selected and useful
- decay over time
- compression or summarization for stale clusters
- archival rules

### Deliverables

- `POST /v1/memories/feedback`
- lifecycle scoring model
- memory state transitions: active, compressed, archived
- summarization path for low-value clusters

### Exit Criteria

- retrieval feedback changes future ranking inputs
- stale memory can be compacted without losing provenance
- archival rules are transparent and reversible

## Phase 5: Hardening

### Goal

Prepare the MVP for external adopters and deeper experimentation.

### Scope

- benchmark datasets and evaluation scripts
- failure-mode testing
- resource profiling on local hardware
- API examples for single-agent and multi-agent harnesses
- deployment and operational documentation

### Deliverables

- example harness integrations
- benchmark report template
- dashboard pack for latency, recall, workflow health, and storage growth
- getting-started guide

### Exit Criteria

- a new developer can run the system locally and exercise ingest and recall within one hour
- performance and retrieval quality are measurable and repeatable
- the MVP has clear extension points for new stores and models

## Workstreams

### Platform

- repo structure
- config system
- service composition
- local developer experience

### Memory Modeling

- canonical schemas
- memory identity
- provenance and confidence representation
- scope model

### Ingestion

- chunking
- enrichment
- extraction
- routing

### Retrieval

- query planning
- hybrid search
- fusion
- reranking
- packaging

### Workflow Automation

- Temporal workflows
- retry semantics
- scheduling

### Observability

- tracing
- metrics
- logs
- dashboards

## Suggested Sprint Order

### Sprint 1

- finalize schemas
- finalize API contract
- bring up Docker Compose
- wire health checks

### Sprint 2

- build ingest endpoint
- implement embeddings and write paths
- add provenance and scope metadata

### Sprint 3

- build recall endpoint
- implement fusion and reranking
- return packaged context

### Sprint 4

- add Temporal workflows
- add evaluation jobs
- add deduplication and re-embedding jobs

### Sprint 5

- add feedback and salience
- add compression and archival basics
- harden dashboards and docs

## Critical Early Decisions

- choose the primary implementation language
- choose the API protocol and response shape
- define immutable event versus mutable memory record semantics
- define scope hierarchy and access boundaries
- define model versioning and migration policy

## Recommendation

Build the first end-to-end slice as:

1. ingest plain text with metadata
2. embed and write to Weaviate
3. extract entities and write to Neo4j
4. write active context pointer to Redis
5. recall from all stores
6. rerank and return a compact context package

That slice proves the architecture before lifecycle and governance sophistication are added.
