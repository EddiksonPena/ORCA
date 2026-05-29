"""Auto-generated MCP wrapper: orca/orca_feedback — Reinforce or demote a memory. Useful memories get higher salience and rank higher in future recalls.

artifact_id — the memory ID from a recall or remember response
useful — true to reinforce this memory, false to demote it"""
from __future__ import annotations
from ._client import call_mcp


async def orca_feedback(
    artifact_id: str, useful: bool
) -> dict:
    """Reinforce or demote a memory. Useful memories get higher salience and rank higher in future recalls.

artifact_id — the memory ID from a recall or remember response
useful — true to reinforce this memory, false to demote it

    Args:
        artifact_id:  (required)
        useful:  (required)
    """
    return await call_mcp("orca_feedback", {"artifact_id": artifact_id, "useful": useful})


def orca_feedback_sync(artifact_id: str, useful: bool) -> dict:
    import asyncio; return asyncio.run(orca_feedback(artifact_id, useful))
