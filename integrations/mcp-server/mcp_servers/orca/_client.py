"""Shared MCP client for generated wrappers — lazy-imports mcp SDK."""
from __future__ import annotations
import json, os

_MANIFEST = json.load(open(os.path.join(os.path.dirname(__file__), "_manifest.json")))

async def call_mcp(tool_name: str, arguments: dict) -> dict:
    """Call an MCP tool via stdio and return the parsed JSON result."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(
        command=_MANIFEST["command"],
        args=_MANIFEST["args"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments)
            text = result.content[0].text
            return json.loads(text)
