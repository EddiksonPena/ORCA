"""Auto-generated MCP wrapper: orca/orca_health — Check if Orca is reachable and healthy. Returns service status, artifact counts, and graph stats."""
from __future__ import annotations
from ._client import call_mcp


async def orca_health(

) -> dict:
    """Check if Orca is reachable and healthy. Returns service status, artifact counts, and graph stats."""
    return await call_mcp("orca_health", {})


def orca_health_sync() -> dict:
    import asyncio; return asyncio.run(orca_health())
