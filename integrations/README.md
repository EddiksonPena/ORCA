# Orca Integrations

Orca works with **every major AI agent harness**. One MCP server, six adapters — same persistent memory everywhere.

## Architecture

```
integrations/
├── mcp-server/              ★ Canonical MCP server (one source of truth)
│   ├── server.py            FastMCP server exposing 6 tools
│   ├── pyproject.toml       uv-managed Python project
│   └── mcp_servers/         Auto-generated typed wrappers
│
├── adapters/                ★ Thin per-agent packages (~3 files each)
│   ├── hermes/              Hermes Agent (full lifecycle hooks + skill)
│   ├── claude-code/         Claude Code (Anthropic)
│   ├── codex/               Codex CLI (OpenAI)
│   ├── gemini-cli/          Gemini CLI (Google)
│   ├── opencode/            OpenCode
│   └── cursor/              Cursor IDE
│
└── README.md                ← You are here
```

Every adapter points to the same `mcp-server/` via a relative path. No duplication, no drift.

## Tools Exposed (all 6 adapters)

| Tool | Description |
|------|-------------|
| `orca_health` | Check if Orca is reachable |
| `orca_remember` | Store a fact, decision, or discovery |
| `orca_recall` | Semantic search across all memory |
| `orca_compact` | Compress conversation into durable memory |
| `orca_feedback` | Reinforce or demote a memory |
| `orca_list` | List all memories, optionally by scope |

## Install by Agent

### Hermes Agent
```bash
hermes plugin install ./integrations/adapters/hermes/
```
Auto-discovers MCP server, installs skill, registers 4 lifecycle hooks.

### Claude Code
```bash
cp integrations/adapters/claude-code/.mcp.json ./
cp integrations/adapters/claude-code/CLAUDE.md ./
```
Claude auto-discovers `.mcp.json` on next launch.

### Codex CLI
```bash
cp integrations/adapters/codex/codex.yaml .codex.yaml
cp integrations/adapters/codex/orca-memory.md ./
```

### Gemini CLI
```bash
mkdir -p ~/.gemini
cp integrations/adapters/gemini-cli/settings.json ~/.gemini/
cp integrations/adapters/gemini-cli/GEMINI.md ./
```

### OpenCode
```bash
cp integrations/adapters/opencode/opencode.json ./
cp integrations/adapters/opencode/AGENTS.md ./
```

### Cursor
```bash
mkdir -p .cursor
cp integrations/adapters/cursor/mcp.json .cursor/
```
Restart Cursor after copying. Rules auto-apply from `.cursor/rules/`.

## Prerequisites

1. **Orca running:** `docker compose up -d` from monorepo root
2. **Dependencies:** `cd integrations/mcp-server && uv sync`
3. **Python ≥ 3.11** with `uv` installed

## Shared Resources

- `shared/skill-templates/` — Markdown templates for authoring agent skills
- `shared/scripts/` — Utilities (MCP wrapper generator, config validators)
