"""Auto-generated MCP wrapper: orca/orca_compact — Compact a conversation window into durable episodic, semantic, and procedural memory.

session_id — a unique identifier for this session
messages — list of {"role": "user"|"assistant", "content": "..."} pairs from the conversation
scope — memory scope, defaults to 'workspace'

Returns whether compaction triggered, a working summary, any open loops, and which memories were promoted."""
from __future__ import annotations
from ._client import call_mcp


async def orca_compact(
    session_id: str, messages: list[dict], scope: str = "workspace"
) -> dict:
    """Compact a conversation window into durable episodic, semantic, and procedural memory.

session_id — a unique identifier for this session
messages — list of {"role": "user"|"assistant", "content": "..."} pairs from the conversation
scope — memory scope, defaults to 'workspace'

Returns whether compaction triggered, a working summary, any open loops, and which memories were promoted.

    Args:
        session_id:  (required)
        messages:  (required)
        scope:
    """
    return await call_mcp("orca_compact", {"session_id": session_id, "messages": messages, "scope": scope})


def orca_compact_sync(session_id: str, messages: list[dict], scope: str = "workspace") -> dict:
    import asyncio; return asyncio.run(orca_compact(session_id, messages, scope))
