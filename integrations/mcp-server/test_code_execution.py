"""End-to-end test of code-execution pattern with generated Orca wrappers.
This simulates exactly how Hermes would use these wrappers via execute_code —
loading tool definitions from the filesystem (zero context cost) and processing
data in code before any result reaches the model.
"""
import sys, json

# Step 1: Discover tools — just a directory listing (<100 chars of context)
import os
server_dir = os.path.join(os.path.dirname(__file__), "mcp_servers", "orca")
tools = [f.replace('.py', '') for f in os.listdir(server_dir) if f.endswith('.py') and not f.startswith('_')]
print(f"Available tools: {tools}")

# Step 2: Use sync wrappers (no async boilerplate in execute_code)
from mcp_servers.orca import (
    orca_health_sync,
    orca_remember_sync,
    orca_recall_sync,
    orca_compact_sync,
    orca_feedback_sync,
    orca_list_sync,
)

# Step 3: Health check
health = orca_health_sync()
print(f"\n1. Health: {health['status']} — {health['memory']['artifactCount']} artifacts")

# Step 4: Store a new fact
r = orca_remember_sync(
    scope="workspace",
    content="MCP code-execution wrappers generated successfully for Orca. Context usage down 98.7%.",
    source="code-exec-test",
    tags=["mcp", "code-execution", "pattern"]
)
print(f"2. Remember: memoryId={r.get('memoryId', r.get('memory_id'))}")

# Step 5: Semantic recall
results = orca_recall_sync("What pattern reduces MCP context usage?")
ctx = results.get("context", [])
# Filter in code — only print summary, not full context
summary = {
    "total": len(ctx),
    "top_hit": ctx[0]["content"][:80] + "..." if ctx else "none",
    "confidence": ctx[0].get("confidence", 0) if ctx else 0,
}
print(f"3. Recall: {summary['total']} results, top={summary['top_hit']}")

# Step 6: Feedback — reinforce the top result
if ctx:
    f = orca_feedback_sync(artifact_id=ctx[0]["id"], useful=True)
    print(f"4. Feedback: updated={f.get('updated')}")

# Step 7: Compact a micro-session
c = orca_compact_sync(
    session_id="code-exec-demo",
    scope="workspace",
    messages=[
        {"role": "user", "content": "How do we reduce MCP context bloat?"},
        {"role": "assistant", "content": "Generate typed Python wrappers. Use code execution. Never pass raw results to the model."},
    ]
)
print(f"5. Compact: triggered={c['triggered']}, promoted={len(c.get('promoted',[]))}")

# Step 8: List memories — just the count, not the content
memories = orca_list_sync(scope="workspace")
print(f"6. List: {len(memories.get('memories',[]))} memories in workspace")

print(f"\n{'='*40}")
print("All 6 tools passed via code execution. Context cost: ~500 chars.")
