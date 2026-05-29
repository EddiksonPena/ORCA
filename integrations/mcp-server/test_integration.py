"""End-to-end test of Orca MCP Server against live Orca."""
import asyncio, json, sys
from fastmcp import Client

async def test_all():
    ok = 0
    fail = 0

    async with Client("http://127.0.0.1:8000/mcp") as client:
        # 1 — Health
        try:
            r = await client.call_tool("orca_health", {})
            text = r.content[0].text if hasattr(r, 'content') else str(r)
            data = json.loads(text)
            assert data.get("status") == "ok", f"Bad status: {data}"
            print(f"✓ health — {data.get('memory',{}).get('artifactCount',0)} artifacts in store")
            ok += 1
        except Exception as e:
            print(f"✗ health — {e}")
            fail += 1

        # 2 — Remember
        try:
            r = await client.call_tool("orca_remember", {
                "scope": "user-profile",
                "content": "User Eddikson uses uv for Python package management and prefers ~/projects/ for all work.",
                "source": "mcp-end-to-end-test",
                "tags": ["tools", "environment"]
            })
            text = r.content[0].text
            data = json.loads(text)
            assert data.get("accepted") is True, f"Not accepted: {data}"
            art_id = data.get("memoryId")
            print(f"✓ remember — memoryId={art_id}, stored in {data.get('storedIn',[])}")
            ok += 1
        except Exception as e:
            print(f"✗ remember — {e}")
            fail += 1
            art_id = None

        # 3 — Recall
        try:
            r = await client.call_tool("orca_recall", {
                "query": "What package manager does the user use?",
                "scope": "user-profile"
            })
            text = r.content[0].text
            data = json.loads(text)
            ctx = data.get("context", [])
            found = any("uv" in (c.get("content","")).lower() or "package" in (c.get("content","")).lower() for c in ctx)
            print(f"✓ recall — {len(ctx)} results, uv match: {found}")
            ok += 1
            if ctx:
                recall_id = ctx[0].get("id")
            else:
                recall_id = None
        except Exception as e:
            print(f"✗ recall — {e}")
            fail += 1
            recall_id = None

        # 4 — Compact
        try:
            r = await client.call_tool("orca_compact", {
                "session_id": "mcp-test-session",
                "scope": "workspace",
                "messages": [
                    {"role": "user", "content": "I always use uv for Python projects."},
                    {"role": "assistant", "content": "Understood. I'll use uv and place everything in ~/projects/."}
                ]
            })
            text = r.content[0].text
            data = json.loads(text)
            assert data.get("triggered") is True, f"Not triggered: {data}"
            print(f"✓ compact — triggered, {len(data.get('promoted',[]))} memories promoted")
            ok += 1
        except Exception as e:
            print(f"✗ compact — {e}")
            fail += 1

        # 5 — List
        try:
            r = await client.call_tool("orca_list", {"scope": "user-profile"})
            text = r.content[0].text
            data = json.loads(text)
            mems = data.get("memories", [])
            print(f"✓ list — {len(mems)} memories in user-profile")
            ok += 1
        except Exception as e:
            print(f"✗ list — {e}")
            fail += 1

    print(f"\n{'='*40}")
    print(f"Results: {ok}/{ok+fail} passed")
    return 0 if fail == 0 else 1

sys.exit(asyncio.run(test_all()))
