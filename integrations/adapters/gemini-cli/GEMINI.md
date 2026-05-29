# Orca Memory — Gemini CLI Integration

You have persistent memory through Orca. Never forget user preferences, project conventions, or hard-won solutions.

## MCP Tools
- `orca_health` — Verify Orca is running
- `orca_remember(scope, content)` — Store a durable fact
- `orca_recall(query, scope?)` — Search memory
- `orca_compact(session_id, messages)` — Compact conversation into memory
- `orca_feedback(artifact_id, useful)` — Train the memory
- `orca_list(scope?)` — Browse all memories

## Usage
- Store user preferences, environment details, and lessons learned with `orca_remember`
- Search memory with `orca_recall` before repeating yourself
- Feed back on recalled items to improve future relevance
- Compact after significant work so the state persists

## Setup
1. Place `settings.json` at `~/.gemini/settings.json` (or merge into existing)
2. Place `GEMINI.md` in your project root
3. Ensure Orca is running (`docker compose up -d` from monorepo root)
