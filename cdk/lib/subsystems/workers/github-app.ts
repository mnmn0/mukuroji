import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import {
  resolveLambdaHandlerEntry,
  type LambdaBuildPaths,
} from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/** Path of the webhook endpoint under the app origin. */
export const GITHUB_APP_WEBHOOK_PATH = '/api/integrations/github/webhook';

/** Inputs of the optional GitHub App module (ADR 0079). */
export type GitHubAppWorkerInput = {
  /** API function that receives webhooks and serves the review inbox. */
  readonly apiFunction: lambdaNodejs.NodejsFunction;
  /** Shared data stores. */
  readonly dataStores: DataStoreResources;
  /** Stable paths used to bundle the worker Lambdas. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Canonical app origin, which serves the webhook endpoint. */
  readonly webOrigin: string;
};

/** Resources of the GitHub App module, for stack outputs. */
export type GitHubAppResources = {
  /** Secret the operator fills with the App ID, private key, and webhook secret. */
  readonly gitHubAppSecret: secretsmanager.Secret;
  /** Queue of sync jobs. */
  readonly gitHubSyncQueue: sqs.Queue;
};

/**
 * Builds the optional GitHub App module (ADR 0079): the App secret, the sync queue and its DLQ, the
 * queue worker, and the hourly reconcile.
 *
 * The secret starts as a placeholder without App fields, which every runtime reads as "not
 * configured": the webhook answers 404 and the reconcile does nothing until the operator stores the
 * App's credentials. Rows live in the Planning table, so no table is added.
 *
 * @param scope Stack scope used directly to keep construct paths stable.
 * @param input API function, stores, parameters, and build paths.
 * @returns The secret and the queue.
 */
