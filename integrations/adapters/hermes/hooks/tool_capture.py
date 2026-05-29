#!/usr/bin/env python3
"""
post_tool_call hook: capture ALL tool calls to Orca.
Receives JSON on stdin with tool_name, args, result, session_id.
Stores tool call as episodic memory; filters large MCP results.
"""
import json
import os
import sys
import urllib.request
import urllib.error

ORCA_URL = os.environ.get("ORCA_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
ORCA_API_KEY = os.environ.get("ORCA_API_KEY", "").strip()
MAX_RESULT_SIZE = 800
NON_CAPTURE_TOOLS = {"memory", "clarify", "todo", "session_search", "skills_list"}
MCP_TOOLS = {"mcp_orca_health", "mcp_orca_remember",
             "mcp_orca_recall", "mcp_orca_compact",
             "mcp_orca_feedback", "mcp_orca_list"}


def headers():
    value = {"Content-Type": "application/json"}
    if ORCA_API_KEY:
        value["x-api-key"] = ORCA_API_KEY
    return value

try:
    ctx = json.load(sys.stdin)
except json.JSONDecodeError:
    print(json.dumps({"ok": False, "error": "Invalid stdin JSON"}))
    sys.exit(1)

tool_name = ctx.get("tool_name", "")
args = ctx.get("args", {})
result = ctx.get("result", "")
session_id = ctx.get("session_id", "unknown")

# Skip meta-tools that would cause recursion
if tool_name in NON_CAPTURE_TOOLS or tool_name in MCP_TOOLS:
    print(json.dumps({"ok": True, "skipped": "meta_tool"}))
    sys.exit(0)

# Parse result for summarization
result_str = result if isinstance(result, str) else json.dumps(result)
try:
    parsed = json.loads(result_str)
except (json.JSONDecodeError, TypeError):
    parsed = {"raw": result_str[:MAX_RESULT_SIZE]}

# Build a safe summary (strip credentials)
args_safe = {k: (v if k not in ("api_key", "token", "password", "secret") else "***")
             for k, v in args.items()} if isinstance(args, dict) else {}

summary = f"[{tool_name}]" if not args_safe else (
    f"[{tool_name}] " + ", ".join(f"{k}={str(v)[:60]}" for k, v in list(args_safe.items())[:3])
)

# Extract result snippet
if isinstance(parsed, dict):
    if "error" in parsed:
        summary += f" → ERROR: {str(parsed['error'])[:120]}"
    elif "exit_code" in parsed:
        summary += f" → exit={parsed.get('exit_code', '?')}"
    elif "status" in parsed:
        summary += f" → {parsed.get('status', '')}"
else:
    summary += f" → {result_str[:120]}"

# Store to Orca
persisted = False
memory_id = None
if tool_name not in MCP_TOOLS:  # Avoid storing Orca calls back to Orca
    try:
        req = urllib.request.Request(
            f"{ORCA_URL}/v1/memories/ingest",
            data=json.dumps({
                "scope": "workspace",
                "source": f"hermes-agent:{session_id}",
                "tags": ["tool-call", tool_name],
                "content": summary
            }).encode(),
            headers=headers(),
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
            if data.get("accepted"):
                persisted = True
                memory_id = data.get("memoryId", "")
    except Exception:
        pass  # Best-effort — never block the agent on capture failure

# If MCP recall result is large, filter it
filtered_result = None
if tool_name == "mcp_orca_recall":
    context_items = parsed.get("context", [])
    if context_items and len(result_str) > MAX_RESULT_SIZE:
        summary_items = []
        for item in context_items[:5]:
            summary_items.append({
                "summary": item.get("content", "")[:150],
                "confidence": item.get("confidence", 0),
                "id": item.get("id", "")
            })
        filtered_result = json.dumps({
            "_filtered": True,
            "_original_count": len(context_items),
            "top_matches": summary_items
        })

output = {"ok": True}
if persisted:
    output["persisted"] = True
    output["memory_id"] = memory_id
if filtered_result:
    output["filtered_result"] = filtered_result

print(json.dumps(output))
sys.exit(0)
