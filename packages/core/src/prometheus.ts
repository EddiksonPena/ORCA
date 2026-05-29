import type { MemoryHealth, ModuleObservabilitySnapshot } from "@orca/schemas";

import type { WorkflowRunRecord } from "./types.js";

const escapeLabelValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const metricLine = (name: string, value: number, labels?: Record<string, string>): string => {
  const labelText = labels
    ? `{${Object.entries(labels)
        .map(([key, labelValue]) => `${key}="${escapeLabelValue(labelValue)}"`)
        .join(",")}}`
    : "";
  return `${name}${labelText} ${value}`;
};

export const renderModuleMetricsPrometheus = (
  modules: ModuleObservabilitySnapshot[],
  memory: MemoryHealth,
  workflowRuns: WorkflowRunRecord[],
  service: "memory-api" | "worker",
): string => {
  const lines: string[] = [
    "# HELP orca_memory_artifact_count Total persisted memory artifacts for the service.",
    "# TYPE orca_memory_artifact_count gauge",
    "# HELP orca_memory_chunk_count Total persisted memory chunks for the service.",
    "# TYPE orca_memory_chunk_count gauge",
    "# HELP orca_memory_graph_node_count Total persisted graph nodes for the service.",
    "# TYPE orca_memory_graph_node_count gauge",
    "# HELP orca_memory_graph_edge_count Total persisted graph edges for the service.",
    "# TYPE orca_memory_graph_edge_count gauge",
    "# HELP orca_module_artifact_count Persisted memory artifacts by module.",
    "# TYPE orca_module_artifact_count gauge",
    "# HELP orca_module_chunk_count Persisted memory chunks by module.",
    "# TYPE orca_module_chunk_count gauge",
    "# HELP orca_module_ingest_total Total ingest requests handled by module.",
    "# TYPE orca_module_ingest_total counter",
    "# HELP orca_module_deduplicated_total Total deduplicated ingests by module.",
    "# TYPE orca_module_deduplicated_total counter",
    "# HELP orca_module_artifact_writes_total Total artifact writes attributed to module ingest.",
    "# TYPE orca_module_artifact_writes_total counter",
    "# HELP orca_module_chunk_writes_total Total chunk writes attributed to module ingest.",
    "# TYPE orca_module_chunk_writes_total counter",
    "# HELP orca_module_recall_queries_total Total recall queries evaluated by module.",
    "# TYPE orca_module_recall_queries_total counter",
    "# HELP orca_module_recall_hits_total Total recalled context hits attributed to module.",
    "# TYPE orca_module_recall_hits_total counter",
    "# HELP orca_module_feedback_total Total feedback events applied to module artifacts.",
    "# TYPE orca_module_feedback_total counter",
    "# HELP orca_module_positive_feedback_total Total positive feedback events applied to module artifacts.",
    "# TYPE orca_module_positive_feedback_total counter",
    "# HELP orca_module_workflow_scheduled_total Total workflows scheduled for a module.",
    "# TYPE orca_module_workflow_scheduled_total counter",
    "# HELP orca_module_workflow_completed_total Total workflows completed for a module.",
    "# TYPE orca_module_workflow_completed_total counter",
    "# HELP orca_module_workflow_failed_total Total workflows failed for a module.",
    "# TYPE orca_module_workflow_failed_total counter",
    "# HELP orca_module_average_ingest_latency_ms Average ingest latency in milliseconds for a module.",
    "# TYPE orca_module_average_ingest_latency_ms gauge",
    "# HELP orca_module_average_recall_latency_ms Average recall latency in milliseconds for a module.",
    "# TYPE orca_module_average_recall_latency_ms gauge",
    "# HELP orca_workflow_runs Retained workflow runs by module and status.",
    "# TYPE orca_workflow_runs gauge",
  ];

  const serviceLabels = { service };
  lines.push(metricLine("orca_memory_artifact_count", memory.artifactCount, serviceLabels));
  lines.push(metricLine("orca_memory_chunk_count", memory.chunkCount, serviceLabels));
  lines.push(metricLine("orca_memory_graph_node_count", memory.graphNodeCount, serviceLabels));
  lines.push(metricLine("orca_memory_graph_edge_count", memory.graphEdgeCount, serviceLabels));

  for (const module of modules) {
    const labels = { module: module.moduleId, service };
    lines.push(metricLine("orca_module_artifact_count", module.artifactCount, labels));
    lines.push(metricLine("orca_module_chunk_count", module.chunkCount, labels));
    lines.push(metricLine("orca_module_ingest_total", module.ingestCount, labels));
    lines.push(metricLine("orca_module_deduplicated_total", module.deduplicatedCount, labels));
    lines.push(metricLine("orca_module_artifact_writes_total", module.artifactWriteCount, labels));
    lines.push(metricLine("orca_module_chunk_writes_total", module.chunkWriteCount, labels));
    lines.push(metricLine("orca_module_recall_queries_total", module.recallQueryCount, labels));
    lines.push(metricLine("orca_module_recall_hits_total", module.recallHitCount, labels));
    lines.push(metricLine("orca_module_feedback_total", module.feedbackCount, labels));
    lines.push(metricLine("orca_module_positive_feedback_total", module.positiveFeedbackCount, labels));
    lines.push(metricLine("orca_module_workflow_scheduled_total", module.workflowScheduledCount, labels));
    lines.push(metricLine("orca_module_workflow_completed_total", module.workflowCompletedCount, labels));
    lines.push(metricLine("orca_module_workflow_failed_total", module.workflowFailedCount, labels));
    lines.push(metricLine("orca_module_average_ingest_latency_ms", module.averageIngestLatencyMs, labels));
    lines.push(metricLine("orca_module_average_recall_latency_ms", module.averageRecallLatencyMs, labels));
  }

  const workflowCounts = new Map<string, number>();
  for (const run of workflowRuns) {
    const key = `${run.moduleId}::${run.status}`;
    workflowCounts.set(key, (workflowCounts.get(key) ?? 0) + 1);
  }

  for (const [key, value] of workflowCounts.entries()) {
    const [module, status] = key.split("::");
    if (!module || !status) {
      continue;
    }
    lines.push(metricLine("orca_workflow_runs", value, { module, status, service }));
  }

  return `${lines.join("\n")}\n`;
};
