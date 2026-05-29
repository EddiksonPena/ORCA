import test from "node:test";
import assert from "node:assert/strict";

import {
  ValidationError,
  isMemoryScope,
  parseCompactConversationRequest,
  parseIngestMemoryRequest,
  parseRecallMemoryRequest,
} from "./index.js";

test("memory scopes include harness-friendly project, skill, session, and user-profile scopes", () => {
  assert.equal(isMemoryScope("user-profile"), true);
  assert.equal(isMemoryScope("project:Orca-copy"), true);
  assert.equal(isMemoryScope("skill:typescript-review"), true);
  assert.equal(isMemoryScope("session:abc-123"), true);
  assert.equal(isMemoryScope("project:"), false);
  assert.equal(isMemoryScope("tenant with spaces"), false);
});

test("ingest validation rejects malformed payloads before persistence", () => {
  assert.deepEqual(parseIngestMemoryRequest({
    scope: "project:Orca-copy",
    source: "test",
    content: "Remember this product decision.",
    tags: ["product", ""],
    typeHint: "semantic",
  }), {
    scope: "project:Orca-copy",
    source: "test",
    content: "Remember this product decision.",
    tags: ["product"],
    typeHint: "semantic",
  });

  assert.throws(
    () => parseIngestMemoryRequest({ scope: "bad scope", source: "test", content: "x" }),
    ValidationError,
  );
  assert.throws(
    () => parseIngestMemoryRequest({ scope: "workspace", source: "test", content: "x", typeHint: "unknown" }),
    ValidationError,
  );
});

test("recall and compaction validation normalize optional fields", () => {
  assert.deepEqual(parseRecallMemoryRequest({
    query: "What did we decide?",
    scope: "user-profile",
    memoryTypes: ["semantic"],
    limit: 7,
    includeDiagnostics: true,
  }), {
    query: "What did we decide?",
    scope: "user-profile",
    memoryTypes: ["semantic"],
    limit: 7,
    includeDiagnostics: true,
  });

  assert.deepEqual(parseCompactConversationRequest({
    scope: "session:local-run",
    occupancyRatio: 0.8,
    messages: [{ role: "user", content: "Persist this conversation." }],
  }).messages, [{ role: "user", content: "Persist this conversation." }]);

  assert.throws(
    () => parseRecallMemoryRequest({ query: "x", limit: 0 }),
    ValidationError,
  );
  assert.throws(
    () => parseCompactConversationRequest({ scope: "workspace", messages: [{ role: "bad", content: "x" }] }),
    ValidationError,
  );
});