export function buildGitHubAppWorkers(
  scope: cdk.Stack,
  input: GitHubAppWorkerInput,
): GitHubAppResources {
  const { auditEventsTable, planningTable } = input.dataStores;
  const { depsLockFilePath, projectRoot } = input.lambdaBuildPaths;

  const gitHubAppSecret = new secretsmanager.Secret(scope, 'GitHubAppSecret', {
    description:
      'GitHub App ID, private key, and webhook secret of the pull request review inbox. Starts as a placeholder; see docs/github-integration.md.',
    generateSecretString: {
      secretStringTemplate: '{}',
      generateStringKey: 'placeholder',
      excludePunctuation: true,
    },
  });
  gitHubAppSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const gitHubSyncDlq = new sqs.Queue(scope, 'GitHubSyncDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const gitHubSyncQueue = new sqs.Queue(scope, 'GitHubSyncQueue', {
    deadLetterQueue: { maxReceiveCount: 5, queue: gitHubSyncDlq },
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(4),
    visibilityTimeout: cdk.Duration.minutes(6),
  });

  const environment = {
    // Pull request notifications are audit events the collaboration projection delivers (#775).
    AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
    AUDIT_RETENTION_DAYS: input.parameters.auditRetentionDays.valueAsString,
    GITHUB_APP_SECRET_ARN: gitHubAppSecret.secretArn,
    GITHUB_SYNC_QUEUE_URL: gitHubSyncQueue.queueUrl,
    MUKUROJI_WORKSPACE_DIRECTORY_ID: input.parameters.workspaceDirectoryId.valueAsString,
    PLANNING_TABLE_NAME: planningTable.tableName,
  };
  const bundling = { bundleAwsSDK: true, minify: true, sourceMap: true, target: 'node22' };

  const syncLogGroup = new logs.LogGroup(scope, 'GitHubSyncLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.THREE_MONTHS,
  });
  const gitHubSyncFunction = new lambdaNodejs.NodejsFunction(scope, 'GitHubSyncFunction', {
    entry: resolveLambdaHandlerEntry(input.lambdaBuildPaths, 'github-sync-handler.ts'),
    handler: 'queueHandler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    timeout: cdk.Duration.minutes(1),
    memorySize: 512,
    description: 'Reads GitHub pull requests named by App webhooks and stores their review inbox snapshots.',
    logGroup: syncLogGroup,
    bundling,
    environment: { ...environment, MUKUROJI_RUNTIME_ROLE: 'github-sync' },
  });
  bindRuntimeControls(input.runtimeControls, gitHubSyncFunction, 'connector-sync');
  gitHubSyncFunction.addEventSource(new lambdaEventSources.SqsEventSource(gitHubSyncQueue, {
    batchSize: 5,
    reportBatchItemFailures: true,
  }));

  const reconcileLogGroup = new logs.LogGroup(scope, 'GitHubReconcileLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.THREE_MONTHS,
  });
  const gitHubReconcileFunction = new lambdaNodejs.NodejsFunction(scope, 'GitHubReconcileFunction', {
    entry: resolveLambdaHandlerEntry(input.lambdaBuildPaths, 'github-sync-handler.ts'),
    handler: 'reconcileHandler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    timeout: cdk.Duration.minutes(5),
    memorySize: 512,
    description: 'Hourly rereads the open pull requests of linked GitHub repositories to correct missed webhooks.',
    logGroup: reconcileLogGroup,
    onFailure: new lambdaDestinations.SqsDestination(gitHubSyncDlq),
    retryAttempts: 2,
    bundling,
    environment: { ...environment, MUKUROJI_RUNTIME_ROLE: 'github-reconcile' },
  });
  bindRuntimeControls(input.runtimeControls, gitHubReconcileFunction, 'connector-poll');
  new events.Rule(scope, 'GitHubReconcileRule', {
    description: 'Hourly corrects GitHub pull request snapshots that webhooks missed.',
    schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    targets: [new eventsTargets.LambdaFunction(gitHubReconcileFunction, {
      deadLetterQueue: gitHubSyncDlq,
      maxEventAge: cdk.Duration.hours(1),
      retryAttempts: 2,
    })],
  });

  for (const worker of [gitHubSyncFunction, gitHubReconcileFunction]) {
    gitHubAppSecret.grantRead(worker);
    gitHubSyncQueue.grants.sendMessages(worker);
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
      resources: [planningTable.tableArn],
    }));
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [auditEventsTable.tableArn],
    }));
  }
  gitHubSyncQueue.grants.consumeMessages(gitHubSyncFunction);

  // The API verifies webhooks, queues jobs, serves the inbox, and lists the App's repositories.
  input.apiFunction.addEnvironment('GITHUB_APP_SECRET_ARN', gitHubAppSecret.secretArn);
  input.apiFunction.addEnvironment('GITHUB_SYNC_QUEUE_URL', gitHubSyncQueue.queueUrl);
  gitHubAppSecret.grantRead(input.apiFunction);
  gitHubSyncQueue.grants.sendMessages(input.apiFunction);

  new cloudwatch.Alarm(scope, 'GitHubSyncDlqAlarm', {
    alarmDescription: 'Detects GitHub sync jobs or reconcile runs that exhausted their retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: gitHubSyncDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'GitHubSyncQueueAgeAlarm', {
    alarmDescription: 'Detects GitHub sync jobs delayed for 15 minutes.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: gitHubSyncQueue.metricApproximateAgeOfOldestMessage({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: cdk.Duration.minutes(15).toSeconds(),
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cdk.CfnOutput(scope, 'GitHubAppSecretArn', {
    description: 'Secret to fill with the GitHub App ID, private key, and webhook secret.',
    value: gitHubAppSecret.secretArn,
  });
  new cdk.CfnOutput(scope, 'GitHubAppWebhookUrl', {
    description: 'Webhook URL to enter in the GitHub App settings.',
    value: `${input.webOrigin}${GITHUB_APP_WEBHOOK_PATH}`,
  });

  return { gitHubAppSecret, gitHubSyncQueue };
}
