#!/usr/bin/env python3
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

def _tokenize(value: str) -> list[str]:
    return [token for token in ''.join(ch.lower() if ch.isalnum() else ' ' for ch in value).split() if token]


def _emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.exit(exit_code)


def _parse_iso8601(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)

    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return datetime.now(timezone.utc)


async def _run() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        _emit({"ok": False, "error": "No JSON request received."}, 1)

    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        _emit({"ok": False, "error": f"Invalid JSON input: {exc}"}, 1)

    try:
        from graphiti_core import Graphiti
        from graphiti_core.cross_encoder.client import CrossEncoderClient
        from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
        from graphiti_core.llm_client.config import LLMConfig
        from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
        from graphiti_core.nodes import EpisodeType
    except Exception as exc:  # pragma: no cover - depends on local runtime
        _emit(
            {
                "ok": False,
                "error": "graphiti_core is not installed or failed to import. "
                f"Install graphiti-core to enable the Graphiti bridge. ({exc})",
            },
            1,
        )

    ollama_host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
    ollama_base_url = (
        ollama_host.rstrip("/")
        if ollama_host.rstrip("/").endswith("/v1")
        else f"{ollama_host.rstrip('/')}/v1"
    )
    ollama_api_key = os.environ.get("OLLAMA_API_KEY", "orca-local")
    llm_model = os.environ.get("GRAPHITI_LLM_MODEL", os.environ.get("EXTRACTION_MODEL", "qwen2.5:14b"))
    embedding_model = os.environ.get("GRAPHITI_EMBEDDING_MODEL", "nomic-embed-text")

    llm_config = LLMConfig(
        api_key=ollama_api_key,
        model=llm_model,
        small_model=llm_model,
        base_url=ollama_base_url,
        temperature=0,
        max_tokens=4096,
    )
    llm_client = OpenAIGenericClient(config=llm_config, max_tokens=4096)
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            api_key=ollama_api_key,
            embedding_model=embedding_model,
            base_url=ollama_base_url,
        )
    )

    class LocalOverlapReranker(CrossEncoderClient):
        async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
            query_tokens = set(_tokenize(query))
            if not query_tokens:
                return [(passage, 0.0) for passage in passages]

            ranked: list[tuple[str, float]] = []
            for passage in passages:
                passage_tokens = set(_tokenize(passage))
                overlap = len(query_tokens & passage_tokens)
                score = overlap / max(len(query_tokens), 1)
                ranked.append((passage, score))

            ranked.sort(key=lambda item: item[1], reverse=True)
            return ranked

    cross_encoder = LocalOverlapReranker()

    graphiti = Graphiti(
        request["neo4jUri"],
        request["neo4jUser"],
        request["neo4jPassword"],
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=cross_encoder,
    )

    try:
        await graphiti.build_indices_and_constraints()
        command = request["command"]
        group_id = request["groupId"]
        payload = request["payload"]

        if command == "upsert_episode":
            episodes_written = 0
            for chunk in payload.get("chunks", []):
                await graphiti.add_episode(
                    name=chunk["artifactId"],
                    episode_body=chunk["content"],
                    source=EpisodeType.text,
                    source_description=chunk.get("sourceDescription", "orca episodic ingest"),
                    reference_time=_parse_iso8601(chunk.get("observedAt")),
                    group_id=group_id,
                )
                episodes_written += 1

            _emit({"ok": True, "result": {"episodesWritten": episodes_written}})

        if command == "search":
            query = str(payload.get("query", "")).strip()
            if not query:
                _emit({"ok": True, "result": []})

            limit = int(payload.get("limit", 8))
            results = await graphiti.search(query=query, group_ids=[group_id])
            shaped: list[dict[str, Any]] = []
            for result in list(results)[:limit]:
                shaped.append(
                    {
                        "uuid": getattr(result, "uuid", None),
                        "name": getattr(result, "name", None),
                        "fact": getattr(result, "fact", "") or getattr(result, "summary", ""),
                    }
                )

            _emit({"ok": True, "result": shaped})

        _emit({"ok": False, "error": f"Unsupported command: {command}"}, 1)
    finally:
        await graphiti.close()


if __name__ == "__main__":
    asyncio.run(_run())
