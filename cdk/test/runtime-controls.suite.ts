/** Registers AWS AppConfig runtime-control infrastructure tests. */
import { expect, test } from '@jest/globals';
import {
  API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  findApiRuntimeConfigurationSource,
  synthesizedTemplate,
} from './test-support';

const runtimeControlEnvironmentKeys = [
  'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID',
  'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID',
  'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID',
  'MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS',
  'MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS',
  'MUKUROJI_RUNTIME_CONTROL_SCOPE',
] as const;

const controlledFunctionScopes = new Map([
  ['AnalyticsScheduleFunctionBB9E6044', 'analytics-schedule'],
  ['ListProjectTasksFunction2134AF4A', 'api'],
  ['CollaborationProjectionFunction1AAC5764', 'audit-projection'],
  ['AutomationEventFunction5E8CB543', 'automation-event'],
  ['AutomationScheduleFunction29B41328', 'automation-schedule'],
  ['ConnectorPollFunctionB3EBB19B', 'connector-poll'],
  ['ConnectorSyncFunctionA70281DA', 'connector-sync'],
  [
    'EnterpriseIdentityMaintenanceFunction543109E4',
    'enterprise-identity-maintenance',
  ],
  ['EnterpriseScimGroupJobFunction351DCF72', 'enterprise-scim-group-job'],
  ['NotificationScheduleFunction633E4F4C', 'notification-schedule'],
  ['RealtimeHandlerFunction8A4BF05B', 'realtime'],
  ['RequestEmailIngestionFunction84289AE7', 'request-intake-email'],
  ['WebhookDeliveryFunctionEA305509', 'webhook-delivery'],
  ['WorkItemImportFunction651B2883', 'work-item-import'],
]);

const apiFunctionLogicalId = 'ListProjectTasksFunction2134AF4A';
const directlyConfiguredFunctionScopes = new Map(
  [...controlledFunctionScopes].filter(([logicalId]) =>
    logicalId !== apiFunctionLogicalId
  ),
);

const migrationFunctionIds = new Set([
  'WebhookAuthorizationBackfillFunction5ABBA705',
  'WebhookAuthorizationBackfillProgressFunction1FF04FD2',
]);

const runtimeControlPlaneFunctionIds = new Set([
  'RuntimeControlAlarmReadinessOnEventFunctionA25C5A0C',
  'RuntimeControlAlarmReadinessPollFunctionCD017060',
]);

const restoreDrillFunctionIds = new Set([
  'RestoreDrillCleanupFunctionAB0B8AED',
  'RestoreDrillRunnerFunction5F951D72',
]);

const fileStorageInfrastructureFunctionIds = new Set([
  'FileBucketIncarnationMarkerFunctionBCDA95D8',
]);

/**
 * Narrows an unknown synthesized value to a string-keyed record.
 *
 * @param value Candidate synthesized value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a Step Functions definition emitted as a CloudFormation Fn::Join.
 *
 * Intrinsic fragments are replaced with inert string placeholders so the
 * surrounding Amazon States Language document can be asserted structurally.
 *
 * @param value Synthesized DefinitionString value.
 * @returns Parsed Amazon States Language document.
 */
function parseJoinedStateMachineDefinition(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error('State machine definition was not synthesized.');
  }
  const join = value['Fn::Join'];
  if (
    !Array.isArray(join) ||
    join.length !== 2 ||
    typeof join[0] !== 'string' ||
    !Array.isArray(join[1])
  ) {
    throw new Error('State machine definition is not an Fn::Join.');
  }
  const serialized = join[1]
    .map((fragment: unknown) =>
      typeof fragment === 'string' ? fragment : 'TOKEN')
    .join(join[0]);
  return JSON.parse(serialized);
}

