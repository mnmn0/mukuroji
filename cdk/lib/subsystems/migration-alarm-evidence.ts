import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type {
  WorkspaceSearchMigrationDeploymentTrustRoot,
} from '../config/workspace-search-migration-deployment-targets';
import type {
  MigrationAlarmEvidenceName,
  MigrationAlarmEvidenceResource,
} from './migration-observability';
import {
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_ACCOUNT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_REGION_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_ENVIRONMENT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
} from './migration-storage';

/** Canonical six-alarm order shared with the external rehearsal evidence. */
const migrationAlarmEvidenceNames:
  readonly MigrationAlarmEvidenceName[] = Object.freeze([
    'throttle',
    'budget-stop',
    'budget-exhaustion',
    'checkpoint-stall',
    'quarantine',
    'terminal-failure',
  ]);

/**
 * Keeps accepted alarm receipts invisible through the maximum collection,
 * publication, and bounded acknowledgement window.
 */
const migrationAlarmEvidenceVisibilityTimeout = cdk.Duration.minutes(30);

/** Inputs required to build the non-production alarm-delivery sink. */
export type MigrationAlarmEvidenceSinkInput = {
  /** Validated source-controlled deployment trust root gating every resource. */
  readonly deploymentTrustRoot:
    WorkspaceSearchMigrationDeploymentTrustRoot;
  /** Primary and secondary same-environment alarm destinations. */
  readonly notificationTopicArns: readonly [string, string];
  /** Complete migration alarm vector in canonical evidence order. */
  readonly alarms: readonly MigrationAlarmEvidenceResource[];
};

/** Restricted resources used only by an approved non-production rehearsal. */
export type MigrationAlarmEvidenceSinkResources = {
  /** Unattached least-privilege policy for the approved evidence collector. */
  readonly collectorPolicy: iam.ManagedPolicy;
  /** Unattached least-privilege policy for the approved EMF signal ingestor. */
  readonly ingestionPolicy: iam.ManagedPolicy;
  /** Retained production-equivalent log group receiving exact EMF lines. */
  readonly signalLogGroup: logs.LogGroup;
  /** Fixed precreated log stream receiving every ordered rehearsal signal. */
  readonly signalLogStream: logs.LogStream;
  /** Queue containing only primary-route migration ALARM notifications. */
  readonly primaryQueue: sqs.Queue;
  /** Queue containing only secondary-route migration ALARM notifications. */
  readonly secondaryQueue: sqs.Queue;
};

/**
 * Applies the non-production condition to one L1 resource owned by an L2 construct.
 *
 * @param construct L2 construct whose default child must be a CloudFormation resource.
 * @param condition Explicit non-production deployment condition.
 * @returns Nothing.
 */
function applyResourceCondition(
  construct: cdk.Resource,
  condition: cdk.CfnCondition,
): void {
  const resource = construct.node.defaultChild;
  if (!(resource instanceof cdk.CfnResource)) {
    throw new Error(
      'Migration alarm evidence resource has no CloudFormation default child.',
    );
  }
  resource.cfnOptions.condition = condition;
}

/**
 * Validates the complete canonical migration alarm vector at synthesis time.
 *
 * @param alarms Candidate alarm vector supplied by migration observability.
 * @returns Nothing.
 */
function validateAlarmVector(
  alarms: readonly MigrationAlarmEvidenceResource[],
): void {
  if (alarms.length !== migrationAlarmEvidenceNames.length) {
    throw new Error('Migration alarm evidence requires exactly six alarms.');
  }
  for (const [index, expectedName] of migrationAlarmEvidenceNames.entries()) {
    if (alarms[index]?.name !== expectedName) {
      throw new Error(
        'Migration alarm evidence alarms are not in canonical order.',
      );
    }
  }
}

/**
 * Creates one filtered SNS subscription and applies the rehearsal condition.
 *
 * @param topic Imported alarm destination.
 * @param queue Dedicated route-specific evidence queue.
 * @param alarmNames Physical alarm names allowed through the subscription.
 * @param condition Explicit non-production deployment condition.
 * @returns Nothing.
 */
