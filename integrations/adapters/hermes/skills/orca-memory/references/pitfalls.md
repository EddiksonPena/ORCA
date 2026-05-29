# Orca Pitfalls

Common failure modes and recovery steps.

## Startup Failures

| Problem | Check | Fix |
|---------|-------|-----|
| API returns connection refused | `docker compose ps` | Start infrastructure first |
| Worker can't find Temporal | `docker compose logs temporal` | Wait 30s for Temporal boot |
| Neo4j auth fails | NEO4J_PASSWORD in .env | Set to `orca-local` or match docker-compose |
| Weaviate 500 errors | `docker compose logs weaviate` | May need more Docker memory |
| Embeddings fail | `ollama list` | Pull nomic-embed-text if missing |

## Runtime Failures

| Problem | Check | Fix |
|---------|-------|-----|
| Ingest returns 400 | Request body structure | Validate JSON matches schema |
| Recall returns empty | Scope mismatch | Try without scope filter |
| Recall returns irrelevant | Embedding model quality | Check embedding model is loaded |
| Compact doesn't trigger | occupancyRatio too low | Set >0.6 to force |
| Feedback returns 404 | Wrong artifactId | Use ID from ingest/recall response |

## Docker Issues

| Problem | Fix |
|---------|-----|
| Permission denied on socket | `sudo usermod -aG docker $USER` + re-login |
| Port already in use | Change port in .env or stop conflicting service |
| Container keeps restarting | `docker compose logs <service>` |
| Out of disk space | `docker system prune -a` (careful: removes unused images) |

## Memory Quality Issues

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Stale preferences returned | No reinforcement signal | Send `feedback(useful=true)` on good results |
| Duplicate memories | No dedup running | Trigger reindex workflow |
| Too many low-value memories | No demotion | Send `feedback(useful=false)` on noise |
| Missing cross-project links | Graph not built | Ensure Neo4j is connected and ingesting |

## State Management

Orca uses file-backed state by default (`./data/orca-memory-os.json`).

```bash
# Backup
cp ~/projects/orca/data/orca-memory-os.json ~/backups/orca-$(date +%Y%m%d).json

# Reset (careful: loses all memory)
rm ~/projects/orca/data/orca-memory-os.json
# Restart memory-api to recreate
```
