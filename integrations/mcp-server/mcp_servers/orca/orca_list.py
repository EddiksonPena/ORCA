"""Auto-generated MCP wrapper: orca/orca_list — List all memories stored in Orca, optionally filtered by scope.

scope — optional filter: 'user-profile', 'project:<name>', 'skill:<name>', 'workspace', etc."""
from __future__ import annotations
from ._client import call_mcp


async def orca_list(
    scope: str | None = None
) -> dict:
    """List all memories stored in Orca, optionally filtered by scope.

scope — optional filter: 'user-profile', 'project:<name>', 'skill:<name>', 'workspace', etc.

    Args:
        scope:
    """
    return await call_mcp("orca_list", {"scope": scope})


def orca_list_sync(scope: str | None = None) -> dict:
    import asyncio; return asyncio.run(orca_list(scope))
