import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
  type RuntimeControlScope,
} from '../runtime-controls';

/**
 * What one periodic job adds to the shared scheduled-jobs Lambda.
 */
export type ScheduledJobGrant = Readonly<{
  /** PascalCase construct ID prefix of the job's own IAM policy. */
  readonly id: string;
  /** Runtime-control scope the job's guarded entrypoint evaluates. */
  readonly runtimeScope: RuntimeControlScope;
  /** Environment the job's composition reads. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Adds the job's IAM permissions. Statements and grants given to `grantee` land in the
   * job's own policy on the shared role; `role` is the shared role itself.
   */
  readonly grant: (grantee: iam.IPrincipal, role: iam.IRole) => void;
}>;

/**
 * Inputs required by the shared scheduled-jobs Lambda.
 */
export interface ScheduledJobsWorkerInput {
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Jobs the Lambda runs, in the order of `server/src/handlers/scheduled-jobs-handler.ts`. */
  readonly jobs: readonly ScheduledJobGrant[];
}

/**
 * Scheduled-jobs resources exposed through stack outputs.
 */
export type ScheduledJobsWorkerResources = {
  /** Dead-letter queue for invocations in which a job exhausted its tries. */
  readonly scheduledJobsDlq: sqs.Queue;
  /** Lambda that runs every periodic job on one schedule. */
  readonly scheduledJobsFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Merges the jobs' environments and rejects a variable two jobs set differently.
 *
 * @param scope Stack used to compare token values.
 * @param jobs Jobs whose environments are merged.
 * @returns The combined environment.
 */
function mergeJobEnvironments(
  scope: cdk.Stack,
  jobs: readonly ScheduledJobGrant[],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const job of jobs) {
    for (const [name, value] of Object.entries(job.environment)) {
      const existing = merged[name];
      if (
        existing !== undefined &&
        JSON.stringify(scope.resolve(existing)) !== JSON.stringify(scope.resolve(value))
      ) {
        throw new Error(`Scheduled jobs set ${name} to different values.`);
      }
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * Principal that adds statements to one job's policy on the shared role.
 */
class JobPolicyPrincipal extends iam.PrincipalBase {
  /** The shared role's account, so grants stay identity-based instead of resource-based. */
  override readonly principalAccount: string | undefined;

  /**
   * @param role Shared Lambda role the policy is attached to.
   * @param policy The job's own policy.
   */
  constructor(
    private readonly role: iam.IRole,
    private readonly policy: iam.ManagedPolicy,
  ) {
    super();
    this.principalAccount = role.principalAccount;
  }

  /** The shared role's principal, which every job runs as. */
  get policyFragment(): iam.PrincipalPolicyFragment {
    return this.role.policyFragment;
  }

  /**
   * Keeps two job principals of one role distinct when CDK deduplicates principals.
   *
   * @returns A key unique to the job's policy.
   */
  dedupeString(): string | undefined {
    return `JobPolicyPrincipal:${this.policy.node.path}`;
  }

  /**
   * Adds a statement to the job's own policy.
   *
   * @param statement Statement to add.
   * @returns The policy that holds it.
   */
  override addToPrincipalPolicy(statement: iam.PolicyStatement): iam.AddToPrincipalPolicyResult {
    this.policy.addStatements(statement);
    return { statementAdded: true, policyDependable: this.policy };
  }
}

/**
 * Grants each job through its own customer-managed policy on the shared role, so the
 * permissions stay reviewable per job and each policy has its own 6,144-character quota.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param worker Shared scheduled-jobs Lambda.
 * @param jobs Jobs whose grants are applied.
 */
function grantJobsSeparately(
  scope: cdk.Stack,
  worker: lambdaNodejs.NodejsFunction,
  jobs: readonly ScheduledJobGrant[],
): void {
  const role = worker.role;
  const functionResource = worker.node.defaultChild;
  if (!role || !functionResource) {
    throw new Error('Scheduled jobs Lambda execution role was not created.');
  }
  for (const job of jobs) {
    const existing = new Set(scope.node.findAll());
    // Customer-managed, so the jobs' statements do not count toward the role's 10,240-character
    // inline policy quota.
    const policy = new iam.ManagedPolicy(scope, `${job.id}JobPolicy`, { roles: [role] });
    job.grant(new JobPolicyPrincipal(role, policy), role);
    // The first scheduled run must not start before the job's permissions exist.
    for (const construct of scope.node.findAll()) {
      const isPolicy = construct instanceof iam.Policy || construct instanceof iam.ManagedPolicy;
      if (isPolicy && !existing.has(construct)) {
        functionResource.node.addDependency(construct);
      }
    }
  }
}

/**
 * Builds one Lambda and one every-minute rule that run every periodic job.
 *
 * The handler picks the jobs due at each scheduled minute and retries each one on its own,
 * so the Lambda is not retried asynchronously. An invocation in which a job still fails
 * goes to the DLQ with the failed job names in its error message.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param input Build paths, runtime controls, and the jobs' environments and grants.
 * @returns The Lambda and its retained dead-letter queue.
 */
export function buildScheduledJobsWorker(
  scope: cdk.Stack,
  input: ScheduledJobsWorkerInput,
): ScheduledJobsWorkerResources {
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const scheduledJobsDlq = new sqs.Queue(scope, 'ScheduledJobsDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const scheduledJobsFunction = new lambdaNodejs.NodejsFunction(scope, 'ScheduledJobsFunction', {
    entry: path.join(serverHandlersDirectory, 'scheduled-jobs-handler.ts'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    // Each job had five minutes; a job may take up to three tries in one invocation.
    timeout: cdk.Duration.minutes(15),
    memorySize: 1024,
    logGroup: new logs.LogGroup(scope, 'ScheduledJobsLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    }),
    description:
      'Runs the periodic Automation, Triage, Agent Run, Slack, analytics, and notification jobs.',
    onFailure: new lambdaDestinations.SqsDestination(scheduledJobsDlq),
    retryAttempts: 0,
    bundling: {
      bundleAwsSDK: true,
      minify: true,
      sourceMap: true,
      target: 'node22',
    },
    environment: {
      ...mergeJobEnvironments(scope, input.jobs),
      MUKUROJI_RUNTIME_ROLE: 'scheduled-jobs-worker',
    },
  });
  bindRuntimeControls(
    input.runtimeControls,
    scheduledJobsFunction,
    [...new Set(input.jobs.map((job) => job.runtimeScope))],
  );
  grantJobsSeparately(scope, scheduledJobsFunction, input.jobs);

  new cloudwatch.Alarm(scope, 'ScheduledJobsDlqAlarm', {
    alarmDescription:
      'Detects scheduled job failures after per-job retries; the message names the failed jobs.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: scheduledJobsDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ScheduledJobsDestinationFailureAlarm', {
    alarmDescription:
      'Detects failures while Lambda delivers scheduled job failures to the DLQ.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: scheduledJobsFunction.metric('DestinationDeliveryFailures', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new events.Rule(scope, 'ScheduledJobsRule', {
    description: 'Runs the periodic jobs that are due each minute.',
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new eventsTargets.LambdaFunction(scheduledJobsFunction)],
  });

  return { scheduledJobsDlq, scheduledJobsFunction };
}
