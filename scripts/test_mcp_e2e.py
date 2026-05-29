#!/usr/bin/env python3
"""E2E test: MCP server from new monorepo path."""
import subprocess, json, sys, time, select

proc = subprocess.Popen(
    ["uv", "run", "--directory",
     "/home/eddiksonpena/projects/orca/integrations/mcp-server",
     "python", "server.py"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True, bufsize=0
)

def read_line():
    while True:
        if select.select([proc.stdout], [], [], 3)[0]:
            line = proc.stdout.readline()
            if line.strip():
                return line.strip()
        else:
            raise TimeoutError("No response")

# Drain stderr banner
import threading
def drain():
    while True:
        line = proc.stderr.readline()
        if not line:
            break

err_thread = threading.Thread(target=drain, daemon=True)
err_thread.start()

# Init
init = json.dumps({"jsonrpc":"2.0","id":"1","method":"initialize",
    "params":{"protocolVersion":"2024-11-05","capabilities":{},
    "clientInfo":{"name":"e2e","version":"1"}}})
proc.stdin.write(init + "\n"); proc.stdin.flush()

try:
    line = read_line()
    data = json.loads(line)
    print(f"✓ init: id={data.get('id')}")
except Exception as e:
    print(f"✗ init failed: {e}")

# Notify
notify = json.dumps({"jsonrpc":"2.0","method":"notifications/initialized"})
proc.stdin.write(notify + "\n"); proc.stdin.flush()

# List tools
lt = json.dumps({"jsonrpc":"2.0","id":"2","method":"tools/list"})
proc.stdin.write(lt + "\n"); proc.stdin.flush()

try:
    line = read_line()
    data = json.loads(line)
    tools = data["result"]["tools"]
    print(f"✓ tools/list: {len(tools)} tools")
    for t in tools:
        print(f"    {t['name']}")
except Exception as e:
    print(f"✗ tools/list failed: {e}")

proc.terminate()
proc.wait(timeout=3)
