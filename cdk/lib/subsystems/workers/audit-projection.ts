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
import {
  bindWorkspaceSearchWriterFence,
  grantWorkspaceSearchProjectionAccess,
  type WorkspaceSearchWriterFenceResources,
} from '../../policies/workspace-search-writer-fence';
import type { DataStoreResources } from '../data-stores';
import type { FileStorageResources } from '../file-storage';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';

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
  /** Exact writer-client table configuration without writer state permissions. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
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
 * @returns Projection worker resources consumed by webhook migration and outputs.
 */
export function buildAuditProjectionWorker(
  scope: cdk.Stack,
  input: AuditProjectionWorkerInput,
): AuditProjectionWorkerResources {
  const {
    auditEventsTable,
    collaborationTable,
    notificationsTable,
    processedAuditEventsTable,
    projectDirectoryTable,
    realtimeSessionsTable,
    tenantAdministrationTable,
    workItemsTable,
    workspaceAccessTable,
  } = input.dataStores;
  const { fileBucket, fileProofingTable } = input.fileStorage;
  const { cognitoUserPoolArn, cognitoUserPoolId, systemAdminGroups } = input.parameters;
  const { connectorSyncQueue, webhookDeliveryQueue } = input.workerChannels;
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
        'Projects audit outbox events into collaboration, Webhook, and connector deliveries.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        FILE_BUCKET_NAME: fileBucket.bucketName,
        FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
        NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
        NOTIFICATION_RETENTION_SECONDS: String(365 * 24 * 60 * 60),
        PROCESSED_AUDIT_EVENTS_TABLE_NAME: processedAuditEventsTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
          'WebhookAuthorizationIndex',
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'audit-projection',
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WEBSOCKET_CALLBACK_ENDPOINT: realtimeWebSocketStage.callbackUrl,
        WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    },
  );
  bindWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    collaborationProjectionFunction,
  );
  grantWorkspaceSearchProjectionAccess(
    input.workspaceSearchWriterFence,
    collaborationProjectionFunction,
  );
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
    }),
  );
  new cloudwatch.Alarm(scope, 'CollaborationProjectionDlqAlarm', {
    alarmDescription:
      'Detects audit projection records that exhausted collaboration, Webhook, or connector stream retries.',
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
  auditEventsTable.grantStreamRead(collaborationProjectionFunction);
  collaborationTable.grants.readData(collaborationProjectionFunction);
  notificationsTable.grants.readWriteData(collaborationProjectionFunction);
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
  connectorSyncQueue.grants.sendMessages(collaborationProjectionFunction);
  webhookDeliveryQueue.grants.sendMessages(collaborationProjectionFunction);
  realtimeWebSocketStage.grantManagementApiAccess(collaborationProjectionFunction);

  return {
    collaborationProjectionDlq,
    collaborationProjectionFunction,
  };
}
