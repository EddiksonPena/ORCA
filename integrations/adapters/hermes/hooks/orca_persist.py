#!/usr/bin/env python3
"""
session_end hook: persist full conversation to Orca.
Receives: {session_id, message_count, messages, recalls_made, tools_used, ...}
Compacts entire session into durable memory + sends feedback on all recalls.
"""
import json
import os
import sys
import urllib.request
import urllib.error

ORCA_URL = os.environ.get("ORCA_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
ORCA_API_KEY = os.environ.get("ORCA_API_KEY", "").strip()


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

session_id = ctx.get("session_id", "unknown")
messages = ctx.get("messages", [])
message_count = ctx.get("message_count", len(messages))
recalls_made = ctx.get("recalls_made", [])

persisted = 0
feedbacks_sent = 0

# Compact full session to durable memory
if messages:
    compact_payload = {
        "scope": "workspace",
        "occupancyRatio": 1.0,
        "sessionId": session_id,
        "messages": messages[-60:]  # Last 60 messages — captures the session
    }

    try:
        req = urllib.request.Request(
            f"{ORCA_URL}/v1/memories/compact",
            data=json.dumps(compact_payload).encode(),
            headers=headers(), method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        if data.get("triggered"):
            promoted = data.get("promoted", {})
            persisted = sum(len(v) for v in promoted.values())
    except Exception as e:
        # Best-effort — log failure but don't crash
        pass
else:
    # No messages to compact — store a session marker
    try:
        req = urllib.request.Request(
            f"{ORCA_URL}/v1/memories/ingest",
            data=json.dumps({
                "scope": "workspace",
                "source": f"hermes-agent",
                "tags": ["session-end", "marker"],
                "content": f"Session {session_id} ended — {message_count} messages"
            }).encode(),
            headers=headers(), method="POST"
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
            if data.get("accepted"):
                persisted = 1
    except Exception:
        pass

# Send feedback on recalls
for recall in recalls_made:
    try:
        art_id = recall.get("artifact_id", "")
        useful = recall.get("useful", True)
        if not art_id:
            continue
        req = urllib.request.Request(
            f"{ORCA_URL}/v1/memories/feedback",
            data=json.dumps({"artifactId": art_id, "useful": useful}).encode(),
            headers=headers(), method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            fb = json.loads(resp.read())
            if fb.get("updated"):
                feedbacks_sent += 1
    except Exception:
        pass

output = {
    "ok": True,
    "triggered": True,
    "persisted_count": persisted,
    "feedbacks_sent": feedbacks_sent,
    "note": f"Session {session_id} persisted: {persisted} memories promoted, {feedbacks_sent} feedbacks sent, {message_count} messages."
}

print(json.dumps(output))
sys.exit(0)
