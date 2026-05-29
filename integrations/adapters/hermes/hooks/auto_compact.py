#!/usr/bin/env python3
"""
Context pressure hook: auto-compact conversation to Orca when occupancy exceeds 70%.
Receives: {occupancy_ratio, session_id, messages, ...}
Compacts actual conversation messages into Orca's durable memory.
"""
import json
import os
import sys
import urllib.request
import urllib.error

ORCA_URL = os.environ.get("ORCA_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
ORCA_API_KEY = os.environ.get("ORCA_API_KEY", "").strip()
COMPACT_THRESHOLD = 0.70


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

occupancy = ctx.get("occupancy_ratio", 0)
session_id = ctx.get("session_id", "unknown")
messages = ctx.get("messages", [])
threshold = ctx.get("threshold", COMPACT_THRESHOLD)

if occupancy < threshold:
    print(json.dumps({"ok": True, "triggered": False, "reason": f"occupancy {occupancy:.2f} < threshold {threshold}"}))
    sys.exit(0)

# Build summary of what's being compacted
message_count = len(messages)
preview = " ".join(m.get("content", "")[:200] for m in messages[-6:]) if messages else "empty conversation"

compact_payload = {
    "scope": "workspace",
    "occupancyRatio": occupancy,
    "sessionId": session_id,
    "messages": messages[-40:]  # Last 40 messages to keep payload reasonable
}

try:
    req = urllib.request.Request(
        f"{ORCA_URL}/v1/memories/compact",
        data=json.dumps(compact_payload).encode(),
        headers=headers(), method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())

    output = {
        "ok": True,
        "triggered": data.get("triggered", False),
        "compacted_summary": data.get("workingSummary", f"Context compacted at {occupancy:.0%} occupancy."),
        "open_loops": data.get("openLoops", []),
        "promoted": data.get("promoted", {}),
        "stats": {
            "messages_compacted": message_count,
            "occupancy_before": occupancy,
            "preview": preview[:200]
        }
    }
    print(json.dumps(output))
    sys.exit(0)

except Exception as e:
    print(json.dumps({
        "ok": True,
        "triggered": False,
        "note": f"Auto-compact skipped (Orca unavailable: {e})"
    }))
    sys.exit(0)
