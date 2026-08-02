/** Registers non-production Workspace Search alarm evidence sink tests. */
import { expect, test } from '@jest/globals';
import {
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_ACCOUNT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_REGION_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_ENVIRONMENT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
} from '../lib/subsystems/migration-storage';
import { expectQueueRequiresSsl, synthesizedTemplate } from './test-support';

/** Exact CloudFormation condition shared by every evidence-sink resource. */
const nonProductionCondition =
  'WorkspaceSearchMigrationAlarmEvidenceNonProduction';

/**
 * Narrows one synthesized value to a string-keyed record.
 *
 * @param value Candidate synthesized value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds exactly one synthesized resource by type and logical-ID prefix.
 *
 * @param resourceType Exact CloudFormation resource type.
 * @param logicalIdPrefix Stable logical-ID prefix.
 * @returns Matching logical ID and resource record.
 */
function findResource(
  resourceType: string,
  logicalIdPrefix: string,
): readonly [string, Record<string, unknown>] {
  const matches = Object.entries(
    synthesizedTemplate.findResources(resourceType),
  ).filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (match === undefined || !isRecord(match[1])) {
    throw new Error(`${logicalIdPrefix} was not synthesized exactly once.`);
  }
  return [match[0], match[1]];
}

/**
 * Reads one required object property from a synthesized record.
 *
 * @param owner Record owning the property.
 * @param propertyName Required property name.
 * @returns Narrowed property record.
 */
function readRecord(
  owner: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const value = owner[propertyName];
  if (!isRecord(value)) {
    throw new Error(`${propertyName} is not a synthesized object.`);
  }
  return value;
}

test('gates every alarm evidence resource and output on explicit non-production', () => {
  expect(synthesizedTemplate.toJSON().Conditions[nonProductionCondition])
    .toEqual({
      'Fn::Equals': [
        'production-disabled',
        'non-production',
      ],
    });

  for (const [logicalId, resource] of Object.entries(
    synthesizedTemplate.toJSON().Resources,
  )) {
    if (logicalId.includes('WorkspaceSearchMigrationAlarmEvidence')) {
      if (!isRecord(resource)) {
        throw new Error(`${logicalId} is not a synthesized resource.`);
      }
      expect(resource.Condition).toBe(nonProductionCondition);
    }
  }
  for (const [logicalId, output] of Object.entries(
    synthesizedTemplate.toJSON().Outputs,
  )) {
    if (logicalId.includes('WorkspaceSearchMigrationAlarmEvidence')) {
      if (!isRecord(output)) {
        throw new Error(`${logicalId} is not a synthesized output.`);
      }
      expect(output.Condition).toBe(nonProductionCondition);
    }
  }
});

test('binds retained alarm evidence sinks to the deployment trust root', () => {
  const synthesized = synthesizedTemplate.toJSON();
  const trustTags = [
    {
      Key: WORKSPACE_SEARCH_MIGRATION_ENVIRONMENT_TAG_KEY,
      Value: 'production',
    },
    {
      Key: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_ACCOUNT_TAG_KEY,
      Value: { Ref: 'AWS::AccountId' },
    },
    {
      Key: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_REGION_TAG_KEY,
      Value: { Ref: 'AWS::Region' },
    },
    {
      Key: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_TAG_KEY,
      Value: 'production-disabled',
    },
    {
      Key: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION_TAG_KEY,
      Value: '1',
    },
    {
      Key: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
      Value:
        synthesized.Outputs
          .WorkspaceSearchMigrationDeploymentTrustRootDigest.Value,
    },
    {
      Key: WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
      Value:
        synthesized.Outputs
          .WorkspaceSearchMigrationProductionAccountDigest.Value,
    },
  ];
  const resources = [
    findResource(
      'AWS::SQS::Queue',
      'WorkspaceSearchMigrationAlarmEvidencePrimaryQueue',
    )[1],
    findResource(
      'AWS::SQS::Queue',
      'WorkspaceSearchMigrationAlarmEvidenceSecondaryQueue',
    )[1],
    findResource(
      'AWS::Logs::LogGroup',
      'WorkspaceSearchMigrationAlarmEvidenceSignalLogGroup',
    )[1],
  ];

  for (const resource of resources) {
    expect(readRecord(resource, 'Properties').Tags).toEqual(
      expect.arrayContaining(trustTags),
    );
  }
  expect(JSON.stringify(trustTags)).not.toContain(
    'workspace-search-migration-production-account"',
  );
});

