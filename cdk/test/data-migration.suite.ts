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

/** A synthesized CloudFormation resource, narrowed to the fields these tests read. */
type SynthesizedResource = {
  /** CloudFormation resource type. */
  readonly Type: string;
  /** Resource properties; empty when the template has none. */
  readonly Properties: Readonly<Record<string, unknown>>;
};

/**
 * Narrows a value to a plain object.
 *
 * @param value - Value to narrow.
 * @returns The object, or `undefined`.
 */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/**
 * Narrows a synthesized template entry to a resource with a type.
 *
 * @param value - Template entry.
 * @returns The resource.
 * @throws Error when the entry has no string `Type` or a non-object `Properties`.
 */
function readResource(value: unknown): SynthesizedResource {
  const record = readRecord(value);
  const properties = record?.Properties === undefined ? {} : readRecord(record.Properties);
  if (typeof record?.Type !== 'string' || properties === undefined) {
    throw new Error('Synthesized resource has an unexpected shape.');
  }
  return { Type: record.Type, Properties: properties };
}

/**
 * Reads the statements of an IAM policy resource.
 *
 * @param resource - `AWS::IAM::Policy` resource.
 * @returns The statements.
 * @throws Error when the policy document has no statement list.
 */
function readPolicyStatements(resource: SynthesizedResource): readonly unknown[] {
  const statements = readRecord(resource.Properties.PolicyDocument)?.Statement;
  if (!Array.isArray(statements)) throw new Error('IAM policy has no statement list.');
  return statements;
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

  const triggers = Object.values(document.Resources).map(readResource).filter((typed) => {
    const serialized = JSON.stringify(typed.Properties);
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
  const policies = Object.values(document.Resources).map(readResource).filter((typed) =>
    typed.Type === 'AWS::IAM::Policy'
      && JSON.stringify(typed.Properties.Roles ?? []).includes(roleLogicalId));
  expect(policies).toHaveLength(1);
  const [policy] = policies;
  if (policy === undefined) throw new Error('Data migration role has no policy.');
  const statements = readPolicyStatements(policy);
  expect(statements).toEqual(expect.arrayContaining([
    {
      Action: ['dynamodb:PutItem', 'dynamodb:Query'],
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [outputReference('DataMigrationCheckpointTableName'), 'Arn'] },
    },
  ]));
  // The row statement names exactly the allowlisted tables, in any order.
  const rowStatements = statements.map(readRecord).filter((statement) =>
    JSON.stringify(statement?.Action) === JSON.stringify(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Scan']));
  expect(rowStatements).toHaveLength(1);
  const rowResources = rowStatements[0]?.Resource;
  if (!Array.isArray(rowResources)) throw new Error('Row statement has no resource list.');
  expect(rowStatements[0]?.Effect).toBe('Allow');
  expect(rowResources.map((resource) => JSON.stringify(resource)).sort()).toEqual([
    { 'Fn::GetAtt': [outputReference('ProjectDirectoryTableName'), 'Arn'] },
    { 'Fn::GetAtt': [outputReference('WorkItemsTableName'), 'Arn'] },
  ].map((resource) => JSON.stringify(resource)).sort());
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
