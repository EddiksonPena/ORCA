"""Generate typed Python wrappers for an MCP server.
Connects to the server (stdio or HTTP), lists all tools, and creates a
filesystem of typed wrapper modules under mcp_servers/<server_name>/.

Usage:
    # For stdio servers:
    python generate_mcp_wrappers.py --server orca \\
        --transport stdio \\
        --command "uv" \\
        --args '["run", "--directory", "/path/to/server", "python", "server.py"]'

    # For HTTP servers:
    python generate_mcp_wrappers.py --server remote-api \\
        --transport http \\
        --url "https://api.example.com/mcp"

Output:
    mcp_servers/<server_name>/
    ├── __init__.py
    ├── _manifest.json
    ├── _client.py
    ├── tool_one.py
    ├── tool_two.py
    └── ...
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


OUTPUT_ROOT = Path("mcp_servers")

SHARED_CLIENT = '''"""Shared MCP client for generated wrappers — lazy-imports mcp SDK."""
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
'''


def python_type_from_schema(schema: dict | None) -> str:
    """Convert JSON Schema property to a Python type annotation."""
    if schema is None:
        return "Any"

    json_type = schema.get("type", "string")

    type_map = {
        "string": "str",
        "integer": "int",
        "number": "float",
        "boolean": "bool",
        "object": "dict",
    }
    base = type_map.get(json_type, "Any")

    if json_type == "array":
        items = schema.get("items", {})
        inner = python_type_from_schema(items) if items else "Any"
        base = f"list[{inner}]"

    # Handle optional (anyOf with null)
    if "anyOf" in schema:
        non_null = [s for s in schema["anyOf"] if s.get("type") != "null"]
        if non_null:
            inner = python_type_from_schema(non_null[0])
            return f"{inner} | None"

    return base


def default_value(param: dict) -> str | None:
    """Extract default value for a parameter if present."""
    schema = param.get("inputSchema", param)
    if "default" in schema:
        val = schema["default"]
        if isinstance(val, str):
            return f'"{val}"'
        if isinstance(val, bool):
            return str(val)
        return str(val)
    return None


def generate_tool_wrapper(tool: dict, server_name: str) -> str:
    """Generate a single typed wrapper module for a tool."""
    name = tool["name"]
    desc = tool.get("description", f"Call {name}")

    full_name = name
    safe_name = name.replace("-", "_").replace(".", "_")

    params: list[dict] = []
    required: set[str] = set()

    input_schema = tool.get("inputSchema", {})
    if input_schema.get("type") == "object":
        required = set(input_schema.get("required", []))
        props = input_schema.get("properties", {})
        for pname, pschema in props.items():
            params.append({
                "name": pname,
                "type": python_type_from_schema(pschema),
                "required": pname in required,
                "default": default_value(pschema),
                "description": pschema.get("description", ""),
            })

    # Build function signature
    sig_parts = []
    for p in params:
        param_str = f"{p['name']}: {p['type']}"
        if p["default"] is not None:
            param_str += f" = {p['default']}"
        elif not p["required"]:
            param_str += " = None"
        sig_parts.append(param_str)

    signature = f"async def {safe_name}(\n    {', '.join(sig_parts) if sig_parts else ''}\n) -> dict:"

    # Build docstring
    doc_lines = [f'    """{desc}' if params else f'    """{desc}"""']
    if params:
        doc_lines.append("")
        doc_lines.append("    Args:")
        for p in params:
            req = " (required)" if p["required"] else ""
            doc_lines.append(f"        {p['name']}: {p['description']}{req}")
        doc_lines.append('    """')

    # Build call
    call_args = ", ".join(f'"{p["name"]}": {p["name"]}' for p in params)
    call_line = f"    return await call_mcp(\"{full_name}\", {{{call_args}}})"

    # Sync wrapper
    sync_params = []
    for p in params:
        sp = f"{p['name']}: {p['type']}"
        if p["default"] is not None:
            sp += f" = {p['default']}"
        elif not p["required"]:
            sp += " = None"
        sync_params.append(sp)

    sync_sig = f"def {safe_name}_sync({', '.join(sync_params) if sync_params else ''}) -> dict:"
    sync_body = f"    import asyncio; return asyncio.run({safe_name}({', '.join(p['name'] for p in params)}))"

    return f'''"""Auto-generated MCP wrapper: {server_name}/{name} — {desc}"""
from __future__ import annotations
from ._client import call_mcp


{signature}
{chr(10).join(doc_lines)}
{call_line}


{sync_sig}
{sync_body}
'''


