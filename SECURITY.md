# Security Policy

## Supported Scope

Orca is currently in an early open-source stage. Security fixes are prioritized for the latest mainline version of the repository.

## Reporting

If you discover a security issue, please avoid opening a public issue with exploit details.

Instead, report it privately to the maintainers with:

- a clear description of the issue
- affected components and versions
- reproduction steps
- impact assessment
- suggested mitigations if available

## Operational Guidance

For non-local environments:

- put the API behind authentication and TLS
- set `ORCA_API_KEY` at minimum for non-health Orca routes
- disable anonymous Weaviate access
- keep Redis, Neo4j, and Temporal off the public internet
- store credentials in a secret manager
- rotate default credentials before any shared deployment