test('retains encrypted TLS-only primary and secondary receipt queues', () => {
  for (const route of ['Primary', 'Secondary']) {
    const [logicalId, queue] = findResource(
      'AWS::SQS::Queue',
      `WorkspaceSearchMigrationAlarmEvidence${route}Queue`,
    );
    expect(queue).toEqual(expect.objectContaining({
      Condition: nonProductionCondition,
      DeletionPolicy: 'Retain',
      Properties: expect.objectContaining({
        MaximumMessageSize: 65_536,
        MessageRetentionPeriod: 1_209_600,
        ReceiveMessageWaitTimeSeconds: 20,
        SqsManagedSseEnabled: true,
        VisibilityTimeout: 120,
      }),
      Type: 'AWS::SQS::Queue',
      UpdateReplacePolicy: 'Retain',
    }));
    expectQueueRequiresSsl(synthesizedTemplate, logicalId);
  }
});

test('precreates one retained fixed EMF log stream only in non-production', () => {
  const [logGroupId, logGroup] = findResource(
    'AWS::Logs::LogGroup',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogGroup',
  );
  expect(logGroup).toEqual(expect.objectContaining({
    Condition: nonProductionCondition,
    DeletionPolicy: 'Retain',
    Properties: expect.objectContaining({
      LogGroupName: '/mukuroji/Test/workspace-search-migration/rehearsal',
      RetentionInDays: 365,
    }),
    Type: 'AWS::Logs::LogGroup',
    UpdateReplacePolicy: 'Retain',
  }));
  const [, logStream] = findResource(
    'AWS::Logs::LogStream',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStream',
  );
  expect(logStream).toEqual({
    Condition: nonProductionCondition,
    DeletionPolicy: 'Retain',
    Properties: {
      LogGroupName: { Ref: logGroupId },
      LogStreamName: 'alarm-signals-v1',
    },
    Type: 'AWS::Logs::LogStream',
    UpdateReplacePolicy: 'Retain',
  });
});

test('subscribes each route only to the six real migration ALARM notifications', () => {
  const subscriptions = Object.values(
    synthesizedTemplate.findResources('AWS::SNS::Subscription'),
  );
  expect(subscriptions).toHaveLength(2);
  const expectedAlarmPrefixes = [
    'WorkspaceSearchMigrationDescribeTableThrottleAlarm',
    'WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
    'WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
    'WorkspaceSearchMigrationCheckpointStallAlarm',
    'WorkspaceSearchMigrationQuarantineAlarm',
    'WorkspaceSearchMigrationTerminalFailureAlarm',
  ];
  const topicParameterNames = new Set<string>();

  for (const subscription of subscriptions) {
    expect(subscription.Condition).toBe(nonProductionCondition);
    const properties = readRecord(subscription, 'Properties');
    expect(properties).toEqual(expect.objectContaining({
      FilterPolicyScope: 'MessageBody',
      Protocol: 'sqs',
      RawMessageDelivery: false,
    }));
    const filterPolicy = readRecord(properties, 'FilterPolicy');
    expect(filterPolicy.NewStateValue).toEqual(['ALARM']);
    if (!Array.isArray(filterPolicy.AlarmName)) {
      throw new Error('AlarmName filter is not an array.');
    }
    expect(filterPolicy.AlarmName).toHaveLength(6);
    for (const [index, filterValue] of filterPolicy.AlarmName.entries()) {
      const value = readRecord({ value: filterValue }, 'value');
      const reference = value.Ref;
      expect(typeof reference).toBe('string');
      expect(reference).toEqual(expect.stringMatching(
        new RegExp(`^${expectedAlarmPrefixes[index]}`),
      ));
    }
    const serializedTopicArn = JSON.stringify(properties.TopicArn);
    const topicParameterName = serializedTopicArn.includes(
      'AlarmPrimaryTopicName',
    )
      ? 'AlarmPrimaryTopicName'
      : 'AlarmSecondaryTopicName';
    topicParameterNames.add(topicParameterName);
  }
  expect(topicParameterNames).toEqual(new Set([
    'AlarmPrimaryTopicName',
    'AlarmSecondaryTopicName',
  ]));
});

