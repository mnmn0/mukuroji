import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  type LambdaBuildPaths,
  resolveLambdaHandlerEntry,
} from '../config/lambda-build-paths';

/**
 * Stable application surfaces that consume dynamic runtime controls.
 */
export type RuntimeControlScope =
  | 'analytics-schedule'
  | 'api'
  | 'audit-projection'
  | 'automation-event'
  | 'automation-schedule'
  | 'connector-poll'
  | 'connector-sync'
  | 'enterprise-identity-maintenance'
  | 'enterprise-scim-group-job'
  | 'notification-schedule'
  | 'realtime'
  | 'request-intake-email'
  | 'webhook-delivery'
  | 'work-item-import';

/**
 * AppConfig resources and identifiers shared by controlled Lambda runtimes.
 */
export type RuntimeControlResources = Readonly<{
  /** AWS AppConfig application identifier. */
  readonly applicationId: string;
  /** Canary deployment strategy identifier for reviewed operator changes. */
  readonly canaryDeploymentStrategyId: string;
  /** Exact configuration ARN granted to application runtimes. */
  readonly configurationArn: string;
  /** Hosted runtime-control configuration profile identifier. */
  readonly configurationProfileId: string;
  /** AWS AppConfig environment identifier. */
  readonly environmentId: string;
  /** Baseline deployment that must complete before controlled runtimes start. */
  readonly initialDeployment: appconfig.CfnDeployment;
  /** Shared least-privilege policy attached to controlled Lambda roles. */
  readonly readPolicy: iam.ManagedPolicy;
}>;

/**
 * Build inputs required by the runtime-control control plane.
 */
export interface RuntimeControlInput {
  /** Stable paths used to bundle alarm-readiness Lambda entrypoints. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
}

const runtimeControlSchema = {
  $schema: 'http://json-schema.org/draft-04/schema#',
  additionalProperties: false,
  properties: {
    mode: {
      enum: ['enabled', 'disabled'],
      type: 'string',
    },
    revision: {
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 1,
      type: 'integer',
    },
    schemaVersion: {
      enum: [1],
      type: 'integer',
    },
  },
  required: ['schemaVersion', 'mode', 'revision'],
  type: 'object',
};

const initialRuntimeControl = {
  mode: 'enabled',
  revision: 1,
  schemaVersion: 1,
};

/**
 * Builds the retained AWS AppConfig control plane without adding a nested construct scope.
 *
 * @param scope Stack scope that directly owns the stable control-plane resources.
 * @param input Lambda build paths used by the alarm-readiness custom resource.
 * @returns Runtime-control resources and identifiers consumed by Lambda builders and outputs.
 */
export function buildRuntimeControls(
  scope: cdk.Stack,
  input: RuntimeControlInput,
): RuntimeControlResources {
  const application = new appconfig.CfnApplication(
    scope,
    'RuntimeControlApplication',
    {
      description:
        'Dynamic operational controls shared by Mukuroji application runtimes.',
      name: 'mukuroji-runtime-controls',
    },
  );
  application.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const configurationProfile = new appconfig.CfnConfigurationProfile(
    scope,
    'RuntimeControlConfigurationProfile',
    {
      applicationId: application.ref,
      deletionProtectionCheck: 'APPLY',
      description:
        'Validated non-secret operational controls consumed by Lambda runtimes.',
      locationUri: 'hosted',
      name: 'runtime-controls',
      type: 'AWS.Freeform',
      validators: [{
        content: JSON.stringify(runtimeControlSchema),
        type: 'JSON_SCHEMA',
      }],
    },
  );
  configurationProfile.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const metricControlId = cdk.Fn.join(':', [
    application.ref,
    configurationProfile.ref,
  ]);

  const configurationFailureAlarm = new cloudwatch.Alarm(
    scope,
    'RuntimeControlConfigurationFailureAlarm',
    {
      alarmDescription:
        'Detects invalid dynamic runtime-control configuration.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: new cloudwatch.Metric({
        dimensionsMap: {
          ControlId: metricControlId,
          Service: 'mukuroji-runtime-control',
        },
        metricName: 'ConfigurationFailureCount',
        namespace: 'Mukuroji/RuntimeControl',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );

  const monitorRole = new iam.Role(scope, 'RuntimeControlAlarmMonitorRole', {
    assumedBy: new iam.ServicePrincipal('appconfig.amazonaws.com'),
    description:
      'Allows AWS AppConfig to observe runtime-control configuration failures.',
  });
  const monitorPolicy = new iam.Policy(
    scope,
    'RuntimeControlAlarmMonitorPolicy',
    {
      roles: [monitorRole],
      statements: [new iam.PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms'],
        resources: ['*'],
      })],
    },
  );