def generate_init(tools: list[dict]) -> str:
    """Generate __init__.py with imports and __all__."""
    imports = []
    exports = []
    for tool in tools:
        safe = tool["name"].replace("-", "_").replace(".", "_")
        imports.append(f"from .{safe} import {safe}, {safe}_sync")
        exports.append(f'    "{safe}"')
        exports.append(f'    "{safe}_sync"')

    return f'''"""Auto-generated MCP wrappers."""
{chr(10).join(imports)}


__all__ = [
{",".join(exports)}
]
'''


async def discover_stdio(server_name: str, command: str, args: list[str]) -> dict:
    """Connect via stdio and list tools."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(command=command, args=args)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools_result = await session.list_tools()
            tools = []
            for t in tools_result.tools:
                tools.append({
                    "name": t.name,
                    "description": getattr(t, "description", ""),
                    "inputSchema": getattr(t, "inputSchema", {}),
                })
            return {
                "server": server_name,
                "transport": "stdio",
                "command": command,
                "args": args,
                "tools": tools,
            }


async def discover_http(server_name: str, url: str) -> dict:
    """Connect via HTTP and list tools."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async with streamable_http_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools_result = await session.list_tools()
            tools = []
            for t in tools_result.tools:
                tools.append({
                    "name": t.name,
                    "description": getattr(t, "description", ""),
                    "inputSchema": getattr(t, "inputSchema", {}),
                })
            return {
                "server": server_name,
                "transport": "http",
                "url": url,
                "tools": tools,
            }


async def main():
    parser = argparse.ArgumentParser(description="Generate MCP code wrappers")
    parser.add_argument("--server", required=True, help="Server name for the output directory")
    parser.add_argument("--transport", choices=["stdio", "http"], required=True)
    parser.add_argument("--command", help="Command to run (stdio only)")
    parser.add_argument("--args", type=json.loads, default=[], help="JSON array of args (stdio only)")
    parser.add_argument("--url", help="Server URL (http only)")
    parsed = parser.parse_args()

    if parsed.transport == "stdio":
        if not parsed.command:
            print("Error: --command required for stdio transport", file=sys.stderr)
            sys.exit(1)
        manifest = await discover_stdio(parsed.server, parsed.command, parsed.args)
    else:
        if not parsed.url:
            print("Error: --url required for http transport", file=sys.stderr)
            sys.exit(1)
        manifest = await discover_http(parsed.server, parsed.url)

    manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
    tools = manifest["tools"]
    print(f"Discovered {len(tools)} tools from {parsed.server}")

    server_dir = OUTPUT_ROOT / parsed.server
    server_dir.mkdir(parents=True, exist_ok=True)

    (server_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"  wrote _manifest.json")

    (server_dir / "_client.py").write_text(SHARED_CLIENT)
    print(f"  wrote _client.py")

    for tool in tools:
        safe = tool["name"].replace("-", "_").replace(".", "_")
        wrapper = generate_tool_wrapper(tool, parsed.server)
        (server_dir / f"{safe}.py").write_text(wrapper)
        print(f"  wrote {safe}.py")

    init = generate_init(tools)
    (server_dir / "__init__.py").write_text(init)
    print(f"  wrote __init__.py")

    root_init = OUTPUT_ROOT / "__init__.py"
    if not root_init.exists():
        root_init.write_text("# MCP Server Wrappers\n")

    print(f"\nDone. Wrappers at {server_dir}/")
    print(f"Import: from mcp_servers.{parsed.server} import {tools[0]['name']}")


if __name__ == "__main__":
    asyncio.run(main())