function subscribeEvidenceQueue(
  topic: sns.ITopic,
  queue: sqs.Queue,
  alarmNames: string[],
  condition: cdk.CfnCondition,
): void {
  const subscription = topic.addSubscription(
    new snsSubscriptions.SqsSubscription(queue, {
      filterPolicyWithMessageBody: {
        AlarmName: sns.FilterOrPolicy.filter(
          sns.SubscriptionFilter.stringFilter({ allowlist: alarmNames }),
        ),
        NewStateValue: sns.FilterOrPolicy.filter(
          sns.SubscriptionFilter.stringFilter({ allowlist: ['ALARM'] }),
        ),
      },
      rawMessageDelivery: false,
    }),
  );
  applyResourceCondition(subscription, condition);
  const queuePolicy = queue.node.tryFindChild('Policy');
  if (!(queuePolicy instanceof sqs.QueuePolicy)) {
    throw new Error('Migration alarm evidence queue policy was not created.');
  }
  queue.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'OnlyExpectedSnsTopicCanSendAlarmEvidence',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['sqs:SendMessage'],
    resources: [queue.queueArn],
    conditions: {
      ArnNotEqualsIfExists: {
        'aws:SourceArn': topic.topicArn,
      },
    },
  }));
  applyResourceCondition(queuePolicy, condition);
}

/**
 * Creates encrypted route-specific receipt queues only for non-production rehearsal stacks.
 *
 * Both SNS subscriptions filter on the six concrete migration alarm names and the
 * `ALARM` state. The queues intentionally retain the SNS envelope so the collector
 * can bind the actual topic, SNS message identifier, and SQS enqueue timestamp.
 * No policy is attached to a principal; an approved rehearsal role must explicitly
 * receive the conditionally created collector policy.
 *
 * @param scope Stack that owns the conditionally deployed resources.
 * @param input Environment, destinations, and exact migration alarm set.
 * @returns Conditionally deployed queues and unattached collector policy.
 */
