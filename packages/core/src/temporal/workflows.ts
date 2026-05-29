import { proxyActivities } from "@temporalio/workflow";

import type { WorkflowExecutionResult } from "../types.js";

const activities = proxyActivities<{
  executeModuleWorkflowActivity(workflowId: string, runId?: string): Promise<WorkflowExecutionResult>;
}>({
  startToCloseTimeout: "2 minutes",
});

export async function executeModuleWorkflow(
  workflowId: string,
  runId?: string,
): Promise<WorkflowExecutionResult> {
  return activities.executeModuleWorkflowActivity(workflowId, runId);
}
