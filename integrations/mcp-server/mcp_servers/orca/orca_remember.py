"""Auto-generated MCP wrapper: orca/orca_remember — Store a fact, decision, discovery, or correction in Orca memory.

scope — one of: 'user-profile', 'project:<name>', 'skill:<name>', 'workspace', 'session:<id>'
content — the fact or discovery to remember
source — what produced this memory (default: hermes-agent)
tags — optional list of categorical tags for filtering later

Returns the memoryId and which stores it was persisted to (working, semantic, graph)."""
from __future__ import annotations
from ._client import call_mcp


async def orca_remember(
    scope: str, content: str, source: str = "hermes-agent", tags: list[str] | None = None
) -> dict:
    """Store a fact, decision, discovery, or correction in Orca memory.

scope — one of: 'user-profile', 'project:<name>', 'skill:<name>', 'workspace', 'session:<id>'
content — the fact or discovery to remember
source — what produced this memory (default: hermes-agent)
tags — optional list of categorical tags for filtering later

Returns the memoryId and which stores it was persisted to (working, semantic, graph).

    Args:
        scope:  (required)
        content:  (required)
        source:
        tags:
    """
    return await call_mcp("orca_remember", {"scope": scope, "content": content, "source": source, "tags": tags})


def orca_remember_sync(scope: str, content: str, source: str = "hermes-agent", tags: list[str] | None = None) -> dict:
    import asyncio; return asyncio.run(orca_remember(scope, content, source, tags))