test('retains a validated hosted baseline and deploys it all at once', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const retainedResourceIds = [
    'RuntimeControlApplication',
    'RuntimeControlEnvironment',
    'RuntimeControlConfigurationProfile',
    'RuntimeControlInitialConfiguration',
    'RuntimeControlCanaryDeploymentStrategy',
    'RuntimeControlConfigurationFailureAlarm48E6159E',
    'RuntimeControlAlarmMonitorRole5C5A5276',
    'RuntimeControlAlarmMonitorPolicyBB68C59F',
  ];

  template.resourceCountIs('AWS::AppConfig::Application', 1);
  template.resourceCountIs('AWS::AppConfig::Environment', 1);
  template.resourceCountIs('AWS::AppConfig::ConfigurationProfile', 1);
  template.resourceCountIs('AWS::AppConfig::HostedConfigurationVersion', 1);
  template.resourceCountIs('AWS::AppConfig::Deployment', 1);
  template.resourceCountIs('AWS::AppConfig::DeploymentStrategy', 1);

  for (const logicalId of retainedResourceIds) {
    expect(resources[logicalId]).toEqual(expect.objectContaining({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    }));
  }

  expect(resources.RuntimeControlApplication.Properties).toEqual({
    Description:
      'Dynamic operational controls shared by Mukuroji application runtimes.',
    Name: 'mukuroji-runtime-controls',
  });
  expect(resources.RuntimeControlEnvironment.Properties).toEqual(
    expect.objectContaining({
      ApplicationId: { Ref: 'RuntimeControlApplication' },
      DeletionProtectionCheck: 'APPLY',
      Name: 'production',
    }),
  );
  expect(resources.RuntimeControlEnvironment.DependsOn).toEqual([
    'RuntimeControlAlarmMonitorPolicyBB68C59F',
    'RuntimeControlAlarmReadiness',
  ]);

  const profile = resources.RuntimeControlConfigurationProfile;
  expect(profile.Properties).toEqual(expect.objectContaining({
    ApplicationId: { Ref: 'RuntimeControlApplication' },
    DeletionProtectionCheck: 'APPLY',
    LocationUri: 'hosted',
    Name: 'runtime-controls',
    Type: 'AWS.Freeform',
  }));
  const validator = profile.Properties.Validators?.[0];
  expect(validator?.Type).toBe('JSON_SCHEMA');
  expect(typeof validator?.Content).toBe('string');
  if (typeof validator?.Content !== 'string') {
    throw new Error('Runtime-control JSON Schema validator was not synthesized.');
  }
  expect(JSON.parse(validator.Content)).toEqual({
    $schema: 'http://json-schema.org/draft-04/schema#',
    additionalProperties: false,
    properties: {
      mode: {
        enum: ['enabled', 'disabled'],
        type: 'string',
      },
      revision: {
        maximum: 9_007_199_254_740_991,
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
  });

  const initialConfiguration =
    resources.RuntimeControlInitialConfiguration.Properties;
  expect(initialConfiguration).toEqual(expect.objectContaining({
    ApplicationId: { Ref: 'RuntimeControlApplication' },
    ConfigurationProfileId: {
      Ref: 'RuntimeControlConfigurationProfile',
    },
    ContentType: 'application/json',
    Description:
      'Fail-closed baseline for explicit application processing rollout.',
  }));
  expect(initialConfiguration.VersionLabel).toBeUndefined();
  expect(typeof initialConfiguration.Content).toBe('string');
  if (typeof initialConfiguration.Content !== 'string') {
    throw new Error('Initial runtime-control configuration was not synthesized.');
  }
  expect(JSON.parse(initialConfiguration.Content)).toEqual({
    mode: 'disabled',
    revision: 1,
    schemaVersion: 1,
  });

  expect(resources.RuntimeControlInitialDeployment.Properties).toEqual({
    ApplicationId: { Ref: 'RuntimeControlApplication' },
    ConfigurationProfileId: {
      Ref: 'RuntimeControlConfigurationProfile',
    },
    ConfigurationVersion: {
      Ref: 'RuntimeControlInitialConfiguration',
    },
    DeploymentStrategyId: 'AppConfig.AllAtOnce',
    Description:
      'Bootstraps the validated disabled runtime-control configuration.',
    EnvironmentId: { Ref: 'RuntimeControlEnvironment' },
  });
});

test('publishes a retained 20-minute exponential canary strategy and identifiers', () => {
  const template = synthesizedTemplate;
  const document = template.toJSON();

  expect(
    document.Resources.RuntimeControlCanaryDeploymentStrategy.Properties,
  ).toEqual({
    DeploymentDurationInMinutes: 20,
    Description:
      'Rolls reviewed runtime controls out as a 10 percent canary before a final monitored bake.',
    FinalBakeTimeInMinutes: 10,
    GrowthFactor: 10,
    GrowthType: 'EXPONENTIAL',
    Name: 'mukuroji-runtime-control-canary',
    ReplicateTo: 'NONE',
  });
  expect(document.Outputs.RuntimeControlApplicationId.Value).toEqual({
    Ref: 'RuntimeControlApplication',
  });
  expect(document.Outputs.RuntimeControlEnvironmentId.Value).toEqual({
    Ref: 'RuntimeControlEnvironment',
  });
  expect(
    document.Outputs.RuntimeControlConfigurationProfileId.Value,
  ).toEqual({
    Ref: 'RuntimeControlConfigurationProfile',
  });
  expect(
    document.Outputs.RuntimeControlCanaryDeploymentStrategyId.Value,
  ).toEqual({
    Ref: 'RuntimeControlCanaryDeploymentStrategy',
  });
});

test('rolls back only on dedicated runtime-control configuration failures', () => {
  const resources = synthesizedTemplate.toJSON().Resources;

  expect(
    resources.RuntimeControlConfigurationFailureAlarm48E6159E.Properties,
  ).toEqual(expect.objectContaining({
    AlarmDescription:
      'Detects invalid dynamic runtime-control configuration.',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    DatapointsToAlarm: 1,
    Dimensions: [
      {
        Name: 'ControlId',
        Value: {
          'Fn::Join': [
            ':',
            [
              { Ref: 'RuntimeControlApplication' },
              { Ref: 'RuntimeControlConfigurationProfile' },
            ],
          ],
        },
      },
      {
        Name: 'Service',
        Value: 'mukuroji-runtime-control',
      },
    ],
    EvaluationPeriods: 1,
    MetricName: 'ConfigurationFailureCount',
    Namespace: 'Mukuroji/RuntimeControl',
    Period: 300,
    Statistic: 'Sum',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  }));
  expect(resources.RuntimeControlEnvironment.Properties.Monitors).toEqual([{
    AlarmArn: {
      'Fn::GetAtt': [
        'RuntimeControlConfigurationFailureAlarm48E6159E',
        'Arn',
      ],
    },
    AlarmRoleArn: {
      'Fn::GetAtt': [
        'RuntimeControlAlarmMonitorRole5C5A5276',
        'Arn',
      ],
    },
  }]);

  expect(
    resources.RuntimeControlAlarmMonitorRole5C5A5276.Properties
      .AssumeRolePolicyDocument,
  ).toEqual({
    Statement: [{
      Action: 'sts:AssumeRole',
      Effect: 'Allow',
      Principal: { Service: 'appconfig.amazonaws.com' },
    }],
    Version: '2012-10-17',
  });
  expect(
    resources.RuntimeControlAlarmMonitorPolicyBB68C59F.Properties,
  ).toEqual(expect.objectContaining({
    PolicyDocument: {
      Statement: [{
        Action: 'cloudwatch:DescribeAlarms',
        Effect: 'Allow',
        Resource: '*',
      }],
      Version: '2012-10-17',
    },
    Roles: [{ Ref: 'RuntimeControlAlarmMonitorRole5C5A5276' }],
  }));
});

test('waits read-only for a naturally OK actionable alarm before environment creation', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const readiness = resources.RuntimeControlAlarmReadiness;

  expect(readiness).toEqual(expect.objectContaining({
    Type: 'Custom::RuntimeControlAlarmReadiness',
    DependsOn: ['RuntimeControlConfigurationFailureAlarm48E6159E'],
    Properties: {
      AlarmName: {
        Ref: 'RuntimeControlConfigurationFailureAlarm48E6159E',
      },
      ReadinessContractVersion: 'v1',
      ServiceToken: {
        'Fn::GetAtt': [
          'RuntimeControlAlarmReadinessProviderframeworkonEventEEDFF96D',
          'Arn',
        ],
      },
    },
  }));

  for (const [logicalId, handler] of [
    [
      'RuntimeControlAlarmReadinessOnEventFunctionA25C5A0C',
      'index.onEventHandler',
    ],
    [
      'RuntimeControlAlarmReadinessPollFunctionCD017060',
      'index.isCompleteHandler',
    ],
  ]) {
    expect(resources[logicalId].Properties).toEqual(expect.objectContaining({
      Handler: handler,
      MemorySize: 256,
      Runtime: 'nodejs22.x',
      Timeout: 30,
      TracingConfig: { Mode: 'Active' },
    }));
  }

  for (const logicalId of [
    'RuntimeControlAlarmReadinessOnEventLogGroup30C1AD75',
    'RuntimeControlAlarmReadinessPollLogGroup4B14D692',
    'RuntimeControlAlarmReadinessProviderLogGroup26888D8C',
  ]) {
    expect(resources[logicalId]).toEqual(expect.objectContaining({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { RetentionInDays: 90 },
      Type: 'AWS::Logs::LogGroup',
    }));
  }

  const providerFunctions = Object.entries(
    synthesizedTemplate.findResources('AWS::Lambda::Function'),
  ).filter(
    ([, resource]) =>
      resource.Properties?.Description?.includes(
        'RuntimeControlAlarmReadinessProvider',
      ),
  );
  expect(providerFunctions).toHaveLength(3);
  for (const [, providerFunction] of providerFunctions) {
    expect(providerFunction.Properties.LoggingConfig?.LogGroup).toEqual({
      Ref: 'RuntimeControlAlarmReadinessProviderLogGroup26888D8C',
    });
  }

  const stateMachine = Object.entries(
    synthesizedTemplate.findResources('AWS::StepFunctions::StateMachine'),
  ).find(
    ([logicalId]) =>
      logicalId.startsWith(
        'RuntimeControlAlarmReadinessProviderwaiterstatemachine',
      ),
  );
  expect(stateMachine).toBeDefined();
  expect(parseJoinedStateMachineDefinition(
    stateMachine?.[1].Properties.DefinitionString,
  )).toMatchObject({
    States: {
      'framework-isComplete-task': {
        Retry: [{
          BackoffRate: 1,
          ErrorEquals: ['States.ALL'],
          IntervalSeconds: 10,
          MaxAttempts: 90,
        }],
      },
    },
  });

  expect(
    resources
      .RuntimeControlAlarmReadinessOnEventFunctionServiceRoleDefaultPolicy7CBFAE31
      .Properties.PolicyDocument.Statement,
  ).toEqual([{
    Action: [
      'xray:PutTelemetryRecords',
      'xray:PutTraceSegments',
    ],
    Effect: 'Allow',
    Resource: '*',
  }]);
  expect(
    resources
      .RuntimeControlAlarmReadinessPollFunctionServiceRoleDefaultPolicy80840E61
      .Properties.PolicyDocument.Statement,
  ).toEqual([{
    Action: [
      'cloudwatch:DescribeAlarms',
      'xray:PutTelemetryRecords',
      'xray:PutTraceSegments',
    ],
    Effect: 'Allow',
    Resource: '*',
  }]);
});

