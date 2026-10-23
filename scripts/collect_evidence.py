"""Proof-of-work: real API payloads for the marketing shots.

Asks the questions the listing claims the bot handles, records the exact answers,
citations and measured latency, and writes them to docs/shots/evidence.json.
Nothing here is typed by hand — every string comes out of the running server.
"""
import json
import os
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3002"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/shots/evidence.json"

QUESTIONS = [
    "What is the refund window?",
    "How much is express shipping?",
    "Who won the 1998 World Cup?",
]


def post(path, payload):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    start = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.loads(res.read())
    return body, time.perf_counter() - start


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as res:
        return json.loads(res.read())


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    runs = []
    for question in QUESTIONS:
        answer, elapsed = post("/api/chat", {"question": question})
        runs.append({"question": question, "elapsed_s": round(elapsed, 4), **answer})
        print(f"[{elapsed:.3f}s] {question}")

    docs = get("/api/docs")
    logs = get("/api/logs")

    evidence = {
        "base_url": BASE,
        "engine": runs[0].get("engine"),
        "model": runs[0].get("model"),
        "documents": len(docs.get("docs", [])),
        "document_names": [d["name"] for d in docs.get("docs", [])],
        "chunks": sum(d.get("chunkCount", 0) for d in docs.get("docs", [])),
        "store_kind": docs.get("kind"),
        "runs": runs,
        "log_summary": logs.get("summary"),
    }

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, indent=2, ensure_ascii=False)

    latencies = [r["elapsed_s"] for r in runs]
    print()
    print(f"documents: {evidence['documents']}  chunks: {evidence['chunks']}")
    print(f"latency: min {min(latencies):.3f}s  max {max(latencies):.3f}s")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
