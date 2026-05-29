import { Client, Connection } from "@temporalio/client";
import type { AppConfig } from "@orca/config";

import type { WorkflowExecutionResult } from "../types.js";

export interface TemporalWorkflowStartResult {
  temporalWorkflowId: string;
}

export const executeWorkflowViaTemporal = async (
  config: AppConfig,
  workflowId: string,
): Promise<WorkflowExecutionResult> => {
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });

  const client = new Client({
    connection,
    namespace: config.temporalNamespace,
  });

  const handle = await client.workflow.start("executeModuleWorkflow", {
    args: [workflowId],
    taskQueue: config.temporalWorkflowTaskQueue,
    workflowId: `orca-${workflowId}-${Date.now()}`,
  });

  const result = (await handle.result()) as WorkflowExecutionResult;

  return {
    ...result,
    backend: result.backend ?? "temporal",
    details: `${result.details} (Temporal workflow ${handle.workflowId})`,
  };
};

export const startWorkflowViaTemporal = async (
  config: AppConfig,
  workflowId: string,
  runId?: string,
): Promise<TemporalWorkflowStartResult> => {
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });

  const client = new Client({
    connection,
    namespace: config.temporalNamespace,
  });

  const handle = await client.workflow.start("executeModuleWorkflow", {
    args: [workflowId, runId],
    taskQueue: config.temporalWorkflowTaskQueue,
    workflowId: `orca-${workflowId}-${Date.now()}`,
  });

  return {
    temporalWorkflowId: handle.workflowId,
  };
};