export function buildMigrationAlarmEvidenceSink(
  scope: cdk.Stack,
  input: MigrationAlarmEvidenceSinkInput,
): MigrationAlarmEvidenceSinkResources {
  validateAlarmVector(input.alarms);
  const nonProductionCondition = new cdk.CfnCondition(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceNonProduction',
    {
      expression: cdk.Fn.conditionEquals(
        input.deploymentTrustRoot.rehearsalEnabled
          ? input.deploymentTrustRoot.environment
          : 'production-disabled',
        'non-production',
      ),
    },
  );

  const primaryQueue = new sqs.Queue(
    scope,
    'WorkspaceSearchMigrationAlarmEvidencePrimaryQueue',
    {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      maxMessageSizeBytes: 64 * 1_024,
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: migrationAlarmEvidenceVisibilityTimeout,
    },
  );
  const secondaryQueue = new sqs.Queue(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSecondaryQueue',
    {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      maxMessageSizeBytes: 64 * 1_024,
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: migrationAlarmEvidenceVisibilityTimeout,
    },
  );
  applyResourceCondition(primaryQueue, nonProductionCondition);
  applyResourceCondition(secondaryQueue, nonProductionCondition);
  applyAlarmDeploymentTrustTags(primaryQueue, input.deploymentTrustRoot);
  applyAlarmDeploymentTrustTags(secondaryQueue, input.deploymentTrustRoot);

  const signalLogGroup = new logs.LogGroup(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogGroup',
    {
      logGroupName:
        `/mukuroji/${scope.stackName}/workspace-search-migration/rehearsal`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.ONE_YEAR,
    },
  );
  const signalLogStream = new logs.LogStream(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStream',
    {
      logGroup: signalLogGroup,
      logStreamName: 'alarm-signals-v1',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  applyResourceCondition(signalLogGroup, nonProductionCondition);
  applyResourceCondition(signalLogStream, nonProductionCondition);
  applyAlarmDeploymentTrustTags(
    signalLogGroup,
    input.deploymentTrustRoot,
  );
  const signalLogStreamArn = scope.formatArn({
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    resource: 'log-group',
    resourceName:
      `${signalLogGroup.logGroupName}:log-stream:${signalLogStream.logStreamName}`,
    service: 'logs',
  });

  const primaryTopic = sns.Topic.fromTopicArn(
    scope,
    'WorkspaceSearchMigrationAlarmEvidencePrimaryTopic',
    input.notificationTopicArns[0],
  );
  const secondaryTopic = sns.Topic.fromTopicArn(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSecondaryTopic',
    input.notificationTopicArns[1],
  );
  const physicalAlarmNames = input.alarms.map(
    ({ alarm }) => alarm.alarmName,
  );
  subscribeEvidenceQueue(
    primaryTopic,
    primaryQueue,
    physicalAlarmNames,
    nonProductionCondition,
  );
  subscribeEvidenceQueue(
    secondaryTopic,
    secondaryQueue,
    physicalAlarmNames,
    nonProductionCondition,
  );

  const collectorPolicy = new iam.ManagedPolicy(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceCollectorPolicy',
    {
      description:
        'Unattached non-production-only access to collect migration alarm delivery evidence.',
      statements: [
        new iam.PolicyStatement({
          actions: [
            'sqs:DeleteMessage',
            'sqs:ReceiveMessage',
          ],
          resources: [primaryQueue.queueArn, secondaryQueue.queueArn],
        }),
        new iam.PolicyStatement({
          actions: ['cloudwatch:DescribeAlarmHistory'],
          resources: input.alarms.map(({ alarm }) => alarm.alarmArn),
        }),
      ],
    },
  );
  applyResourceCondition(collectorPolicy, nonProductionCondition);
  applyAlarmDeploymentTrustTags(
    collectorPolicy,
    input.deploymentTrustRoot,
  );

  const ingestionPolicy = new iam.ManagedPolicy(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceIngestionPolicy',
    {
      description:
        'Unattached non-production-only access to ingest exact migration rehearsal EMF signals.',
      statements: [
        new iam.PolicyStatement({
          actions: ['logs:PutLogEvents'],
          resources: [signalLogStreamArn],
        }),
      ],
    },
  );
  applyResourceCondition(ingestionPolicy, nonProductionCondition);
  applyAlarmDeploymentTrustTags(
    ingestionPolicy,
    input.deploymentTrustRoot,
  );

  const alarmArnsOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceAlarmArns',
    {
      description:
        'Canonical throttle,budget-stop,budget-exhaustion,checkpoint-stall,quarantine,terminal-failure alarm ARN vector for non-production evidence.',
      value: cdk.Fn.join(',', input.alarms.map(({ alarm }) => alarm.alarmArn)),
    },
  );
  const primaryQueueUrlOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidencePrimaryQueueUrl',
    { value: primaryQueue.queueUrl },
  );
  const secondaryQueueUrlOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSecondaryQueueUrl',
    { value: secondaryQueue.queueUrl },
  );
  const collectorPolicyArnOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceCollectorPolicyArn',
    { value: collectorPolicy.managedPolicyArn },
  );
  const signalLogGroupNameOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogGroupName',
    { value: signalLogGroup.logGroupName },
  );
  const signalLogStreamNameOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStreamName',
    { value: signalLogStream.logStreamName },
  );
  const signalLogStreamArnOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStreamArn',
    { value: signalLogStreamArn },
  );
  const ingestionPolicyArnOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceIngestionPolicyArn',
    { value: ingestionPolicy.managedPolicyArn },
  );
  const deploymentTrustRootOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceDeploymentTrustRootDigest',
    { value: input.deploymentTrustRoot.digest },
  );
  const deploymentTargetOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationAlarmEvidenceDeploymentTargetId',
    { value: input.deploymentTrustRoot.targetId },
  );
  for (const output of [
    alarmArnsOutput,
    primaryQueueUrlOutput,
    secondaryQueueUrlOutput,
    collectorPolicyArnOutput,
    signalLogGroupNameOutput,
    signalLogStreamNameOutput,
    signalLogStreamArnOutput,
    ingestionPolicyArnOutput,
    deploymentTrustRootOutput,
    deploymentTargetOutput,
  ]) {
    output.condition = nonProductionCondition;
  }

  return {
    collectorPolicy,
    ingestionPolicy,
    primaryQueue,
    secondaryQueue,
    signalLogGroup,
    signalLogStream,
  };
}

/**
 * Applies the complete secret-free deployment trust root to one sink resource.
 *
 * @param resource - Taggable alarm-evidence resource.
 * @param trustRoot - Validated source-controlled deployment trust root.
 * @returns Nothing.
 */
function applyAlarmDeploymentTrustTags(
  resource: cdk.Resource,
  trustRoot: WorkspaceSearchMigrationDeploymentTrustRoot,
): void {
  const deploymentAccount = trustRoot.rehearsalEnabled
    ? trustRoot.deploymentAccount
    : cdk.Aws.ACCOUNT_ID;
  const deploymentRegion = trustRoot.rehearsalEnabled
    ? trustRoot.region
    : cdk.Aws.REGION;
  for (const [key, value] of [
    [WORKSPACE_SEARCH_MIGRATION_ENVIRONMENT_TAG_KEY, trustRoot.environment],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_ACCOUNT_TAG_KEY, deploymentAccount],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_REGION_TAG_KEY, deploymentRegion],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_TAG_KEY, trustRoot.targetId],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_TAG_KEY, trustRoot.digest],
    [
      WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION_TAG_KEY,
      String(trustRoot.version),
    ],
    [
      WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
      trustRoot.productionAccountDigest,
    ],
  ]) {
    cdk.Tags.of(resource).add(key, value);
  }
}
