/** Registers cross-domain integrity operator-boundary tests. */
import { expect, test } from '@jest/globals';
import { synthesizedTemplate } from './test-support';

test('cross-domain integrity access is unattached, bounded, and read-only', () => {
  const document = synthesizedTemplate.toJSON();
  const policyLogicalId =
    document.Outputs.CrossDomainIntegrityOperatorPolicyArn?.Value?.Ref;

  expect(typeof policyLogicalId).toBe('string');
  if (typeof policyLogicalId !== 'string') {
    throw new Error('Integrity policy output does not reference a managed policy.');
  }

  const policy = document.Resources[policyLogicalId];
  expect(policy).toEqual(expect.objectContaining({
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: expect.objectContaining({
      Description:
        'Read-only access for bounded source and isolated-restore cross-domain integrity checks.',
      PolicyDocument: expect.objectContaining({
        Statement: expect.any(Array),
      }),
    }),
  }));
  expect(policy.Properties).not.toHaveProperty('Roles');
  expect(policy.Properties).not.toHaveProperty('Users');
  expect(policy.Properties).not.toHaveProperty('Groups');

  const statements = policy.Properties.PolicyDocument.Statement;
  expect(Array.isArray(statements)).toBe(true);
  if (!Array.isArray(statements)) {
    throw new Error('Integrity policy statements are invalid.');
  }

  const serialized = JSON.stringify(policy);
  const tableLogicalIds = [
    'AuditEventsTableName',
    'FileProofingTableName',
    'ProjectDirectoryTableName',
    'WorkItemsTableName',
    'WorkItemConfigurationTableName',
    'WorkspaceAccessTableName',
  ].map((outputName) => document.Outputs[outputName]?.Value?.Ref);
  if (!tableLogicalIds.every((logicalId): logicalId is string =>
    typeof logicalId === 'string')) {
    throw new Error('Integrity policy table outputs are incomplete.');
  }
  const fileBucketLogicalId = document.Outputs.FileBucketName?.Value?.Ref;
  if (typeof fileBucketLogicalId !== 'string') {
    throw new Error('Integrity policy file bucket output is incomplete.');
  }

  expect(statements).toEqual([
    {
      Action: 'dynamodb:Scan',
      Effect: 'Allow',
      Resource: tableLogicalIds.map((logicalId) => ({
        'Fn::GetAtt': [logicalId, 'Arn'],
      })),
    },
    {
      Action: 's3:ListBucket',
      Effect: 'Allow',
      Resource: {
        'Fn::GetAtt': [fileBucketLogicalId, 'Arn'],
      },
    },
    {
      Action: [
        's3:GetObjectVersion',
        's3:GetObjectVersionAttributes',
        's3:GetObjectVersionTagging',
      ],
      Effect: 'Allow',
      Resource: {
        'Fn::Join': [
          '',
          [
            { 'Fn::GetAtt': [fileBucketLogicalId, 'Arn'] },
            '/workspaces/*',
          ],
        ],
      },
    },
  ]);

  expect(serialized).not.toContain('"Resource":"*"');
  expect(serialized).not.toContain('dynamodb:PutItem');
  expect(serialized).not.toContain('dynamodb:DeleteItem');
  expect(serialized).not.toContain('dynamodb:RestoreTableToPointInTime');
  expect(serialized).not.toContain('s3:PutObject');
  expect(serialized).not.toContain('s3:DeleteObject');
});
