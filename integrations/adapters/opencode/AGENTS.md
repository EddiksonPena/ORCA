# Orca Memory — OpenCode Integration

Persistent memory for OpenCode. Cross-session, cross-project, always available.

## MCP Tools
- `orca_health` — Health check
- `orca_remember(scope, content)` — Persist a fact
- `orca_recall(query, scope?)` — Semantic search
- `orca_compact(session_id, messages)` — Compress conversation
- `orca_feedback(artifact_id, useful)` — Rate a memory
- `orca_list(scope?)` — List all memories

## When to use
- **Remember** user preferences, project conventions, non-obvious fixes
- **Recall** before asking "what was that thing again?"
- **Feedback** after each recall — boost what helps, demote what doesn't
- **Compact** before ending a session to save working state

## Setup
1. `opencode.json` → merge into your project's OpenCode config
2. `AGENTS.md` → place in project root
3. Orca must be running in docker
