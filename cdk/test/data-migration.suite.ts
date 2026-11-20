/** Registers data migration runner tests. */
import { expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { buildLambdaBuildPaths } from '../lib/config/lambda-build-paths';
import { buildDataMigration } from '../lib/subsystems/data-migration';
import { synthesizedTemplate } from './test-support';

/**
 * Finds the logical ID a stack output references.
 *
 * @param outputName - Output name.
 * @returns The referenced logical ID.
 */
function outputReference(outputName: string): string {
  const reference = synthesizedTemplate.toJSON().Outputs[outputName]?.Value?.Ref;
  if (typeof reference !== 'string') {
    throw new Error(`${outputName} does not reference a resource.`);
  }
  return reference;
}

test('data migration checkpoint table is retained, recoverable and keyed by migration and partition', () => {
  const document = synthesizedTemplate.toJSON();
  const table = document.Resources[outputReference('DataMigrationCheckpointTableName')];
  expect(table).toEqual(expect.objectContaining({
    Type: 'AWS::DynamoDB::Table',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      KeySchema: [
        { AttributeName: 'migrationId', KeyType: 'HASH' },
        { AttributeName: 'partitionId', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    }),
  }));
});

test('data migration function is operator-invoked only and pins its tables', () => {
  const document = synthesizedTemplate.toJSON();
  const functionLogicalId = outputReference('DataMigrationFunctionName');
  const migrationFunction = document.Resources[functionLogicalId];
  expect(migrationFunction.Properties).toEqual(expect.objectContaining({
    Runtime: 'nodejs22.x',
    Timeout: 900,
  }));
  const variables = migrationFunction.Properties.Environment.Variables;
  expect(variables.DATA_MIGRATION_CHECKPOINT_TABLE_NAME).toEqual({
    Ref: outputReference('DataMigrationCheckpointTableName'),
  });
  expect(JSON.stringify(variables.DATA_MIGRATION_TARGET_TABLES)).toContain('"work-items')
  expect(JSON.stringify(variables.DATA_MIGRATION_TARGET_TABLES)).toContain('"project-directory')

  const triggers = Object.values(document.Resources).filter((resource) => {
    const typed = resource as { Type?: string; Properties?: Record<string, unknown> };
    const serialized = JSON.stringify(typed.Properties ?? {});
    return (typed.Type === 'AWS::Lambda::EventSourceMapping'
      || typed.Type === 'AWS::Events::Rule'
      || typed.Type === 'AWS::Scheduler::Schedule'
      || typed.Type === 'AWS::Lambda::Permission'
      || typed.Type === 'AWS::Lambda::Url')
      && serialized.includes(functionLogicalId);
  });
  expect(triggers).toEqual([]);
  synthesizedTemplate.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    FunctionName: { Ref: functionLogicalId },
    MaximumRetryAttempts: 0,
  });
});

test('data migration role reads and replaces rows only in allowlisted tables', () => {
  const document = synthesizedTemplate.toJSON();
  const functionLogicalId = outputReference('DataMigrationFunctionName');
  const roleLogicalId = document.Resources[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
  const policies = Object.values(document.Resources).filter((resource) => {
    const typed = resource as { Type?: string; Properties?: { Roles?: unknown } };
    return typed.Type === 'AWS::IAM::Policy'
      && JSON.stringify(typed.Properties?.Roles ?? []).includes(roleLogicalId);
  }) as { Properties: { PolicyDocument: { Statement: unknown[] } } }[];
  expect(policies).toHaveLength(1);
  const statements = policies[0]?.Properties.PolicyDocument.Statement ?? [];
  expect(statements).toEqual(expect.arrayContaining([
    {
      Action: ['dynamodb:PutItem', 'dynamodb:Query'],
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [outputReference('DataMigrationCheckpointTableName'), 'Arn'] },
    },
    {
      Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Scan'],
      Effect: 'Allow',
      Resource: expect.arrayContaining([
        { 'Fn::GetAtt': [outputReference('WorkItemsTableName'), 'Arn'] },
        { 'Fn::GetAtt': [outputReference('ProjectDirectoryTableName'), 'Arn'] },
      ]),
    },
  ]));
  // Only the X-Ray statement that active tracing adds may use a wildcard resource.
  const serialized = JSON.stringify(statements.filter((statement) =>
    !JSON.stringify(statement).includes('xray:')));
  expect(statements).toHaveLength(4);
  for (const forbidden of [
    'dynamodb:DeleteItem',
    'dynamodb:UpdateItem',
    'dynamodb:BatchWriteItem',
    'dynamodb:DeleteTable',
    'dynamodb:CreateTable',
    '/index/*',
    '"Resource":"*"',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(document.Resources[roleLogicalId].Properties.ManagedPolicyArns).toBeUndefined();
});

test('data migration operator policy is unattached and only invokes the runner', () => {
  const document = synthesizedTemplate.toJSON();
  const policy = document.Resources[outputReference('DataMigrationOperatorPolicyArn')];
  expect(policy.Type).toBe('AWS::IAM::ManagedPolicy');
  expect(policy.Properties).not.toHaveProperty('Roles');
  expect(policy.Properties).not.toHaveProperty('Users');
  expect(policy.Properties).not.toHaveProperty('Groups');
  expect(policy.Properties.PolicyDocument.Statement).toEqual([{
    Action: 'lambda:InvokeFunction',
    Effect: 'Allow',
    Resource: { 'Fn::GetAtt': [outputReference('DataMigrationFunctionName'), 'Arn'] },
  }]);
});

test('data migration targets need unique lowercase logical names', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'DataMigrationTargets');
  const table = new dynamodb.Table(stack, 'Table', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  });
  expect(() => buildDataMigration(stack, {
    lambdaBuildPaths: buildLambdaBuildPaths(),
    targets: [{ logicalName: 'Work Items', table }],
  })).toThrow('unique lowercase logical table names');
  expect(() => buildDataMigration(stack, {
    lambdaBuildPaths: buildLambdaBuildPaths(),
    targets: [{ logicalName: 'work-items', table }, { logicalName: 'work-items', table }],
  })).toThrow('unique lowercase logical table names');
});