test('keeps collector permissions unattached and restricted to queues and history', () => {
  const [primaryQueueId] = findResource(
    'AWS::SQS::Queue',
    'WorkspaceSearchMigrationAlarmEvidencePrimaryQueue',
  );
  const [secondaryQueueId] = findResource(
    'AWS::SQS::Queue',
    'WorkspaceSearchMigrationAlarmEvidenceSecondaryQueue',
  );
  const [, policy] = findResource(
    'AWS::IAM::ManagedPolicy',
    'WorkspaceSearchMigrationAlarmEvidenceCollectorPolicy',
  );
  expect(policy.Condition).toBe(nonProductionCondition);
  const properties = readRecord(policy, 'Properties');
  expect(properties.Roles).toBeUndefined();
  expect(properties.Users).toBeUndefined();
  expect(properties.Groups).toBeUndefined();
  const document = readRecord(properties, 'PolicyDocument');
  if (!Array.isArray(document.Statement)) {
    throw new Error('Collector policy statements are not an array.');
  }
  expect(document.Statement).toHaveLength(2);
  expect(document.Statement[0]).toEqual({
    Action: [
      'sqs:DeleteMessage',
      'sqs:ReceiveMessage',
    ],
    Effect: 'Allow',
    Resource: [
      { 'Fn::GetAtt': [primaryQueueId, 'Arn'] },
      { 'Fn::GetAtt': [secondaryQueueId, 'Arn'] },
    ],
  });
  const historyStatement = readRecord(
    { statement: document.Statement[1] },
    'statement',
  );
  expect(historyStatement.Action).toBe('cloudwatch:DescribeAlarmHistory');
  expect(historyStatement.Effect).toBe('Allow');
  if (!Array.isArray(historyStatement.Resource)) {
    throw new Error('Alarm history resources are not an array.');
  }
  expect(historyStatement.Resource).toHaveLength(6);
  for (const resource of historyStatement.Resource) {
    const value = readRecord({ value: resource }, 'value');
    expect(value['Fn::GetAtt']).toBeDefined();
  }
  const serializedPolicy = JSON.stringify(document);
  expect(serializedPolicy).not.toContain('cloudwatch:SetAlarmState');
  expect(serializedPolicy).not.toContain('sns:Publish');
});

test('keeps ingestion permission unattached and restricted to the fixed stream', () => {
  const [logGroupId] = findResource(
    'AWS::Logs::LogGroup',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogGroup',
  );
  const [logStreamId] = findResource(
    'AWS::Logs::LogStream',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStream',
  );
  const [, ingestionPolicy] = findResource(
    'AWS::IAM::ManagedPolicy',
    'WorkspaceSearchMigrationAlarmEvidenceIngestionPolicy',
  );
  expect(ingestionPolicy.Condition).toBe(nonProductionCondition);
  const properties = readRecord(ingestionPolicy, 'Properties');
  expect(properties.Roles).toBeUndefined();
  expect(properties.Users).toBeUndefined();
  expect(properties.Groups).toBeUndefined();
  const document = readRecord(properties, 'PolicyDocument');
  expect(document.Statement).toEqual([{
    Action: 'logs:PutLogEvents',
    Effect: 'Allow',
    Resource: {
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':logs:',
          { Ref: 'AWS::Region' },
          ':',
          { Ref: 'AWS::AccountId' },
          ':log-group:',
          { Ref: logGroupId },
          ':log-stream:',
          { Ref: logStreamId },
        ],
      ],
    },
  }]);
  const [, operatorPolicy] = findResource(
    'AWS::IAM::ManagedPolicy',
    'WorkspaceSearchMigrationOperatorPolicy',
  );
  expect(JSON.stringify(operatorPolicy)).not.toContain('logs:PutLogEvents');
});

test('publishes only conditionally usable queue, policy, and canonical alarm bindings', () => {
  const outputs = synthesizedTemplate.toJSON().Outputs;
  for (const outputName of [
    'WorkspaceSearchMigrationAlarmEvidenceAlarmArns',
    'WorkspaceSearchMigrationAlarmEvidencePrimaryQueueUrl',
    'WorkspaceSearchMigrationAlarmEvidenceSecondaryQueueUrl',
    'WorkspaceSearchMigrationAlarmEvidenceCollectorPolicyArn',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogGroupName',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStreamName',
    'WorkspaceSearchMigrationAlarmEvidenceSignalLogStreamArn',
    'WorkspaceSearchMigrationAlarmEvidenceIngestionPolicyArn',
    'WorkspaceSearchMigrationAlarmEvidenceDeploymentTrustRootDigest',
    'WorkspaceSearchMigrationAlarmEvidenceDeploymentTargetId',
  ]) {
    expect(outputs[outputName]).toEqual(expect.objectContaining({
      Condition: nonProductionCondition,
    }));
  }
  const alarmArns = outputs.WorkspaceSearchMigrationAlarmEvidenceAlarmArns;
  const value = readRecord(alarmArns, 'Value');
  const join = value['Fn::Join'];
  if (!Array.isArray(join) || !Array.isArray(join[1])) {
    throw new Error('Alarm ARN output is not a canonical joined vector.');
  }
  expect(join[0]).toBe(',');
  expect(join[1]).toHaveLength(6);
});
