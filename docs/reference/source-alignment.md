# Source Alignment Notes

This document records how the project should align with the official documentation for the requested technologies.

Important context:

- the current repository runtime is `TypeScript`
- these source notes describe architectural alignment and future-compatible integration paths, not a claim that each referenced framework is already in use in this codebase

## FastMCP

Official guidance emphasizes:

- `fastmcp.json` as the canonical portable deployment configuration
- reproducible runtime setup
- clean separation between source, environment, and deployment configuration

Project implication:

- if `Orca` adds an MCP-native facade, it should be a thin adapter over the control plane
- do not collapse the whole memory OS into a single FastMCP server runtime unless you intentionally move to a Python-first architecture

Reference:

- [FastMCP Project Configuration](https://gofastmcp.com/v2/deployment/server-configuration)
- [FastMCP Installation](https://gofastmcp.com/getting-started/installation)

## FastAPI

Official docs emphasize deployment concepts first, then server workers and containers.

Project implication:

- keep the API stateless
- prefer containerized deployment
- scale API replicas independently of worker replicas

Reference:

- [FastAPI Deployment Concepts](https://fastapi.tiangolo.com/deployment/concepts/)
- [FastAPI in Containers](https://fastapi.tiangolo.com/fa/deployment/docker/)

## Redis LangCache

The official Redis docs position LangCache as a managed Redis Cloud service exposed through an API.

Project implication:

- LangCache is not the base local-first OSS memory layer
- use plain Redis for working memory and add semantic caching as an optional managed integration

Reference:

- [Redis LangCache Overview](https://redis.io/docs/latest/operate/rc/langcache/)
- [Use the LangCache API on Redis Cloud](https://redis.io/docs/latest/operate/rc/langcache/use-langcache/)

## Temporal

Temporal’s official docs position it as the workflow durability layer and support both self-hosting and Temporal Cloud.

Project implication:

- use Temporal for long-running maintenance work
- keep workflows outside the request path
- choose Temporal Cloud if operational simplicity matters more than pure self-hosting

Reference:

- [Temporal Docs](https://docs.temporal.io/)

## Graphiti

Graphiti’s docs describe a temporal knowledge graph framework for agents with hybrid retrieval and Neo4j-backed context graphs.

Project implication:

- Graphiti is directionally aligned with this project
- keep graph integration pluggable so Graphiti can be added cleanly

Reference:

- [Graphiti Welcome](https://help.getzep.com/graphiti/getting-started/welcome)
- [Graphiti GitHub](https://github.com/getzep/graphiti)

## Neo4j

Neo4j’s official docs are explicit that:

- Community Edition is suited to single-instance deployments
- clustering and failover are Enterprise features

Project implication:

- for strict OSS deployments, treat Neo4j as a single-instance component
- for robust distributed production, use Neo4j Enterprise or keep the graph backend swappable

Reference:

- [Neo4j Operations Manual Introduction](https://neo4j.com/docs/operations-manual/current/introduction/)
- [Neo4j Docker Introduction](https://neo4j.com/docs/operations-manual/current/docker/introduction/)
- [Neo4j Cluster Deployment](https://neo4j.com/docs/operations-manual/current/clustering/setup/deploy/)

## Weaviate

Weaviate’s docs recommend:

- Docker for local evaluation and development
- Kubernetes for development-to-production self-hosting

Project implication:

- current Docker usage is appropriate
- production should move to Helm or Kubernetes manifests with auth and persistence hardening

Reference:

- [Weaviate Docker Installation](https://docs.weaviate.io/deploy/installation-guides/docker-installation)
- [Weaviate Installation Options](https://docs.weaviate.io/weaviate/installation)
