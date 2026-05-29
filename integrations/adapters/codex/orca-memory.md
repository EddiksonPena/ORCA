# Orca Memory

Persistent, cross-session memory for your Codex agent. Semantically searchable, feedback-driven, never forgets.

## Tools
- `orca_health` — Health check
- `orca_remember(scope, content, source?, tags?)` — Store a memory
- `orca_recall(query, scope?)` — Search memory semantically
- `orca_compact(session_id, messages, scope?)` — Compact conversation
- `orca_feedback(artifact_id, useful)` — Reinforce/demote
- `orca_list(scope?)` — List all memories

## Rules
1. Remember anything you'd want to know again next session — user preferences, environment quirks, solutions to tricky bugs.
2. Always recall relevant memories before asking the user to repeat themselves.
3. Scope wisely: `user-profile` for the user, `project:<name>` for project conventions, `workspace` for general knowledge.
4. After a session ends, compact it so next session picks up where you left off.
5. Give feedback on recalled memories — useful ones get boosted, irrelevant ones get demoted.
