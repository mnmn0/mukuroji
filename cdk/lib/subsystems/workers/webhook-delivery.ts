import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  bindWorkspaceSearchWriterFence,
  type WorkspaceSearchWriterFenceResources,
} from '../../policies/workspace-search-writer-fence';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';

/**
 * Inputs required by Webhook delivery processing.
 */
export interface WebhookDeliveryWorkerInput {
  /** Shared data stores used by Webhook authorization and delivery. */
  readonly dataStores: DataStoreResources;
  /** Stable paths used to bundle Webhook Lambda functions. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for Cognito authorization. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Durable Webhook delivery queue and dead-letter queue. */
  readonly workerChannels: WorkerChannels;
  /** Exact source, target, and state tables protected by the writer fence. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Restricts a KMS grant to the Webhook developer platform encryption context.
 *
 * @param grant Grant whose principal and resource statements are constrained.
 * @returns Nothing.
 */
function restrictKmsGrantToWebhookPurpose(grant: iam.Grant): void {
  for (const statement of [
    ...grant.principalStatements,
    ...grant.resourceStatements,
  ]) {
    statement.addConditions({
      StringEquals: {
        'kms:EncryptionContext:mukuroji:purpose': 'webhook',
        'kms:EncryptionContext:mukuroji:service': 'developer-platform',
      },
    });
  }
}

/**
 * Builds the durable Webhook delivery worker.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared storage, queue, parameter, and build inputs.
 * @returns Nothing.
 */
export function buildWebhookDeliveryWorkers(
  scope: cdk.Stack,
  input: WebhookDeliveryWorkerInput,
): void {
  const {
    auditEventsTable,
    developerPlatformTable,
    developerPlatformWebhookKey,
    enterpriseIdentityTable,
    projectDirectoryTable,
    tenantAdministrationTable,
    workspaceAccessTable,
  } = input.dataStores;
  const {
    depsLockFilePath,
    projectRoot,
    serverHandlersDirectory,
  } = input.lambdaBuildPaths;
  const {
    cognitoUserPoolArn,
    cognitoUserPoolId,
    systemAdminGroups,
  } = input.parameters;
  const { webhookDeliveryDlq, webhookDeliveryQueue } = input.workerChannels;

  const webhookDeliveryLogGroup = new logs.LogGroup(
    scope,
    'WebhookDeliveryLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const webhookDeliveryFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'WebhookDeliveryFunction',
    {
      entry: path.join(serverHandlersDirectory, 'webhook-handler.ts'),
      handler: 'deliveryHandler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: 'Delivers signed Webhooks from the durable SQS queue.',
      logGroup: webhookDeliveryLogGroup,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
        DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
        DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID:
          developerPlatformWebhookKey.keyArn,
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
          'WebhookAuthorizationIndex',
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
        WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    },
  );
  bindWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    webhookDeliveryFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    webhookDeliveryFunction,
    'webhook-delivery',
  );
  webhookDeliveryFunction.addEventSource(
    new lambdaEventSources.SqsEventSource(webhookDeliveryQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }),
  );
  webhookDeliveryFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [
        auditEventsTable.tableArn,
        developerPlatformTable.tableArn,
        enterpriseIdentityTable.tableArn,
        projectDirectoryTable.tableArn,
        tenantAdministrationTable.tableArn,
        workspaceAccessTable.tableArn,
      ],
    }),
  );
  webhookDeliveryFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [
        `${developerPlatformTable.tableArn}/index/LookupKeyIndex`,
        enterpriseIdentityTable.tableArn,
        projectDirectoryTable.tableArn,
        `${projectDirectoryTable.tableArn}/index/WebhookAuthorizationIndex`,
      ],
    }),
  );
  webhookDeliveryFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['cognito-idp:AdminListGroupsForUser'],
      resources: [cognitoUserPoolArn],
    }),
  );
  webhookDeliveryFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'dynamodb:DeleteItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      resources: [developerPlatformTable.tableArn],
    }),
  );
  webhookDeliveryFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:DeleteItem'],
      resources: [projectDirectoryTable.tableArn],
    }),
  );
  restrictKmsGrantToWebhookPurpose(
    developerPlatformWebhookKey.grants.decrypt(webhookDeliveryFunction),
  );
  webhookDeliveryQueue.grants.consumeMessages(webhookDeliveryFunction);
  webhookDeliveryQueue.grants.sendMessages(webhookDeliveryFunction);

  new cloudwatch.Alarm(scope, 'WebhookDeliveryDlqAlarm', {
    alarmDescription:
      'Detects signed Webhook deliveries that exhausted queue redrive attempts.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: webhookDeliveryDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
