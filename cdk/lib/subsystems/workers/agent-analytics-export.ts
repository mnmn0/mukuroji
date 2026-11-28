import * as iam from 'aws-cdk-lib/aws-iam';
import type { DataStoreResources } from '../data-stores';
import { grantAgentAnalyticsPut, type AgentAnalyticsResources } from '../agent-analytics';
import type { ScheduledJobGrant } from './scheduled-jobs';

/** Inputs required by the daily agent analytics export. */
export interface AgentAnalyticsExportJobInput {
  /** Agent Runs, Work Items, and tenant tables. */
  readonly dataStores: DataStoreResources;
  /** Analytics streams the job writes. */
  readonly agentAnalytics: AgentAnalyticsResources;
}

/**
 * Defines the daily job that writes run state and Work Item values to the analytics store (ADR 0118).
 *
 * @param input - Data stores and analytics streams.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineAgentAnalyticsExportJob(input: AgentAnalyticsExportJobInput): ScheduledJobGrant {
  const { agentRunsTable, tenantAdministrationTable, workItemsTable } = input.dataStores;
  const { agentAnalytics } = input;
  return {
    id: 'AgentAnalyticsExport',
    runtimeScope: 'agent-run-triage',
    // Three small statements; a role holds at most ten managed policies.
    policy: 'shared-role',
    environment: {
      AGENT_RUNS_TABLE_NAME: agentRunsTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      ...agentAnalytics.streamEnvironment,
    },
    grant: (grantee) => {
      // The started-run notes are read by day partition; runs and Work Items by key.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:GetItem'],
        resources: [agentRunsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [workItemsTable.tableArn, tenantAdministrationTable.tableArn],
      }));
      grantAgentAnalyticsPut({ grantPrincipal: grantee }, [agentAnalytics.runsStream, agentAnalytics.workItemsStream]);
    },
  };
}
