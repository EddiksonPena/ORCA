# Kubernetes Reference

This folder provides a lightweight reference deployment shape for the Orca application layer.

Included here:

- `namespace.yaml`
- `configmap.yaml`
- `secret.example.yaml`
- `platform-secrets.example.yaml`
- `external-secret.example.yaml`
- `networkpolicy.yaml`
- `poddisruptionbudgets.yaml`
- `hpa.yaml`
- `servicemonitor.example.yaml`
- `podmonitor.example.yaml`
- `prometheusrule.example.yaml`
- `alertmanagerconfig.example.yaml`
- `memory-api-deployment.yaml`
- `worker-deployment.yaml`
- `ingress.example.yaml`
- `platform/`

There are now two reference levels in this folder:

- app layer only:
  `memory-api`, `worker`, ingress, config, and app secrets
- full self-hosted reference:
  `platform/redis.yaml`, `platform/weaviate.yaml`, `platform/neo4j.yaml`, `platform/temporal-postgres.yaml`, and `platform/temporal.yaml`

Additional production-hardening references:

- `networkpolicy.yaml`
- `poddisruptionbudgets.yaml`
- `hpa.yaml`
- `servicemonitor.example.yaml`
- `podmonitor.example.yaml`
- `prometheusrule.example.yaml`
- `alertmanagerconfig.example.yaml`
- `platform/backup-cronjobs.example.yaml`

The platform manifests are still reference-grade and should be adapted to your storage classes, security posture, backup strategy, and resource sizing before production use.

Create the referenced secret before applying the deployments:

Apply or adapt [`secret.example.yaml`](secret.example.yaml), or create the secret imperatively:

```bash
kubectl create secret generic orca-secrets \
  --namespace orca \
  --from-literal=neo4j-password='<replace-me>' \
  --from-literal=api-key='<replace-me>'
```

The reference app manifests wire `ORCA_API_KEY` from this secret. Health endpoints stay open for Kubernetes probes; all other API and worker routes require auth.

Supported app auth modes:

- `api-key`
- `jwt`
- `hybrid`
- `none`

For production, prefer `hybrid` or `jwt` with:

- `ORCA_JWT_ISSUER`
- `ORCA_JWT_AUDIENCE`
- optional `ORCA_JWKS_URL`
- optional `ORCA_JWT_REQUIRED_SCOPES`

If you use a secret manager, adapt [`external-secret.example.yaml`](external-secret.example.yaml) instead of committing raw Kubernetes secrets.

If you want an HTTP entrypoint example, adapt [`ingress.example.yaml`](ingress.example.yaml) to your ingress controller, hostnames, and TLS secret.

## Full Reference Stack

To apply the full self-hosted platform reference:

```bash
kubectl apply -k deploy/k8s/platform
kubectl apply -f deploy/k8s/networkpolicy.yaml
kubectl apply -f deploy/k8s/poddisruptionbudgets.yaml
kubectl apply -f deploy/k8s/hpa.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.example.yaml
kubectl apply -f deploy/k8s/memory-api-deployment.yaml
kubectl apply -f deploy/k8s/worker-deployment.yaml
```

This creates:

- Redis for working memory and shared state
- Weaviate for semantic retrieval
- Neo4j for graph storage
- PostgreSQL for Temporal persistence
- Temporal frontend service

Optional backup examples live in [`platform/backup-cronjobs.example.yaml`](platform/backup-cronjobs.example.yaml). Treat them as starter manifests that should be adapted to your object storage, snapshot, or managed-backup workflow.

If you run the Prometheus Operator, adapt:

- [`servicemonitor.example.yaml`](servicemonitor.example.yaml)
- [`podmonitor.example.yaml`](podmonitor.example.yaml)
- [`prometheusrule.example.yaml`](prometheusrule.example.yaml)
- [`alertmanagerconfig.example.yaml`](alertmanagerconfig.example.yaml)

The alert rule examples mirror the local Prometheus rules shipped in [`infra/docker/prometheus/rules/orca-alerts.yml`](../../infra/docker/prometheus/rules/orca-alerts.yml). Adapt the receiver URLs in [`alertmanagerconfig.example.yaml`](alertmanagerconfig.example.yaml) to your Slack, PagerDuty, webhook, or incident pipeline.

After rollout, validate the environment with the production-readiness commands described in [`docs/deployment/production-readiness.md`](../../docs/deployment/production-readiness.md). The reference deploy workflow already runs the smoke portion automatically after rollout.
