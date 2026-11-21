import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import type { FileStorageResources } from '../file-storage';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';
import { skipRuntimeControlAuditEvents } from './audit-stream-filters';

/**
 * Inputs required by the audit outbox projection worker.
 */
export type AuditProjectionWorkerInput = {
  /** Shared data stores read or updated by projections. */
  readonly dataStores: DataStoreResources;
  /** File metadata and object storage used by file projections. */
  readonly fileStorage: FileStorageResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for authorization. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** WebSocket stage used for realtime callbacks. */
  readonly realtimeWebSocketStage: apigatewayv2.WebSocketStage;
  /** Delivery queues targeted by audit projections. */
  readonly workerChannels: WorkerChannels;
};

/**
 * Audit projection resources used by later worker builders and outputs.
 */
export type AuditProjectionWorkerResources = {
  /** Dead-letter queue for audit projection stream failures. */
  readonly collaborationProjectionDlq: sqs.Queue;
  /** Lambda that projects audit outbox events to downstream deliveries. */
  readonly collaborationProjectionFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds the audit outbox projection worker and its operational alarm.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared storage, transport, queue, and authorization inputs.
 * @returns Projection worker resources published through stack outputs.
 */
export function buildAuditProjectionWorker(
  scope: cdk.Stack,
  input: AuditProjectionWorkerInput,
): AuditProjectionWorkerResources {
  const {
    analyticsTable,
    auditEventsTable,
    collaborationTable,
    enterpriseIdentityTable,
    notificationsTable,
    planningTable,
    processedAuditEventsTable,
    projectDirectoryTable,
    realtimeSessionsTable,
    tenantAdministrationTable,
    workItemsTable,
    workspaceAccessTable,
    workspaceSearchTable,
  } = input.dataStores;
  const { fileBucket, fileProofingTable } = input.fileStorage;
  const { cognitoUserPoolArn, cognitoUserPoolId, notificationEmailSender, systemAdminGroups } = input.parameters;
  const { connectorChannels, webhookDeliveryQueue } = input.workerChannels;
  const connectorSyncQueue = connectorChannels?.connectorSyncQueue;
  const { realtimeWebSocketStage } = input;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const collaborationProjectionDlq = new sqs.Queue(scope, 'CollaborationProjectionDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const collaborationProjectionFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'CollaborationProjectionFunction',
    {
      entry: path.join(serverHandlersDirectory, 'audit-projection-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description:
        'Projects audit outbox events into collaboration, Webhook, connector deliveries, and tenant retention.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        ANALYTICS_TABLE_NAME: analyticsTable.tableName,
        // Tenant retention runs in this fan-out, so it writes audit event expiry.
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        // The connector projection runs only when the connectors module owns a queue.
        CONNECTOR_SYNC_ENABLED: connectorSyncQueue ? 'true' : 'false',
        ...(connectorSyncQueue
          ? { CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl }
          : {}),
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
        FILE_BUCKET_NAME: fileBucket.bucketName,
        FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
        NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
        NOTIFICATION_RETENTION_SECONDS: String(365 * 24 * 60 * 60),
        // Email is queued only while a sender is configured, so enabling it later sends no backlog.
        NOTIFICATION_EMAIL_SENDER: notificationEmailSender.valueAsString,
        PLANNING_TABLE_NAME: planningTable.tableName,
        PROCESSED_AUDIT_EVENTS_TABLE_NAME: processedAuditEventsTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
          'WebhookAuthorizationIndex',
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'audit-projection',
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WEBSOCKET_CALLBACK_ENDPOINT: realtimeWebSocketStage.callbackUrl,
        WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    },
  );
  collaborationProjectionFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    resources: [workspaceSearchTable.tableArn],
  }));
  bindRuntimeControls(
    input.runtimeControls,
    collaborationProjectionFunction,
    'audit-projection',
  );

  collaborationProjectionFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(auditEventsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      bisectBatchOnError: true,
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(collaborationProjectionDlq),
      filters: skipRuntimeControlAuditEvents(),
    }),
  );
  new cloudwatch.Alarm(scope, 'CollaborationProjectionDlqAlarm', {
    alarmDescription:
      'Detects audit projection records that exhausted collaboration, Webhook, connector, or tenant retention stream retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: collaborationProjectionDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  // DynamoDB Streams supports two readers per shard. This function and the
  // automation worker are the only AuditEvents stream consumers, so every
  // other audit reaction, such as tenant retention, joins this fan-out.
  new cloudwatch.Alarm(scope, 'CollaborationProjectionIteratorAgeAlarm', {
    alarmDescription:
      'Detects audit projection stream lag of fifteen minutes or more.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: collaborationProjectionFunction.metric('IteratorAge', {
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: cdk.Duration.minutes(15).toMilliseconds(),
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  auditEventsTable.grantStreamRead(collaborationProjectionFunction);
  collaborationTable.grants.readData(collaborationProjectionFunction);
  notificationsTable.grants.readWriteData(collaborationProjectionFunction);
  // Weekly report reminders are dropped once the week is submitted; the notification save is
  // conditioned on the week row so a concurrent submission cancels it.
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
      resources: [planningTable.tableArn],
    }),
  );
  // Timesheet reminders are dropped once their time entries are submitted; the notification save
  // is conditioned on the revalidated entry so a concurrent submission cancels it.
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
      resources: [analyticsTable.tableArn],
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [enterpriseIdentityTable.tableArn],
    }),
  );
  processedAuditEventsTable.grants.readWriteData(collaborationProjectionFunction);
  projectDirectoryTable.grants.readData(collaborationProjectionFunction);
  realtimeSessionsTable.grants.readWriteData(collaborationProjectionFunction);
  workItemsTable.grants.readData(collaborationProjectionFunction);
  workspaceAccessTable.grants.readData(collaborationProjectionFunction);
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [workItemsTable.tableArn],
      conditions: {
        'ForAnyValue:StringEquals': {
          'dynamodb:EnclosingOperation': ['TransactWriteItems'],
        },
      },
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [tenantAdministrationTable.tableArn],
    }),
  );
  // Tenant retention: a governance revision check and the audit event expiry,
  // both only inside one TransactWriteItems call.
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [tenantAdministrationTable.tableArn],
      conditions: {
        'ForAnyValue:StringEquals': {
          'dynamodb:EnclosingOperation': ['TransactWriteItems'],
        },
      },
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [auditEventsTable.tableArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:Attributes': ['directoryId', 'eventId', 'expiresAt', 'occurredAt'],
        },
        'ForAnyValue:StringEquals': {
          'dynamodb:EnclosingOperation': ['TransactWriteItems'],
        },
      },
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [fileProofingTable.tableArn],
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [fileProofingTable.tableArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:Attributes': ['scopeKey', 'recordKey', 'expiresAt', 'retentionUntil'],
        },
      },
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['s3:GetObjectVersionTagging'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['s3:PutObjectVersionTagging'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        'ForAllValues:StringEquals': {
          's3:RequestObjectTagKeys': [
            'GuardDutyMalwareScanStatus',
            'mukuroji-deleted',
            'mukuroji-upload',
          ],
        },
        StringEquals: {
          's3:RequestObjectTag/mukuroji-deleted': 'true',
        },
      },
    }),
  );
  collaborationProjectionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['cognito-idp:AdminListGroupsForUser'],
      resources: [cognitoUserPoolArn],
    }),
  );
  connectorSyncQueue?.grants.sendMessages(collaborationProjectionFunction);
  webhookDeliveryQueue.grants.sendMessages(collaborationProjectionFunction);
  realtimeWebSocketStage.grantManagementApiAccess(collaborationProjectionFunction);

  return {
    collaborationProjectionDlq,
    collaborationProjectionFunction,
  };
}
