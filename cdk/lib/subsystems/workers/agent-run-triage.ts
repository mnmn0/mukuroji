import * as iam from 'aws-cdk-lib/aws-iam';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import type { ScheduledJobGrant } from './scheduled-jobs';

/** Wake shards of new Triage entries; must match the Triage schedule worker. */
const triageWakeShardCount = 8;

/**
 * Inputs required by the worker that files failed and stalled Agent Runs to Triage.
 */
export interface AgentRunTriageWorkerInput {
  /** Agent Runs, Work Items, Request Intake, audit, and tenant tables. */
  readonly dataStores: DataStoreResources;
  /** Stack parameters used for immutable audit retention. */
  readonly parameters: StackParameters;
}

/**
 * Defines the every-minute job that files failed and stalled Agent Runs of opted-in Teams to
 * Triage.
 *
 * @param input - Data stores and audit retention.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineAgentRunTriageJob(input: AgentRunTriageWorkerInput): ScheduledJobGrant {
  const {
    agentRunsTable,
    auditEventsTable,
    projectDirectoryTable,
    requestIntakeTable,
    tenantAdministrationTable,
    workItemsTable,
    workspaceAccessTable,
  } = input.dataStores;
  const { auditRetentionDays } = input.parameters;

  return {
    id: 'AgentRunTriage',
    runtimeScope: 'agent-run-triage',
    environment: {
      AGENT_RUNS_TABLE_NAME: agentRunsTable.tableName,
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      TRIAGE_WAKE_SHARD_COUNT: String(triageWakeShardCount),
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
    },
    grant: (grantee) => {
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [
          `${agentRunsTable.tableArn}/index/AgentRunTriageIndex`,
          `${agentRunsTable.tableArn}/index/ActiveRunIndex`,
        ],
      }));
      // Strong reads of runs and settings, the outbox removal, and the stall mark.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [agentRunsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [
          workItemsTable.tableArn,
          tenantAdministrationTable.tableArn,
          workspaceAccessTable.tableArn,
        ],
      }));
      // Admission fences the Team, Project, routed owners, and the Workspace lifecycle at commit.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [projectDirectoryTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem'],
        resources: [projectDirectoryTable.tableArn, workspaceAccessTable.tableArn, tenantAdministrationTable.tableArn],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      }));
      // Triage admission reads the source claim and Team configuration, then writes the entry,
      // claim, receipt, and audit event in one transaction.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [requestIntakeTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'dynamodb:ConditionCheckItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
        ],
        resources: [requestIntakeTable.tableArn],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [auditEventsTable.tableArn],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      }));
    },
  };
}
