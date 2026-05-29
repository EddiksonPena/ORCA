# Integration Patterns

When and how to integrate Orca with Hermes' existing memory tools.

## Decision Matrix

```
What are you trying to do?
  │
  ├─ Store one quick fact (<500 chars), exact lookup later
  │   → memory tool
  │
  ├─ Find something by keyword in past conversations
  │   → session_search
  │
  ├─ Search conceptually ("things like X", "patterns across sessions")
  │   → orca recall
  │
  ├─ Store an important decision with rationale
  │   → orca ingest
  │
  ├─ End of session — preserve what mattered
  │   → orca compact
  │
  └─ Identify recurring patterns across projects
      → orca recall (cross-scope)
```

## Session Start: Bootstrap Context

Before engaging with the user, load relevant context:

```
1. orca recall(query="user preferences", scope="user-profile")
   → Returns palette preferences, communication style, tool conventions

2. If project context detected:
   orca recall(query="<project> conventions", scope="project:<name>")
   → Returns coding standards, deployment targets, naming patterns

3. If specific skills mentioned:
   orca recall(query="<skill> usage", scope="skill:<name>")
   → Returns skill-specific patterns and pitfalls
```

## During Session: Capture Decisions

When something important happens:

```
User corrects approach:
  → orca ingest(scope="user-profile", tags=["correction"], content=<what changed>)

New pattern discovered:
  → orca ingest(scope="skill:<name>", tags=["pattern"], content=<the pattern>)

Bug fix resolved:
  → orca ingest(scope="project:<name>", tags=["bug-fix"], content=<how fixed>)
```

## Session End: Compact

```
orca compact({
  scope: "workspace",
  occupancyRatio: estimated_context_usage,
  sessionId: session_id,
  messages: conversation_history
})
```

Then review `promoted` array for items worth saving as skills.

## Hybrid Pattern: memory + Orca

High-value facts should live in BOTH systems:

```python
# Store in memory tool for instant load
memory(action="add", target="memory", content="User prefers Sophisticated Earth palette")

# Also store in Orca for semantic search and graph linking
# POST /v1/memories/ingest with:
{
  "scope": "user-profile",
  "source": "design-preference",
  "tags": ["palette", "aesthetic"],
  "content": "User prefers Sophisticated Earth palette: Deep Obsidian #0D0C0B backgrounds, Creamy Ivory #F9F4E5 text, Vibrant Coral #EB7044 CTAs. Favors asymmetric Bento grids and Architectural Precision style."
}
```

## Hybrid Pattern: skill + Orca

Skills define HOW, Orca remembers WHEN and WHY:

```
skill_manage("create", ...)  → procedural memory
orca ingest(...)       → why this skill was created, when it's useful
orca feedback(...)     → is this skill actually used?
```

## Context Pressure Monitoring

Track context window usage. At >70%:
1. Run `orca compact` with `occupancyRatio` set
2. Review `workingSummary` — use it to replace verbose history
3. Check `openLoops` — keep only unresolved items in active context
