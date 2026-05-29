# System Overview

## Vision

`Orca` is a memory operating system for agent ecosystems.

It is not only a database and not only a retrieval pipeline. It is a control plane that decides:

- what to store
- how to structure it
- when to reinforce or forget it
- how to retrieve it for a given agent, task, and scope

## Architectural Model

The system is split into a control plane and a data plane.

### Control Plane

Responsible for policy, orchestration, and lifecycle behavior.

- Memory API
- Ingestion Pipeline
- Retrieval Orchestrator
- Lifecycle Manager
- Governance Layer
- Temporal background workflows

The lifecycle manager is responsible for adaptive compaction and promotion:

- monitor context pressure
- compact oversized conversation windows
- derive episodic, semantic, and procedural candidates
- promote only high-value memories into long-term modules
- keep working context small and task-focused

### Data Plane

Responsible for concrete storage and retrieval primitives.

- Redis for working memory and fast context state
- Weaviate for semantic and hybrid retrieval
- Neo4j for entities, relations, and temporal graph structure

## Request Flow

### Ingestion

1. Agent or harness sends raw input to the Memory API.
2. The ingestion pipeline normalizes and chunks content.
3. Metadata, provenance, and scope are attached.
4. Embeddings and extracted entities are generated.
5. Memory artifacts are routed to the right stores.
6. A memory event is emitted for background maintenance.

### Recall

1. Agent sends a query and optional scope constraints.
2. The retrieval orchestrator analyzes intent.
3. The orchestrator queries the relevant stores.
4. Results are fused and reranked.
5. The system assembles a context package with provenance and confidence.
6. The agent receives only the most relevant context.

### Adaptive Compaction

1. The system estimates context pressure from occupancy or token-window usage.
2. When pressure crosses a threshold, Orca creates a compaction plan.
3. The planner derives:
   - episodic candidates for what happened
   - semantic candidates for stable facts and constraints
   - procedural candidates for repeatable steps and workflows
4. Candidates above module-specific thresholds are promoted into the appropriate memory modules.
5. The system returns a compact working summary plus unresolved open loops for the active context.

## Core Memory Types

### Working Memory

Short-lived, high-priority context used to support active execution.

Primary substrate: Redis.

Orca now treats working memory as explicitly compactable rather than infinitely accumulating.

### Episodic Memory

Events, interactions, and time-bound experiences.

Primary substrate: Neo4j with temporal modeling and optional vector linkage.

### Semantic Memory

Facts, concepts, summaries, and abstractions that support general recall.

Primary substrate: Weaviate with metadata-rich objects and embeddings.

### Procedural Memory

Tool usage traces, workflows, and reusable execution patterns.

Primary substrate: mixed representation across graph and semantic stores.

## Adaptive Lifecycle Heuristics

The current implementation uses simple, explainable heuristics:

- occupancy threshold trigger, defaulting around `70%`
- fact-like pattern detection for semantic promotion
- step-like pattern detection for procedural promotion
- event and conversation stitching for episodic promotion
- open-loop extraction to preserve unresolved work during compaction

This is intentionally heuristic-first so the lifecycle manager is observable and tunable before introducing learned policies.

## Principles

### Local-First

The full system should run on a developer machine through containers and local model runtimes.

### Modular

Every major dependency should be replaceable behind narrow interfaces.

### Observability-First

Retrieval quality and system behavior must be inspectable, not guessed.

### Progressive Disclosure

Agents should receive enough context to act well, but not raw memory dumps.

### Event-Oriented

Background workflows should derive improvements from memory events rather than blocking front-door requests.

## Proposed Runtime Components

### API Service

- exposes ingest, recall, update, and feedback endpoints
- validates requests
- delegates heavy work to the control plane modules

### Worker Service

- runs Temporal workers
- executes asynchronous maintenance jobs
- performs batch evaluation and consolidation

### Local Model Runtime Layer

- embedding adapter
- reranker adapter
- extraction and summarization adapter

### Observability Stack

- OpenTelemetry instrumentation
- Prometheus metrics
- Grafana dashboards
- structured logs

## Data Contracts

Every memory artifact should include:

- stable memory identifier
- memory type
- scope
- provenance
- confidence
- timestamps
- model version metadata
- references to linked artifacts in other stores

Compaction responses should include:

- whether compaction triggered
- why it triggered
- occupancy ratio
- working summary
- open loops
- promoted memory identifiers by module
- candidate rationale and scores

## Retrieval Strategy

Retrieval is intentionally hybrid:

- semantic search for conceptual similarity
- sparse matching for exact terms and identifiers
- graph traversal for entities, relations, and temporal context
- metadata filtering for scope, recency, trust, and type
- reranking for final relevance

This is the main differentiator from standard vector-only RAG systems.

## MVP Boundary

The MVP should prove:

- cross-store ingestion
- hybrid recall
- reranking
- background maintenance workflows
- provenance-aware response packaging

It should defer:

- complex governance policies
- learned long-term compression
- distributed coordination across nodes