test('grants the fourteen data-plane roles only the exact configuration ARN', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const readPolicy = resources.RuntimeControlReadPolicyF2A31863.Properties;
  const controlledRoleReferences = [...controlledFunctionScopes.keys()]
    .map((logicalId) => {
      const roleReference =
        resources[logicalId].Properties.Role?.['Fn::GetAtt']?.[0];
      expect(typeof roleReference).toBe('string');
      if (typeof roleReference !== 'string') {
        throw new Error(`${logicalId} does not reference an execution role.`);
      }

      return { Ref: roleReference };
    });

  expect(readPolicy.PolicyDocument).toEqual({
    Statement: [{
      Action: [
        'appconfig:GetLatestConfiguration',
        'appconfig:StartConfigurationSession',
      ],
      Effect: 'Allow',
      Resource: {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':appconfig:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':application/',
            { Ref: 'RuntimeControlApplication' },
            '/environment/',
            { Ref: 'RuntimeControlEnvironment' },
            '/configuration/',
            { Ref: 'RuntimeControlConfigurationProfile' },
          ],
        ],
      },
    }],
    Version: '2012-10-17',
  });
  expect(readPolicy.Roles).toHaveLength(14);
  expect(readPolicy.Roles).toEqual(
    expect.arrayContaining(controlledRoleReferences),
  );
});