  const alarmReadinessOnEventLogGroup = new logs.LogGroup(
    scope,
    'RuntimeControlAlarmReadinessOnEventLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const alarmReadinessOnEventFunction = new NodejsFunction(
    scope,
    'RuntimeControlAlarmReadinessOnEventFunction',
    {
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      depsLockFilePath: input.lambdaBuildPaths.depsLockFilePath,
      description:
        'Starts the read-only wait for a naturally evaluated runtime-control alarm.',
      entry: resolveLambdaHandlerEntry(
        input.lambdaBuildPaths,
        'runtime-control-alarm-readiness-handler.ts',
      ),
      handler: 'onEventHandler',
      logGroup: alarmReadinessOnEventLogGroup,
      memorySize: 256,
      projectRoot: input.lambdaBuildPaths.projectRoot,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
    },
  );

  const alarmReadinessPollLogGroup = new logs.LogGroup(
    scope,
    'RuntimeControlAlarmReadinessPollLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const alarmReadinessPollFunction = new NodejsFunction(
    scope,
    'RuntimeControlAlarmReadinessPollFunction',
    {
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      depsLockFilePath: input.lambdaBuildPaths.depsLockFilePath,
      description:
        'Polls CloudWatch until the runtime-control alarm is OK and actionable.',
      entry: resolveLambdaHandlerEntry(
        input.lambdaBuildPaths,
        'runtime-control-alarm-readiness-handler.ts',
      ),
      handler: 'isCompleteHandler',
      logGroup: alarmReadinessPollLogGroup,
      memorySize: 256,
      projectRoot: input.lambdaBuildPaths.projectRoot,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
    },
  );
  alarmReadinessPollFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['cloudwatch:DescribeAlarms'],
    resources: ['*'],
  }));

  const alarmReadinessProviderLogGroup = new logs.LogGroup(
    scope,
    'RuntimeControlAlarmReadinessProviderLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const alarmReadinessProvider = new customResources.Provider(
    scope,
    'RuntimeControlAlarmReadinessProvider',
    {
      isCompleteHandler: alarmReadinessPollFunction,
      logGroup: alarmReadinessProviderLogGroup,
      onEventHandler: alarmReadinessOnEventFunction,
      queryInterval: cdk.Duration.seconds(10),
      totalTimeout: cdk.Duration.minutes(15),
    },
  );
  const alarmReadiness = new cdk.CustomResource(
    scope,
    'RuntimeControlAlarmReadiness',
    {
      properties: {
        AlarmName: configurationFailureAlarm.alarmName,
        ReadinessContractVersion: 'v1',
      },
      resourceType: 'Custom::RuntimeControlAlarmReadiness',
      serviceToken: alarmReadinessProvider.serviceToken,
    },
  );
  alarmReadiness.node.addDependency(configurationFailureAlarm);

  const environment = new appconfig.CfnEnvironment(
    scope,
    'RuntimeControlEnvironment',
    {
      applicationId: application.ref,
      deletionProtectionCheck: 'APPLY',
      description:
        'Production runtime-control deployment target monitored for invalid configurations.',
      monitors: [{
        alarmArn: configurationFailureAlarm.alarmArn,
        alarmRoleArn: monitorRole.roleArn,
      }],
      name: 'production',
    },
  );
  environment.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  environment.node.addDependency(alarmReadiness, monitorPolicy);

  const initialConfiguration = new appconfig.CfnHostedConfigurationVersion(
    scope,
    'RuntimeControlInitialConfiguration',
    {
      applicationId: application.ref,
      configurationProfileId: configurationProfile.ref,
      content: JSON.stringify(initialRuntimeControl),
      contentType: 'application/json',
      description:
        'Baseline v1 configuration that enables application processing.',
      versionLabel: 'baseline-v1',
    },
  );
  initialConfiguration.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const initialDeployment = new appconfig.CfnDeployment(
    scope,
    'RuntimeControlInitialDeployment',
    {
      applicationId: application.ref,
      configurationProfileId: configurationProfile.ref,
      configurationVersion: initialConfiguration.ref,
      deploymentStrategyId: 'AppConfig.AllAtOnce',
      description:
        'Bootstraps the validated enabled runtime-control configuration.',
      environmentId: environment.ref,
    },
  );

  const canaryDeploymentStrategy = new appconfig.CfnDeploymentStrategy(
    scope,
    'RuntimeControlCanaryDeploymentStrategy',
    {
      deploymentDurationInMinutes: 20,
      description:
        'Rolls reviewed runtime controls out as a 10 percent canary before a final monitored bake.',
      finalBakeTimeInMinutes: 10,
      growthFactor: 10,
      growthType: 'EXPONENTIAL',
      name: 'mukuroji-runtime-control-canary',
      replicateTo: 'NONE',
    },
  );
  canaryDeploymentStrategy.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const configurationArn = scope.formatArn({
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resource: 'application',
    resourceName:
      `${application.ref}/environment/${environment.ref}` +
      `/configuration/${configurationProfile.ref}`,
    service: 'appconfig',
  });
  const readPolicy = new iam.ManagedPolicy(scope, 'RuntimeControlReadPolicy', {
    description:
      'Allows application runtimes to retrieve only the deployed Mukuroji control profile.',
    statements: [new iam.PolicyStatement({
      actions: [
        'appconfig:GetLatestConfiguration',
        'appconfig:StartConfigurationSession',
      ],
      resources: [configurationArn],
    })],
  });

  return {
    applicationId: application.ref,
    canaryDeploymentStrategyId: canaryDeploymentStrategy.ref,
    configurationArn,
    configurationProfileId: configurationProfile.ref,
    environmentId: environment.ref,
    initialDeployment,
    readPolicy,
  };
}

