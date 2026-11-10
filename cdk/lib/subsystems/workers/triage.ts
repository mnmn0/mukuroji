import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import type { ScheduledJobGrant } from './scheduled-jobs';

const triageWakeIndexName = 'triage-wake-index';
const triageWakeShardCount = 8;
const triageScheduleBatchSize = 100;

/**
 * Inputs required by the scheduled Triage wake-up worker.
 */
export interface TriageScheduleWorkerInput {
  /** Request Intake single-table store that also owns Triage entries and receipts. */
  readonly dataStores: DataStoreResources;
  /** Stack parameters used for immutable audit retention. */
  readonly parameters: StackParameters;
}

/**
 * Defines the every-minute job that processes due Triage snooze, SLA, and escalation wake-ups.
 *
 * @param input - Request Intake store and audit retention.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineTriageScheduleJob(input: TriageScheduleWorkerInput): ScheduledJobGrant {
  const { auditEventsTable, requestIntakeTable } = input.dataStores;
  const { auditRetentionDays } = input.parameters;
  const triageWakeIndexArn = cdk.Stack.of(requestIntakeTable).formatArn({
    service: 'dynamodb',
    resource: 'table',
    resourceName:
      `${requestIntakeTable.tableName}/index/${triageWakeIndexName}`,
  });

  return {
    id: 'TriageSchedule',
    runtimeScope: 'triage-schedule',
    environment: {
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
      TRIAGE_SCHEDULE_BATCH_SIZE: String(triageScheduleBatchSize),
      TRIAGE_WAKE_INDEX_NAME: triageWakeIndexName,
      TRIAGE_WAKE_SHARD_COUNT: String(triageWakeShardCount),
    },
    grant: (grantee) => {
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [triageWakeIndexArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
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
