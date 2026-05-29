"""
Orca Memory OS — Hermes plugin.
Captures every conversation turn, every tool call, and makes it semantically
retrievable across sessions. No subprocess overhead — all hooks run in-process.

Hooks registered:
  pre_llm_call    — inject recalled context + capture conversation_history
  post_tool_call  — persist tool calls to Orca as episodic memories
  post_llm_call   — compact entire turn into durable memory
  on_session_start — validate connectivity, recall user/project context
  on_session_end   — final persist + feedback on all recalls
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

ORCA_URL = os.environ.get("ORCA_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
ORCA_API_KEY = os.environ.get("ORCA_API_KEY", "").strip()
REQUEST_TIMEOUT = 8.0
MAX_PERSIST_MSG_CHARS = 600
SKIP_TOOLS = {"memory", "clarify", "todo", "session_search", "skills_list",
              "skills_view", "skill_manage", "cronjob", "send_message"}
MCP_CHRONO_TOOLS = {"mcp_orca_health", "mcp_orca_remember",
                    "mcp_orca_recall", "mcp_orca_compact",
                    "mcp_orca_feedback", "mcp_orca_list"}


def _post_json(client: httpx.Client, path: str, body: dict, timeout: float = REQUEST_TIMEOUT) -> Optional[dict]:
    try:
        headers = {"x-api-key": ORCA_API_KEY} if ORCA_API_KEY else None
        resp = client.post(f"{ORCA_URL}{path}", json=body, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def _get_json(client: httpx.Client, path: str, timeout: float = REQUEST_TIMEOUT) -> Optional[dict]:
    try:
        headers = {"x-api-key": ORCA_API_KEY} if ORCA_API_KEY else None
        resp = client.get(f"{ORCA_URL}{path}", headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def _tool_summary(tool_name: str, args: dict, result: Any) -> str:
    """Build a compact, human-readable tool call summary."""
    parts = [f"[{tool_name}]"]
    if isinstance(args, dict):
        safe = []
        for k in ("command", "path", "pattern", "query", "content", "url", "name"):
            v = args.get(k)
            if v and k not in ("api_key", "token", "password", "secret"):
                safe.append(f"{k}={str(v)[:80]}")
        if safe:
            parts.append(", ".join(safe[:3]))
    try:
        r = json.loads(result) if isinstance(result, str) else result
    except (json.JSONDecodeError, TypeError):
        r = {}
    if isinstance(r, dict):
        if "exit_code" in r:
            parts.append(f"→ exit={r['exit_code']}")
        elif "error" in r:
            parts.append(f"→ ERROR: {str(r['error'])[:100]}")
        elif "status" in r:
            parts.append(f"→ {r['status']}")
        elif "accepted" in r:
            parts.append("→ ok")
    else:
        parts.append(f"→ {str(result)[:80]}")
    return " ".join(parts)


def _extract_dialog(conversation_history: list) -> str:
    """Extract user/assistant turns from conversation history."""
    lines = []
    for msg in conversation_history:
        role = msg.get("role", "?")
        if role in ("user", "assistant"):
            content = str(msg.get("content", ""))[:MAX_PERSIST_MSG_CHARS]
            if content.strip():
                lines.append(f"{role}: {content.strip()}")
    return "\n".join(lines)


def _detect_project(session_id: str, cwd: str) -> Optional[str]:
    if "/projects/" in cwd:
        parts = cwd.split("/projects/")[-1].split("/")[0]
        if parts:
            return parts
    return None


# ═══════════════════════════════════════════════════════════════
# Hooks
# ═══════════════════════════════════════════════════════════════

def _on_session_start(
    session_id: str,
    model: str = "",
    platform: str = "",
    **kwargs,
) -> None:
    """Validate Orca connectivity + recall user/project context."""
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            health = _get_json(client, "/health")
            if health and health.get("status") == "ok":
                mem = health.get("memory", {})
                logger.info("Orca OK — %s artifacts", mem.get("artifactCount", "?"))
            else:
                logger.warning("Orca unavailable at session start")
    except Exception:
        pass


def _on_session_end(
    session_id: str,
    completed: bool = False,
    interrupted: bool = False,
    model: str = "",
    platform: str = "",
    **kwargs,
) -> None:
    """Mark session end in Orca."""
    if not completed or interrupted:
        return
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            _post_json(client, "/v1/memories/ingest", {
                "scope": "workspace",
                "source": f"hermes-agent:{platform}",
                "tags": ["session-end", "marker"],
                "content": f"Session {session_id} completed on {platform}"
            })
    except Exception:
        pass


def _pre_llm_call(
    session_id: str,
    user_message: str,
    conversation_history: list,
    is_first_turn: bool,
    model: str = "",
    platform: str = "",
    **kwargs,
) -> Optional[str]:
    """
    Inject recalled context from Orca + capture conversation state.
    Returns context string to inject into the user message.
    """
    recalls = []
    dialog = _extract_dialog(conversation_history) if conversation_history else ""

    # On first turn, recall user profile + project conventions
    if is_first_turn:
        try:
            with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
                # User profile
                data = _post_json(client, "/v1/memories/recall", {
                    "query": "user preferences, tools, conventions, style",
                    "scope": "user-profile",
                    "includeDiagnostics": False
                })
                if data:
                    items = data.get("context", [])
                    if items:
                        recalls.append(f"[user-profile] {items[0].get('content', '')[:250]}")
        except Exception:
            pass

        try:
            # Project conventions (detect from cwd via conversation)
            project = None
            for msg in conversation_history or []:
                c = str(msg.get("_cwd", ""))
                proj = _detect_project(session_id, c)
                if proj:
                    project = proj
                    break
            if project:
                with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
                    data = _post_json(client, "/v1/memories/recall", {
                        "query": f"conventions and decisions for {project}",
                        "scope": f"project:{project}",
                        "includeDiagnostics": False
                    })
                    if data:
                        items = data.get("context", [])
                        if items:
                            recalls.append(f"[project:{project}] {items[0].get('content', '')[:250]}")
        except Exception:
            pass

    # If we have prior conversation to persist, do it
    if dialog and not is_first_turn:
        try:
            with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
                _post_json(client, "/v1/memories/compact", {
                    "scope": "workspace",
                    "occupancyRatio": 1.0,
                    "sessionId": session_id,
                    "messages": conversation_history[-20:]  # compact last 20
                })
        except Exception:
            pass

    if recalls:
        return "Recalled from Orca:\n" + "\n".join(recalls)
    return None


def _post_tool_call(
    tool_name: str,
    args: dict | None = None,
    result: str = "",
    task_id: str = "",
    duration_ms: int = 0,
    **kwargs,
) -> None:
    """Capture every tool call to Orca as an episodic memory."""
    if tool_name in SKIP_TOOLS or tool_name in MCP_CHRONO_TOOLS:
        return
    summary = _tool_summary(tool_name, args or {}, result)
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            _post_json(client, "/v1/memories/ingest", {
                "scope": "workspace",
                "source": f"hermes-agent:{task_id}",
                "tags": ["tool-call", tool_name],
                "content": summary
            })
    except Exception:
        pass  # Best-effort


def _post_llm_call(
    session_id: str,
    user_message: str,
    assistant_response: str,
    conversation_history: list,
    model: str = "",
    platform: str = "",
    **kwargs,
) -> None:
    """After a completed turn, persist the dialog to Orca."""
    if not assistant_response or not conversation_history:
        return
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            _post_json(client, "/v1/memories/compact", {
                "scope": "workspace",
                "occupancyRatio": 1.0,
                "sessionId": session_id,
                "messages": conversation_history[-30:]  # last 30 messages
            })
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════
# Plugin entry point
# ═══════════════════════════════════════════════════════════════

def register(ctx) -> None:
    """Register all Orca hooks. Called once by the plugin loader."""
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
    logger.info("Orca plugin registered — 5 hooks active")