test('binds exact runtime-control settings through API config and thirteen direct environments', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const lambdaEntries = Object.entries(
    synthesizedTemplate.findResources('AWS::Lambda::Function'),
  );

  expect(resources[apiFunctionLogicalId]).toBeDefined();
  for (const [logicalId, expectedScope] of controlledFunctionScopes) {
    expect(resources[logicalId].DependsOn).toEqual(
      expect.arrayContaining([
        'RuntimeControlInitialDeployment',
        'RuntimeControlReadPolicyF2A31863',
      ]),
    );
    if (logicalId === apiFunctionLogicalId) {
      continue;
    }
    const variables = resources[logicalId].Properties.Environment?.Variables;
    expect(variables).toEqual(expect.objectContaining({
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: {
        Ref: 'RuntimeControlApplication',
      },
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: {
        Ref: 'RuntimeControlConfigurationProfile',
      },
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: {
        Ref: 'RuntimeControlEnvironment',
      },
      MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS: '60',
      MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS: '15',
      MUKUROJI_RUNTIME_CONTROL_SCOPE: expectedScope,
    }));
  }

  const coreConfigurationSecretId =
    API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID;
  const coreConfiguration = resources[coreConfigurationSecretId]
    .Properties.SecretString;
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID',
  )).toEqual({
      'Fn::Base64': { Ref: 'RuntimeControlApplication' },
  });
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID',
  )).toEqual({
      'Fn::Base64': { Ref: 'RuntimeControlConfigurationProfile' },
  });
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID',
  )).toEqual({
      'Fn::Base64': { Ref: 'RuntimeControlEnvironment' },
  });
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS',
  )).toEqual({ 'Fn::Base64': '60' });
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS',
  )).toEqual({ 'Fn::Base64': '15' });
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_RUNTIME_CONTROL_SCOPE',
  )).toEqual({ 'Fn::Base64': 'api' });
  const apiVariables = resources[apiFunctionLogicalId]
    .Properties.Environment.Variables;
  expect(apiVariables).toEqual(expect.objectContaining({
    MUKUROJI_API_CORE_CONFIG_SECRET_ARN: {
      Ref: coreConfigurationSecretId,
    },
  }));
  for (const environmentKey of runtimeControlEnvironmentKeys) {
    expect(apiVariables[environmentKey]).toBeUndefined();
  }

  const runtimeControlledEntries = lambdaEntries.filter(([, resource]) =>
    resource.Properties?.Environment?.Variables
      ?.MUKUROJI_RUNTIME_CONTROL_SCOPE !== undefined
  );
  expect(runtimeControlledEntries.map(([logicalId]) => logicalId).sort())
    .toEqual([...directlyConfiguredFunctionScopes.keys()].sort());

  for (const [, resource] of lambdaEntries.filter(
    ([logicalId]) => !controlledFunctionScopes.has(logicalId),
  )) {
    const variables = resource.Properties.Environment?.Variables;
    for (const environmentKey of runtimeControlEnvironmentKeys) {
      expect(variables?.[environmentKey]).toBeUndefined();
    }
  }

  const infrastructureFunctionIds = lambdaEntries
    .filter(([logicalId, resource]) => {
      const description = resource.Properties?.Description;
      return runtimeControlPlaneFunctionIds.has(logicalId) ||
        restoreDrillFunctionIds.has(logicalId) ||
        fileStorageInfrastructureFunctionIds.has(logicalId) ||
        logicalId.startsWith('AWS679f53fac002430cb0da5b7982bd2287') ||
        (
          typeof description === 'string' &&
          (
            description.startsWith(
              'AWS CDK resource provider framework -',
            ) ||
            description.startsWith(
              'AWS CloudFormation handler for "Custom::S3BucketNotifications"',
            )
          )
        );
    })
    .map(([logicalId]) => logicalId);
  const classifiedFunctionIds = [
    ...controlledFunctionScopes.keys(),
    ...migrationFunctionIds,
    ...infrastructureFunctionIds,
  ];

  expect(new Set(classifiedFunctionIds).size).toBe(
    classifiedFunctionIds.length,
  );
  expect(classifiedFunctionIds.sort()).toEqual(
    lambdaEntries.map(([logicalId]) => logicalId).sort(),
  );
});
