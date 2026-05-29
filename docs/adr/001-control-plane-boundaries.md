# ADR 001: Control Plane And Data Plane Boundaries

## Status

Accepted.

## Context

The system aims to support multiple memory substrates and evolving retrieval behavior without coupling agents directly to storage implementations. If the API talks to stores directly without a strong control plane abstraction, the design will become a set of ad hoc integrations instead of a coherent memory operating system.

## Decision

We will separate the architecture into:

- a control plane that owns ingestion policy, retrieval planning, lifecycle, governance, and background workflows
- a data plane that owns concrete storage and retrieval execution across Redis, Weaviate, and Neo4j

The Memory API will depend on the control plane, not on store-specific logic.

## Consequences

### Positive

- store implementations remain replaceable
- retrieval logic can evolve without breaking agent contracts
- lifecycle and governance can be layered in gradually
- background workflows can operate over memory events consistently

### Negative

- more upfront abstraction work
- additional coordination complexity between control and data layers
- more interfaces and internal contracts to define early

## Implementation Notes

- define store adapters early
- keep schemas canonical and store-agnostic
- treat cross-store links as first-class identifiers
- model background jobs as control-plane responsibilities

## Related Decisions

- ADR 002: Canonical memory schema
- ADR 003: Scope hierarchy and access boundaries
- ADR 004: Immutable events versus mutable memory views
- ADR 005: Retrieval evaluation strategy
