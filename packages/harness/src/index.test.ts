import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { EnforcedMemoryHarness } from "./index.js";

const withServer = async (
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
};

test("enforced harness injects recalled memory and ingests completed turns", async () => {
  const calls: string[] = [];

  await withServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");

    if (req.url === "/v1/memories/recall") {
      res.end(JSON.stringify({
        query: "q",
        context: [{
          id: "memory-1",
          type: "semantic",
          scope: "workspace",
          content: "The project uses Orca as mandatory memory middleware.",
          confidence: 0.8,
          tags: ["architecture"],
          provenance: {
            source: "test",
            observedAt: "2026-01-01T00:00:00.000Z",
            ingestedAt: "2026-01-01T00:00:00.000Z",
          },
          linkedArtifactIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
        candidates: [],
      }));
      return;
    }

    if (req.url === "/v1/memories/ingest") {
      res.statusCode = 202;
      res.end(JSON.stringify({
        memoryId: "turn-1",
        accepted: true,
        deduplicated: false,
        artifactsCreated: 1,
        chunksCreated: 1,
        entitiesExtracted: 0,
        storedIn: ["state-store"],
      }));
      return;
    }

    res.end(JSON.stringify({ status: "ok" }));
  }, async (baseUrl) => {
    const harness = new EnforcedMemoryHarness({
      baseUrl,
      defaultScope: "workspace",
      required: true,
      failureMode: "block",
    });

    const before = await harness.beforePrompt({
      sessionId: "test-session",
      prompt: "How should memory be wired?",
      messages: [{ role: "user", content: "How should memory be wired?" }],
    });

    assert.equal(before.memories.length, 1);
    assert.equal(before.messages[0]?.role, "system");
    assert.match(String(before.messages[0]?.content), /mandatory memory middleware/);

    const ingest = await harness.afterResponse({
      sessionId: "test-session",
      prompt: "How should memory be wired?",
      response: "Use Orca before and after each turn.",
    });

    assert.equal(ingest?.accepted, true);
    assert.ok(calls.some((call) => call === "POST /v1/memories/recall"));
    assert.ok(calls.some((call) => call === "POST /v1/memories/ingest"));
  });
});
