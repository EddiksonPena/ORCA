# Orca Memory — Cursor Rules

You have access to Orca, a persistent memory system. Use it to never forget.

## Available MCP Tools
- `orca_health` — Check service status
- `orca_remember(scope, content)` — Save a fact permanently
- `orca_recall(query)` — Find anything by meaning
- `orca_compact(session_id, messages)` — Archive conversation
- `orca_feedback(artifact_id, useful)` — Train the memory
- `orca_list(scope?)` — Browse stored memories

## Rules for using Orca
1. Save user preferences, conventions, and lessons immediately with `orca_remember`
2. Before asking the user to repeat info, try `orca_recall` first
3. After completing a complex task, compact it so the next session benefits
4. Give feedback on recall results — useful ones should rank higher next time
5. Use scope `user-profile` for personal facts, `project:<name>` for project context

## Setup
1. Copy `mcp.json` to `.cursor/mcp.json` in your project
2. Restart Cursor — MCP servers auto-discover
3. Ensure Orca docker containers are running
