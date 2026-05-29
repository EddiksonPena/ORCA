#!/usr/bin/env python3
"""Embedding model benchmark for Orca/ollama-cloud.

Compares: nomic-embed-text, mxbai-embed-large, bge-large, all-minilm
Metrics: throughput (emb/sec), latency (ms/emb), retrieval accuracy (MRR, NDCG@5)
"""
import json, time, statistics, httpx, sys, os
from pathlib import Path

OLLAMA = "http://localhost:11434"
MODELS = ["nomic-embed-text", "mxbai-embed-large", "bge-large", "all-minilm"]
PERSIST_FILE = Path(os.environ.get(
    "ORCA_DATA",
    "/home/eddiksonpena/projects/orca/data/orca-memory-os.json"
))
OUTPUT = Path("/home/eddiksonpena/projects/orca/data/benchmark-results.json")

def cosine(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    na = (sum(x*x for x in a)) ** 0.5
    nb = (sum(y*y for y in b)) ** 0.5
    return dot / (na*nb) if na and nb else 0

def load_test_data():
    """Extract 10 content+query pairs from Orca memories."""
    data = json.loads(PERSIST_FILE.read_text())
    pairs = []
    artifacts = [a for a in data["artifacts"] if a["type"] == "semantic" and a["content"]]
    for a in artifacts[:10]:
        content = a["content"]
        # Derive a query by extracting the first sentence or using a summary
        query = a.get("summary", content)[:120]
        if query == content[:120]:
            # Use first sentence as query
            query = content.split(".")[0] + "."
        pairs.append({
            "id": a["id"],
            "content": content,
            "query": query,
            "tags": a.get("tags", []),
            "scope": a["scope"],
            "confidence": a["confidence"],
        })
    return pairs


def benchmark_model(model_name, pairs):
    """Run full benchmark for one model."""
    results = {
        "model": model_name,
        "latencies_ms": [],
        "throughput": 0,
        "mrr": 0,
        "ndcg5": 0,
        "embedding_dim": 0,
        "total_time_s": 0,
        "errors": 0,
    }

    # Warmup
    print(f"    warmup {model_name}...")
    try:
        resp = httpx.post(f"{OLLAMA}/api/embeddings",
            json={"model": model_name, "prompt": "warmup"},
            timeout=60)
        resp.raise_for_status()
    except Exception as e:
        results["errors"] = 99
        print(f"      ✗ failed: {e}")
        return results

    latencies = []
    all_embeddings = {}
    t0 = time.time()

    # Embed each query
    for i, pair in enumerate(pairs):
        t1 = time.time()
        try:
            resp = httpx.post(f"{OLLAMA}/api/embeddings",
                json={"model": model_name, "prompt": pair["query"]},
                timeout=60)
            resp.raise_for_status()
            emb = resp.json()["embedding"]
            all_embeddings[pair["id"]] = emb
            if i == 0:
                results["embedding_dim"] = len(emb)
        except Exception as e:
            results["errors"] += 1
            all_embeddings[pair["id"]] = []
            print(f"      ⚠ error on {pair['id'][:8]}: {e}")
        latencies.append((time.time() - t1) * 1000)

    results["total_time_s"] = time.time() - t0
    results["latencies_ms"] = latencies
    results["throughput"] = len(pairs) / results["total_time_s"] if results["total_time_s"] > 0 else 0

    # Retrieval accuracy: treat each query as searching for its own content
    # For each pair, rank all contents by cosine similarity and measure MRR + NDCG@5
    rr_scores = []
    ndcg_scores = []

    # Pre-embed all content for this model
    content_embs = {}
    print(f"    embedding {len(pairs)} contents...")
    for pair in pairs:
        try:
            resp = httpx.post(f"{OLLAMA}/api/embeddings",
                json={"model": model_name, "prompt": pair["content"]},
                timeout=60)
            resp.raise_for_status()
            content_embs[pair["id"]] = resp.json()["embedding"]
        except:
            content_embs[pair["id"]] = []

    for pair in pairs:
        q_emb = all_embeddings.get(pair["id"], [])
        if not q_emb:
            continue

        # Score all contents against this query
        scores = []
        for cid, c_emb in content_embs.items():
            if not c_emb:
                continue
            scores.append((cid, cosine(q_emb, c_emb)))

        # Sort by score descending
        scores.sort(key=lambda x: -x[1])
        ranks = {cid: i+1 for i,(cid,_) in enumerate(scores)}

        # Reciprocal rank
        rank = ranks.get(pair["id"], len(scores))
        rr_scores.append(1.0 / rank)

        # NDCG@5
        top5 = scores[:5]
        relevance = [1.0 if cid == pair["id"] else 0.0 for cid,_ in top5]
        dcg = sum(rel / (__import__('math').log2(i+2)) for i,rel in enumerate(relevance))
        ideal = 1.0 / __import__('math').log2(2)  # ideal: relevant at position 1
        ndcg_scores.append(dcg / ideal if ideal else 0)

    results["mrr"] = statistics.mean(rr_scores) if rr_scores else 0
    results["ndcg5"] = statistics.mean(ndcg_scores) if ndcg_scores else 0
    results["latency_mean_ms"] = statistics.mean(latencies) if latencies else 0
    results["latency_median_ms"] = statistics.median(latencies) if latencies else 0
    results["latency_p95_ms"] = statistics.quantiles(latencies, n=20)[-1] if latencies else 0

    return results


def main():
    print("═" * 60)
    print("  Embedding Model Benchmark — Orca / ollama-cloud")
    print("═" * 60)

    pairs = load_test_data()
    print(f"Test dataset: {len(pairs)} query-content pairs from Orca\n")

    all_results = []
    for model in MODELS:
        print(f"≡ {model}")
        try:
            r = benchmark_model(model, pairs)
            all_results.append(r)
            dim = r.get("embedding_dim", "?")
            err = r["errors"]
            print(f"    ✓ {r['throughput']:.1f} emb/s | "
                  f"{r['latency_mean_ms']:.0f}ms avg | "
                  f"MRR={r['mrr']:.4f} | NDCG@5={r['ndcg5']:.4f} | "
                  f"dim={dim} | errs={err}\n")
        except Exception as e:
            print(f"    ✗ FAILED: {e}\n")
            all_results.append({"model": model, "errors": 99, "error": str(e)})

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(all_results, indent=2))
    print(f"Results saved → {OUTPUT}")

    # Rank
    ranked = sorted(all_results, key=lambda x: x.get("mrr", 0), reverse=True)
    print("\n══ Ranking (by MRR) ══")
    for i, r in enumerate(ranked):
        label = "⭐" if i == 0 else "  "
        print(f"  {label} #{i+1} {r['model']:25s}  "
              f"MRR={r.get('mrr',0):.4f}  NDCG5={r.get('ndcg5',0):.4f}  "
              f"{r.get('latency_mean_ms',0):.0f}ms  "
              f"{r.get('throughput',0):.1f}emb/s  "
              f"dim={r.get('embedding_dim','?')}")

    # Recommendation
    best = next((r for r in ranked if r.get("errors", 99) < 99 and r.get("mrr", 0) > 0), None)
    if best:
        rec = f"RECOMMENDATION: Use '{best['model']}' — MRR={best['mrr']:.4f}, {best['latency_mean_ms']:.0f}ms avg"
        print(f"\n  {rec}")
        OUTPUT.with_suffix(".recommendation.txt").write_text(rec + "\n")


if __name__ == "__main__":
    main()
