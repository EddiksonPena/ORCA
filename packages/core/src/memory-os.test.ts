import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "@orca/config";

import { createMemoryOs } from "./index.js";

const createTestOs = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-test-"));
  const os = createMemoryOs(
    loadConfig({
      ...process.env,
      TEMPORAL_EXECUTION_MODE: "local",
      AUTO_TRIGGER_WORKFLOWS: "true",
      EMBEDDING_PROVIDER: "hash",
      EMBEDDING_DIMENSIONS: "16",
      MEMORY_DATA_DIR: dir,
      MEMORY_DATA_FILE: join(dir, "memory-os.json"),
    }),
  );

  return {
    dir,
    os,
  };
};

const createTestOsWithEnv = async (overrides: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), "orca-test-"));
  const os = createMemoryOs(
    loadConfig({
      ...process.env,
      TEMPORAL_EXECUTION_MODE: "local",
      AUTO_TRIGGER_WORKFLOWS: "true",
      EMBEDDING_PROVIDER: "hash",
      EMBEDDING_DIMENSIONS: "16",
      MEMORY_DATA_DIR: dir,
      MEMORY_DATA_FILE: join(dir, "memory-os.json"),
      ...overrides,
    }),
  );

  return {
    dir,
    os,
  };
};

test("ingest stores chunks and recall returns relevant context", async () => {
  const { dir, os } = await createTestOs();

  try {
    const ingest = await os.ingest({
      scope: "workspace",
      source: "uat",
      content:
        "Acme Research built a Memory OS control plane for agents. The Retrieval Orchestrator combines vector search, sparse retrieval, and graph traversal.",
      tags: ["architecture"],
    });

    assert.equal(ingest.accepted, true);
    assert.ok(ingest.chunksCreated >= 1);

    const deduped = await os.ingest({
      scope: "workspace",
      source: "uat",
      content:
        "Acme Research built a Memory OS control plane for agents. The Retrieval Orchestrator combines vector search, sparse retrieval, and graph traversal.",
      tags: ["architecture"],
    });

    assert.equal(deduped.deduplicated, true);

    const recall = await os.recall({
      query: "How does the Retrieval Orchestrator combine graph traversal and vector search?",
      scope: "workspace",
      includeDiagnostics: true,
    });

    assert.ok(recall.context.length >= 1);
    assert.match(recall.context[0]?.content ?? "", /Retrieval Orchestrator/i);
    assert.deepEqual(recall.diagnostics?.storesQueried, [
      "state-store",
      "working-memory",
      "semantic-store",
      "graph-store",
      "temporal-graph",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback updates salience and reindex recomputes graph state", async () => {
  const { dir, os } = await createTestOs();

  try {
    await os.ingest({
      scope: "agent",
      source: "runbook",
      content:
        "Workflow steps: open the Memory API, ingest the document, extract entities for Neo4j, and rerank the results before packaging context.",
    });

    const recall = await os.recall({
      query: "workflow rerank context",
      scope: "agent",
    });

    const artifactId = recall.context[0]?.id;
    assert.ok(artifactId);

    const feedback = await os.feedback({
      artifactId,
      useful: true,
    });

    assert.equal(feedback.updated, true);
    assert.ok(feedback.reinforcementCount >= 1);
    assert.ok(feedback.salience > 0.45);

    const reindex = await os.reindex();
    assert.equal(reindex.accepted, true);
    assert.ok(reindex.artifactsProcessed >= 2);

    const health = await os.getHealth();
    assert.equal(health.status, "ok");
    assert.ok(health.graphNodeCount >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow definitions expose module-specific maintenance pipelines", async () => {
  const { dir, os } = await createTestOs();

  try {
    const workflows = await os.getWorkflowDefinitions();

    assert.ok(workflows.length >= 6);
    assert.ok(workflows.some((workflow) => workflow.id === "episodic.temporal-link"));
    assert.ok(workflows.some((workflow) => workflow.id === "semantic.reembed"));
    assert.ok(workflows.some((workflow) => workflow.id === "procedural.normalize-traces"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow execution dispatches module maintenance jobs", async () => {
  const { dir, os } = await createTestOs();

  try {
    await os.ingest({
      scope: "workspace",
      source: "incident",
      typeHint: "episodic",
      content:
        "Incident event. Atlas Team met to review the Redis failover timeline and document the outage response sequence.",
    });

    const episodicResult = await os.executeWorkflow("episodic.temporal-link");
    assert.equal(episodicResult.executed, true);
    assert.match(episodicResult.details, /temporal links/i);
    assert.equal(episodicResult.mode, "local");

    const proceduralResult = await os.executeWorkflow("procedural.normalize-traces");
    assert.equal(proceduralResult.executed, true);

    const missingResult = await os.executeWorkflow("missing.workflow");
    assert.equal(missingResult.executed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ingest auto-triggers workflows and records run history", async () => {
  const { dir, os } = await createTestOs();

  try {
    await os.ingest({
      scope: "workspace",
      source: "auto-trigger",
      typeHint: "episodic",
      content: "Incident event. Atlas Team reviewed the timeline of the Redis outage.",
    });

    const runs = await os.getWorkflowRuns();
    assert.ok(runs.length >= 1);
    assert.ok(runs.some((run) => run.workflowId === "episodic.temporal-link"));
    assert.ok(runs.every((run) => run.status === "completed" || run.status === "scheduled"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("module metrics capture ingest, recall, feedback, and workflow activity", async () => {
  const { dir, os } = await createTestOs();

  try {
    await os.ingest({
      scope: "workspace",
      source: "metrics-smoke",
      typeHint: "episodic",
      content: "Incident event. Atlas Team documented the outage timeline and recovery sequence.",
    });

    const recall = await os.recall({
      query: "When did the outage timeline happen?",
      scope: "workspace",
      memoryTypes: ["episodic"],
    });

    const artifactId = recall.context[0]?.id;
    assert.ok(artifactId);

    await os.feedback({
      artifactId,
      useful: true,
    });

    const metrics = await os.getModuleMetrics();
    const episodic = metrics.find((module) => module.moduleId === "episodic");

    assert.ok(episodic);
    assert.equal(episodic.ingestCount, 1);
    assert.ok(episodic.artifactWriteCount >= 2);
    assert.ok(episodic.chunkWriteCount >= 1);
    assert.equal(episodic.recallQueryCount, 1);
    assert.ok(episodic.recallHitCount >= 1);
    assert.equal(episodic.feedbackCount, 1);
    assert.equal(episodic.positiveFeedbackCount, 1);
    assert.ok(episodic.workflowScheduledCount >= 1);
    assert.ok(episodic.workflowCompletedCount >= 1);
    assert.ok(episodic.averageIngestLatencyMs >= 0);
    assert.ok(episodic.averageRecallLatencyMs >= 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("graphiti-python backend degrades safely when Graphiti runtime is unavailable", async () => {
  const { dir, os } = await createTestOsWithEnv({
    TEMPORAL_GRAPH_BACKEND: "graphiti-python",
  });

  try {
    const ingest = await os.ingest({
      scope: "workspace",
      source: "graphiti-smoke",
      typeHint: "episodic",
      content: "Incident event. Atlas Team investigated the cache invalidation timeline in Redis.",
    });

    assert.equal(ingest.accepted, true);

    const recall = await os.recall({
      query: "What happened in the Redis cache invalidation timeline?",
      scope: "workspace",
      memoryTypes: ["episodic"],
    });

    assert.ok(recall.context.length >= 1);

    const workflow = await os.executeWorkflow("episodic.temporal-link");
    assert.equal(workflow.executed, true);
    assert.equal(workflow.mode, "local");
    assert.ok(workflow.backend === "graphiti-python" || workflow.backend === "neo4j-temporal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adaptive compaction promotes important conversation memory into modules", async () => {
  const { dir, os } = await createTestOs();

  try {
    const response = await os.compactConversation({
      scope: "workspace",
      sessionId: "session-1",
      occupancyRatio: 0.74,
      messages: [
        {
          role: "user",
          content:
            "We need to document the deployment rollback steps. Redis runs on port 6380 locally and should stay that way.",
        },
        {
          role: "assistant",
          content:
            "First inspect docker compose health, then restart the worker, then verify recall and metrics endpoints.",
        },
        {
          role: "user",
          content:
            "There is still a blocker: follow up on the unresolved auth rollout after deployment.",
        },
      ],
    });

    assert.equal(response.triggered, true);
    assert.ok(response.workingSummary.length > 0);
    assert.ok(response.openLoops.length >= 1);
    assert.ok(response.promoted.episodic.length >= 1);
    assert.ok(response.promoted.semantic.length >= 1);
    assert.ok(response.promoted.procedural.length >= 1);

    const memories = await os.listMemories("workspace");
    assert.ok(memories.some((artifact) => artifact.id === response.promoted.episodic[0]));
    assert.ok(memories.some((artifact) => artifact.id === response.promoted.semantic[0]));
    assert.ok(memories.some((artifact) => artifact.id === response.promoted.procedural[0]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adaptive compaction does not trigger below threshold unless forced", async () => {
  const { dir, os } = await createTestOs();

  try {
    const response = await os.compactConversation({
      scope: "workspace",
      occupancyRatio: 0.32,
      messages: [
        {
          role: "user",
          content: "Short check-in about the current task.",
        },
      ],
    });

    assert.equal(response.triggered, false);
    assert.equal(response.candidates.length, 0);
    assert.deepEqual(response.promoted, {
      episodic: [],
      semantic: [],
      procedural: [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory management can update, export, delete, and wipe scoped artifacts", async () => {
  const { dir, os } = await createTestOs();

  try {
    const ingest = await os.ingest({
      scope: "project:management-smoke",
      source: "management-test",
      typeHint: "semantic",
      content: "ManagementSmoke memory can be edited and exported.",
      tags: ["before"],
    });

    const memoriesBefore = await os.listMemories("project:management-smoke");
    const chunkId = memoriesBefore.find((artifact) => artifact.id !== ingest.memoryId)?.id;
    assert.ok(chunkId);

    const update = await os.updateMemory({
      artifactId: chunkId,
      tags: ["after"],
      salience: 0.91,
      metadata: { reviewed: true },
    });
    assert.equal(update.updated, true);

    const exported = await os.exportMemories("project:management-smoke");
    assert.ok(exported.artifacts.some((artifact) => artifact.tags.includes("after")));

    const deleted = await os.deleteMemory(chunkId);
    assert.ok(deleted.deleted >= 1);

    await os.ingest({
      scope: "project:management-smoke",
      source: "management-test",
      typeHint: "semantic",
      content: "ManagementSmoke scoped wipe target.",
      tags: ["wipe"],
    });

    const wipe = await os.wipeScope("project:management-smoke");
    assert.ok(wipe.deleted >= 1);

    const remaining = await os.listMemories("project:management-smoke");
    assert.equal(remaining.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
