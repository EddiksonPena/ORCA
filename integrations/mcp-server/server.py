"""
Orca MCP Server — exposes Orca memory API as native MCP tools.
Connects to Orca on localhost:4000.
Run: uv run python server.py   (stdio for Hermes auto-discovery)
     uv run python server.py --http 8000   (HTTP for manual testing)
"""
import sys
import os
import httpx
from fastmcp import FastMCP

mcp = FastMCP("Orca")
BASE = os.environ.get("ORCA_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
API_KEY = os.environ.get("ORCA_API_KEY", "").strip()


def auth_headers() -> dict[str, str]:
    headers = {"content-type": "application/json"}
    if API_KEY:
        headers["x-api-key"] = API_KEY
    return headers


@mcp.tool
async def orca_health() -> dict:
    """Check if Orca is reachable and healthy. Returns service status, artifact counts, and graph stats."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{BASE}/health", timeout=5)
        resp.raise_for_status()
        return resp.json()


@mcp.tool
async def orca_remember(
    scope: str,
    content: str,
    source: str = "hermes-agent",
    tags: list[str] | None = None,
) -> dict:
    """Store a fact, decision, discovery, or correction in Orca memory.

    scope — one of: 'session', 'agent', 'user', 'user-profile', 'workspace', 'global', 'project:<name>', 'skill:<name>', 'session:<id>'
    content — the fact or discovery to remember
    source — what produced this memory (default: hermes-agent)
    tags — optional list of categorical tags for filtering later

    Returns the memoryId and which stores it was persisted to (working, semantic, graph)."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/v1/memories/ingest",
            headers=auth_headers(),
            json={"scope": scope, "source": source, "tags": tags or [], "content": content},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool
async def orca_recall(
    query: str,
    scope: str | None = None,
) -> dict:
    """Semantically search Orca memory for anything matching a natural-language query.

    query — what you're looking for, in plain English (e.g. 'user design preferences' or 'how was the last deploy done?')
    scope — optional filter to a specific scope (user-profile, project:name, workspace, etc.)

    Returns ranked context items with confidence scores, provenance, and salience metadata."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/v1/memories/recall",
            headers=auth_headers(),
            json={"query": query, "scope": scope, "includeDiagnostics": True},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool
async def orca_compact(
    session_id: str,
    messages: list[dict],
    scope: str = "workspace",
) -> dict:
    """Compact a conversation window into durable episodic, semantic, and procedural memory.

    session_id — a unique identifier for this session
    messages — list of {"role": "user"|"assistant", "content": "..."} pairs from the conversation
    scope — memory scope, defaults to 'workspace'

    Returns whether compaction triggered, a working summary, any open loops, and which memories were promoted."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/v1/memories/compact",
            headers=auth_headers(),
            json={
                "scope": scope,
                "occupancyRatio": 0.75,
                "sessionId": session_id,
                "messages": messages,
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool
async def orca_feedback(artifact_id: str, useful: bool) -> dict:
    """Reinforce or demote a memory. Useful memories get higher salience and rank higher in future recalls.

    artifact_id — the memory ID from a recall or remember response
    useful — true to reinforce this memory, false to demote it"""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/v1/memories/feedback",
            headers=auth_headers(),
            json={"artifactId": artifact_id, "useful": useful},
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool
async def orca_list(scope: str | None = None) -> dict:
    """List all memories stored in Orca, optionally filtered by scope.

    scope — optional filter: 'user-profile', 'project:<name>', 'skill:<name>', 'workspace', etc."""
    async with httpx.AsyncClient() as client:
        params = {}
        if scope:
            params["scope"] = scope
        resp = await client.get(f"{BASE}/v1/memories", params=params, headers=auth_headers(), timeout=10)
        resp.raise_for_status()
        return resp.json()


if __name__ == "__main__":
    if "--http" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--http") + 1])
        except (IndexError, ValueError):
            port = 8000
        mcp.run(transport="http", port=port)
    else:
        mcp.run()  # stdio for Hermes auto-discovery