/**
 * Grants one data-plane Lambda access to the shared control profile and injects stable identifiers.
 *
 * @param resources Shared AppConfig resources and least-privilege read policy.
 * @param targetFunction Application Lambda that consumes runtime controls.
 * @param runtimeScope Stable application surface used by runtime policy evaluation.
 * @returns Nothing.
 */
export function bindRuntimeControls(
  resources: RuntimeControlResources,
  targetFunction: lambdaNodejs.NodejsFunction,
  runtimeScope: RuntimeControlScope,
): void {
  if (!targetFunction.role) {
    throw new Error('Runtime-controlled Lambda execution role was not created.');
  }
  const targetResource = targetFunction.node.defaultChild;
  if (!targetResource) {
    throw new Error('Runtime-controlled Lambda resource was not created.');
  }

  resources.readPolicy.attachToRole(targetFunction.role);
  targetResource.node.addDependency(
    resources.initialDeployment,
    resources.readPolicy,
  );
  targetFunction.addEnvironment(
    'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID',
    resources.applicationId,
  );
  targetFunction.addEnvironment(
    'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID',
    resources.environmentId,
  );
  targetFunction.addEnvironment(
    'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID',
    resources.configurationProfileId,
  );
  targetFunction.addEnvironment(
    'MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS',
    '15',
  );
  targetFunction.addEnvironment(
    'MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS',
    '60',
  );
  targetFunction.addEnvironment(
    'MUKUROJI_RUNTIME_CONTROL_SCOPE',
    runtimeScope,
  );
}
