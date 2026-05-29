import test from "node:test";
import assert from "node:assert/strict";

import type { MemoryHealth, ModuleObservabilitySnapshot } from "@orca/schemas";

import { renderModuleMetricsPrometheus } from "./prometheus.js";
import type { WorkflowRunRecord } from "./types.js";

test("renderModuleMetricsPrometheus formats module snapshots for scraping", () => {
  const modules: ModuleObservabilitySnapshot[] = [
    {
      moduleId: "episodic",
      artifactCount: 10,
      chunkCount: 5,
      ingestCount: 2,
      deduplicatedCount: 1,
      artifactWriteCount: 4,
      chunkWriteCount: 2,
      recallQueryCount: 3,
      recallHitCount: 7,
      feedbackCount: 1,
      positiveFeedbackCount: 1,
      workflowScheduledCount: 2,
      workflowCompletedCount: 2,
      workflowFailedCount: 0,
      averageIngestLatencyMs: 42,
      averageRecallLatencyMs: 18,
      lastActivityAt: "2026-04-22T16:00:00.000Z",
    },
  ];
  const memory: MemoryHealth = {
    status: "ok",
    persistenceFile: "/tmp/orca-memory-os.json",
    artifactCount: 17,
    chunkCount: 9,
    graphNodeCount: 13,
    graphEdgeCount: 21,
  };
  const runs: WorkflowRunRecord[] = [
    {
      id: "run-1",
      workflowId: "episodic.temporal-link",
      moduleId: "episodic",
      mode: "temporal",
      status: "completed",
      createdAt: "2026-04-22T16:00:00.000Z",
      updatedAt: "2026-04-22T16:00:01.000Z",
      details: "ok",
      backend: "neo4j-temporal",
      temporalWorkflowId: "orca-episodic.temporal-link-1",
    },
    {
      id: "run-2",
      workflowId: "episodic.temporal-link",
      moduleId: "episodic",
      mode: "temporal",
      status: "scheduled",
      createdAt: "2026-04-22T16:01:00.000Z",
      updatedAt: "2026-04-22T16:01:00.000Z",
      details: "scheduled",
      temporalWorkflowId: "orca-episodic.temporal-link-2",
    },
  ];

  const rendered = renderModuleMetricsPrometheus(modules, memory, runs, "memory-api");

  assert.match(rendered, /# HELP orca_memory_artifact_count/);
  assert.match(rendered, /orca_memory_artifact_count\{service="memory-api"\} 17/);
  assert.match(rendered, /# HELP orca_module_artifact_count/);
  assert.match(rendered, /orca_module_artifact_count\{module="episodic",service="memory-api"\} 10/);
  assert.match(rendered, /orca_module_recall_hits_total\{module="episodic",service="memory-api"\} 7/);
  assert.match(rendered, /orca_module_workflow_completed_total\{module="episodic",service="memory-api"\} 2/);
  assert.match(rendered, /orca_module_average_recall_latency_ms\{module="episodic",service="memory-api"\} 18/);
  assert.match(rendered, /orca_workflow_runs\{module="episodic",status="completed",service="memory-api"\} 1/);
  assert.match(rendered, /orca_workflow_runs\{module="episodic",status="scheduled",service="memory-api"\} 1/);
});
