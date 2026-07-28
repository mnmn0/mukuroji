/** Registers Workspace Search migration storage and least-privilege IAM tests. */
import { expect, test } from '@jest/globals';
import { synthesizedTemplate } from './test-support';

/**
 * Narrows synthesized CloudFormation fragments before semantic inspection.
 *
 * @param value Untrusted synthesized value.
 * @returns Whether the value is a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('Workspace Search migration state is retained, encrypted, protected, and recoverable', () => {
  const template = synthesizedTemplate;
  const synthesized = template.toJSON();
  const stateTableId =
    synthesized.Outputs.WorkspaceSearchMigrationStateTableName?.Value?.Ref;

  expect(typeof stateTableId).toBe('string');
  if (typeof stateTableId !== 'string') {
    throw new Error('Migration state table output does not reference a table.');
  }

  expect(synthesized.Resources[stateTableId]).toEqual(
    expect.objectContaining({
      DeletionPolicy: 'Retain',
      Type: 'AWS::DynamoDB::Table',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        AttributeDefinitions: [
          { AttributeName: 'migrationId', AttributeType: 'S' },
          { AttributeName: 'recordKey', AttributeType: 'S' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        DeletionProtectionEnabled: true,
        KeySchema: [
          { AttributeName: 'migrationId', KeyType: 'HASH' },
          { AttributeName: 'recordKey', KeyType: 'RANGE' },
        ],
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
        SSESpecification: {
          SSEEnabled: true,
        },
      }),
    }),
  );
  expect(synthesized.Resources[stateTableId].Properties)
    .not.toHaveProperty('TimeToLiveSpecification');
});

test('Workspace Search journal is retained, write-once, encrypted, and access logged', () => {
  const template = synthesizedTemplate;
  const synthesized = template.toJSON();
  const journalBucketId =
    synthesized.Outputs.WorkspaceSearchMigrationJournalBucketName?.Value?.Ref;
  const journalKeyId =
    synthesized.Outputs.WorkspaceSearchMigrationJournalKeyArn?.Value?.['Fn::GetAtt']?.[0];

  expect(typeof journalBucketId).toBe('string');
  expect(typeof journalKeyId).toBe('string');
  if (typeof journalBucketId !== 'string' || typeof journalKeyId !== 'string') {
    throw new Error('Migration journal outputs do not reference durable resources.');
  }

  const journalBucket = synthesized.Resources[journalBucketId];
  const journalKey = synthesized.Resources[journalKeyId];
  const accessLogsBucketId =
    journalBucket.Properties.LoggingConfiguration?.DestinationBucketName?.Ref;

  expect(typeof accessLogsBucketId).toBe('string');
  if (typeof accessLogsBucketId !== 'string') {
    throw new Error('Migration journal does not reference an access-log bucket.');
  }

  expect(journalKey).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    Type: 'AWS::KMS::Key',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      Description:
        'Encrypts lossless Workspace Search migration preimage journal segments.',
      EnableKeyRotation: true,
    }),
  }));
  expect(journalBucket).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    Type: 'AWS::S3::Bucket',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: {
            KMSMasterKeyID: {
              'Fn::GetAtt': [journalKeyId, 'Arn'],
            },
            SSEAlgorithm: 'aws:kms',
          },
        }],
      },
      LoggingConfiguration: {
        DestinationBucketName: { Ref: accessLogsBucketId },
        LogFilePrefix: 'workspace-search-migration-journal/',
      },
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: {
            Days: 30,
            Mode: 'COMPLIANCE',
          },
        },
      },
      ObjectLockEnabled: true,
      OwnershipControls: {
        Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  }));

  expect(synthesized.Resources[accessLogsBucketId]).toEqual(
    expect.objectContaining({
      DeletionPolicy: 'Retain',
      Type: 'AWS::S3::Bucket',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          }],
        },
        LifecycleConfiguration: {
          Rules: [expect.objectContaining({
            ExpirationInDays: 90,
            Id: 'ExpireMigrationJournalAccessLogs',
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            Status: 'Enabled',
          })],
        },
        OwnershipControls: {
          Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    }),
  );

  const journalBucketPolicy = Object.values(synthesized.Resources).find(
    (resource) => {
      if (!isRecord(resource) || resource.Type !== 'AWS::S3::BucketPolicy') {
        return false;
      }
      const properties = resource.Properties;
      if (!isRecord(properties)) return false;
      const bucket = properties.Bucket;
      return isRecord(bucket) && bucket.Ref === journalBucketId;
    },
  );
  const accessLogsBucketPolicy = Object.values(synthesized.Resources).find(
    (resource) => {
      if (!isRecord(resource) || resource.Type !== 'AWS::S3::BucketPolicy') {
        return false;
      }
      const properties = resource.Properties;
      if (!isRecord(properties)) return false;
      const bucket = properties.Bucket;
      return isRecord(bucket) && bucket.Ref === accessLogsBucketId;
    },
  );
  const journalBucketPolicyRecord = isRecord(journalBucketPolicy)
    ? journalBucketPolicy
    : undefined;
  const journalBucketPolicyProperties =
    isRecord(journalBucketPolicyRecord?.Properties)
      ? journalBucketPolicyRecord.Properties
      : undefined;
  const journalPolicyDocument =
    isRecord(journalBucketPolicyProperties?.PolicyDocument)
      ? journalBucketPolicyProperties.PolicyDocument
      : undefined;
  const journalPolicyStatements: Record<string, unknown>[] =
    Array.isArray(journalPolicyDocument?.Statement)
      ? journalPolicyDocument.Statement.filter(isRecord)
      : [];
  const deletionStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyJournalObjectDeletion',
  );
  const unconditionalUploadStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyUnconditionalJournalUploads',
  );
  const nonExclusiveUploadStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyNonExclusiveJournalUploads',
  );
  const nonKmsUploadStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyNonKmsJournalUploads',
  );
  const wrongKeyUploadStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyWrongJournalKeyUploads',
  );
  const shortRetentionStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyShortJournalRetention',
  );
  const longRetentionStatement = journalPolicyStatements.find(
    (statement) => statement.Sid === 'DenyLongJournalRetention',
  );
  const serializedJournalPolicy = JSON.stringify(journalBucketPolicy);
  const allJournalObjectsArn = {
    'Fn::Join': [
      '',
      [
        { 'Fn::GetAtt': [journalBucketId, 'Arn'] },
        '/*',
      ],
    ],
  };
  const journalV1ObjectsArn = {
    'Fn::Join': [
      '',
      [
        { 'Fn::GetAtt': [journalBucketId, 'Arn'] },
        '/workspace-search/v1/*',
      ],
    ],
  };

  expect(journalBucketPolicy).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  }));
  expect(accessLogsBucketPolicy).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  }));
  expect(deletionStatement).toEqual(expect.objectContaining({
    Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: allJournalObjectsArn,
  }));
  expect(unconditionalUploadStatement).toEqual(expect.objectContaining({
    Action: 's3:PutObject',
    Condition: {
      Null: {
        's3:if-none-match': 'true',
      },
    },
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: journalV1ObjectsArn,
  }));
  expect(nonExclusiveUploadStatement).toEqual(expect.objectContaining({
    Action: 's3:PutObject',
    Condition: {
      StringNotEquals: {
        's3:if-none-match': '*',
      },
    },
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: journalV1ObjectsArn,
  }));
  expect(nonKmsUploadStatement).toEqual(expect.objectContaining({
    Action: 's3:PutObject',
    Condition: {
      StringNotEquals: {
        's3:x-amz-server-side-encryption': 'aws:kms',
      },
    },
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: journalV1ObjectsArn,
  }));
  expect(wrongKeyUploadStatement).toEqual(expect.objectContaining({
    Action: 's3:PutObject',
    Condition: {
      StringNotEquals: {
        's3:x-amz-server-side-encryption-aws-kms-key-id': {
          'Fn::GetAtt': [journalKeyId, 'Arn'],
        },
      },
    },
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: journalV1ObjectsArn,
  }));
  expect(shortRetentionStatement).toEqual(expect.objectContaining({
    Action: 's3:PutObjectRetention',
    Condition: {
      NumericLessThan: {
        's3:object-lock-remaining-retention-days': 30,
      },
    },
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: journalV1ObjectsArn,
  }));
  expect(longRetentionStatement).toEqual(expect.objectContaining({
    Action: 's3:PutObjectRetention',
    Condition: {
      NumericGreaterThan: {
        's3:object-lock-remaining-retention-days': 31,
      },
    },
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Resource: journalV1ObjectsArn,
  }));
  expect(serializedJournalPolicy).toContain('s3:TlsVersion');
  expect(serializedJournalPolicy).toContain('1.2');
  expect(serializedJournalPolicy).toContain('aws:SecureTransport');
});

test('Workspace Search migration operator policy is unattached and least privilege', () => {
  const template = synthesizedTemplate;
  const synthesized = template.toJSON();
  const operatorPolicyId =
    synthesized.Outputs.WorkspaceSearchMigrationOperatorPolicyArn?.Value?.Ref;
  const journalBucketId =
    synthesized.Outputs.WorkspaceSearchMigrationJournalBucketName?.Value?.Ref;
  const journalKeyId =
    synthesized.Outputs.WorkspaceSearchMigrationJournalKeyArn?.Value?.['Fn::GetAtt']?.[0];
  const stateTableId =
    synthesized.Outputs.WorkspaceSearchMigrationStateTableName?.Value?.Ref;
  const targetTableId = synthesized.Outputs.WorkspaceSearchTableName?.Value?.Ref;
  const sourceTableIds = [
    synthesized.Outputs.ProjectDirectoryTableName?.Value?.Ref,
    synthesized.Outputs.WorkItemsTableName?.Value?.Ref,
    synthesized.Outputs.WorkItemCollaborationTableName?.Value?.Ref,
    synthesized.Outputs.DocumentsTableName?.Value?.Ref,
  ];

  expect(typeof operatorPolicyId).toBe('string');
  expect(typeof journalBucketId).toBe('string');
  expect(typeof journalKeyId).toBe('string');
  expect(typeof stateTableId).toBe('string');
  expect(typeof targetTableId).toBe('string');
  expect(sourceTableIds.every((logicalId) => typeof logicalId === 'string'))
    .toBe(true);
  if (
    typeof operatorPolicyId !== 'string' ||
    typeof journalBucketId !== 'string' ||
    typeof journalKeyId !== 'string' ||
    typeof stateTableId !== 'string' ||
    typeof targetTableId !== 'string'
  ) {
    throw new Error('Migration IAM outputs do not reference expected resources.');
  }

  const operatorPolicy = synthesized.Resources[operatorPolicyId];
  const operatorPolicyProperties = isRecord(operatorPolicy?.Properties)
    ? operatorPolicy.Properties
    : undefined;
  const policyDocument = isRecord(operatorPolicyProperties?.PolicyDocument)
    ? operatorPolicyProperties.PolicyDocument
    : undefined;
  const statements: Record<string, unknown>[] = Array.isArray(
    policyDocument?.Statement,
  )
    ? policyDocument.Statement.filter(isRecord)
    : [];
  const sourceReadStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:DescribeContinuousBackups') &&
    statement.Action.includes('dynamodb:DescribeTimeToLive') &&
    statement.Action.includes('dynamodb:Scan') &&
    Array.isArray(statement.Resource) &&
    statement.Resource.length === 4
  );
  const sourceConditionStatement = statements.find((statement) =>
    statement.Action === 'dynamodb:ConditionCheckItem' &&
    statement.Condition !== undefined &&
    Array.isArray(statement.Resource) &&
    statement.Resource.length === 4
  );
  const targetTransactionStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:DeleteItem') &&
    JSON.stringify(statement.Resource).includes(targetTableId)
  );
  const targetAndStateReadOnlyStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:DescribeContinuousBackups') &&
    statement.Action.includes('dynamodb:GetItem') &&
    JSON.stringify(statement.Resource).includes(targetTableId) &&
    JSON.stringify(statement.Resource).includes(stateTableId)
  );
  const stateTransactionStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:UpdateItem') &&
    statement.Condition !== undefined &&
    JSON.stringify(statement.Resource).includes(stateTableId)
  );
  const targetTableStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(targetTableId)
  );
  const stateTableStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(stateTableId)
  );
  const dynamoDbStatements = statements.filter((statement) =>
    (
      typeof statement.Action === 'string' &&
      statement.Action.startsWith('dynamodb:')
    ) ||
    (
      Array.isArray(statement.Action) &&
      statement.Action.some((action) =>
        typeof action === 'string' && action.startsWith('dynamodb:')
      )
    )
  );
  const journalPutStatement = statements.find((statement) =>
    statement.Action === 's3:PutObject'
  );
  const journalRetentionStatement = statements.find((statement) =>
    statement.Action === 's3:PutObjectRetention'
  );
  const journalReadStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('s3:GetObjectVersion')
  );
  const journalBucketStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('s3:GetBucketObjectLockConfiguration')
  );
  const journalListStatement = statements.find((statement) =>
    statement.Action === 's3:ListBucket'
  );
  const kmsStatement = statements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('kms:GenerateDataKey')
  );
  const kmsDescribeStatement = statements.find((statement) =>
    statement.Action === 'kms:DescribeKey'
  );
  const serializedOperatorPolicy = JSON.stringify(operatorPolicy);

  expect(operatorPolicy).toEqual(expect.objectContaining({
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: expect.not.objectContaining({
      Roles: expect.anything(),
      Users: expect.anything(),
    }),
  }));
  expect(sourceReadStatement?.Resource).toHaveLength(4);
  expect(sourceReadStatement?.Resource).toEqual(expect.arrayContaining(
    sourceTableIds.map((logicalId) => ({
      'Fn::GetAtt': [logicalId, 'Arn'],
    })),
  ));
  expect(sourceConditionStatement?.Condition).toEqual({
    'ForAnyValue:StringEquals': {
      'dynamodb:EnclosingOperation': ['TransactWriteItems'],
    },
  });
  expect(sourceConditionStatement?.Resource).toEqual(
    sourceReadStatement?.Resource,
  );
  expect(targetAndStateReadOnlyStatement?.Action).toEqual([
    'dynamodb:DescribeContinuousBackups',
    'dynamodb:DescribeTable',
    'dynamodb:DescribeTimeToLive',
    'dynamodb:GetItem',
    'dynamodb:Query',
    'dynamodb:Scan',
  ]);
  expect(targetAndStateReadOnlyStatement?.Resource).toHaveLength(2);
  expect(targetAndStateReadOnlyStatement?.Resource).toEqual(
    expect.arrayContaining([
      { 'Fn::GetAtt': [targetTableId, 'Arn'] },
      { 'Fn::GetAtt': [stateTableId, 'Arn'] },
    ]),
  );
  expect(targetAndStateReadOnlyStatement?.Condition).toBeUndefined();
  expect(targetTransactionStatement?.Action).toEqual([
    'dynamodb:ConditionCheckItem',
    'dynamodb:DeleteItem',
    'dynamodb:PutItem',
  ]);
  expect(targetTransactionStatement?.Resource).toEqual({
    'Fn::GetAtt': [targetTableId, 'Arn'],
  });
  expect(targetTransactionStatement?.Condition).toEqual({
    'ForAnyValue:StringEquals': {
      'dynamodb:EnclosingOperation': ['TransactWriteItems'],
    },
  });
  expect(stateTransactionStatement?.Action).toEqual([
    'dynamodb:ConditionCheckItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
  ]);
  expect(stateTransactionStatement?.Resource).toEqual({
    'Fn::GetAtt': [stateTableId, 'Arn'],
  });
  expect(stateTransactionStatement?.Condition).toEqual({
    'ForAnyValue:StringEquals': {
      'dynamodb:EnclosingOperation': ['TransactWriteItems'],
    },
  });
  expect(targetTableStatements).toHaveLength(2);
  expect(stateTableStatements).toHaveLength(2);
  expect(dynamoDbStatements.some((statement) =>
    statement.Action === 'dynamodb:*' ||
    (
      Array.isArray(statement.Action) &&
      statement.Action.includes('dynamodb:*')
    ) ||
    statement.Resource === '*' ||
    (
      Array.isArray(statement.Resource) &&
      statement.Resource.includes('*')
    )
  )).toBe(false);
  expect(journalBucketStatement?.Resource).toEqual({
    'Fn::GetAtt': [journalBucketId, 'Arn'],
  });
  expect(journalBucketStatement?.Action).toEqual(expect.arrayContaining([
    's3:GetBucketLogging',
    's3:GetBucketObjectLockConfiguration',
  ]));
  expect(journalBucketStatement?.Condition).toBeUndefined();
  expect(journalListStatement?.Condition).toEqual({
    StringLike: {
      's3:prefix': [
        'workspace-search/v1',
        'workspace-search/v1/*',
      ],
    },
  });
  expect(journalPutStatement?.Condition).toEqual({
    StringEquals: {
      's3:if-none-match': '*',
      's3:x-amz-server-side-encryption': 'aws:kms',
      's3:x-amz-server-side-encryption-aws-kms-key-id': {
        'Fn::GetAtt': [journalKeyId, 'Arn'],
      },
    },
  });
  expect(JSON.stringify(journalPutStatement?.Resource))
    .toContain('workspace-search/v1/');
  expect(journalRetentionStatement?.Condition).toEqual({
    NumericGreaterThanEquals: {
      's3:object-lock-remaining-retention-days': 30,
    },
    NumericLessThanEquals: {
      's3:object-lock-remaining-retention-days': 31,
    },
    StringEquals: {
      's3:object-lock-mode': 'COMPLIANCE',
    },
  });
  expect(JSON.stringify(journalRetentionStatement?.Resource))
    .toContain('workspace-search/v1/');
  expect(JSON.stringify(journalReadStatement?.Resource))
    .toContain('workspace-search/v1/');
  expect(journalReadStatement?.Action).toEqual([
    's3:GetObject',
    's3:GetObjectRetention',
    's3:GetObjectVersion',
  ]);
  expect(kmsStatement?.Resource).toEqual({
    'Fn::GetAtt': [journalKeyId, 'Arn'],
  });
  expect(kmsDescribeStatement?.Resource).toEqual({
    'Fn::GetAtt': [journalKeyId, 'Arn'],
  });
  expect(kmsDescribeStatement?.Condition).toBeUndefined();
  expect(kmsStatement?.Condition).toEqual(expect.objectContaining({
    StringEquals: expect.objectContaining({
      'kms:CallerAccount': { Ref: 'AWS::AccountId' },
      'kms:EncryptionContext:aws:s3:arn': {
        'Fn::GetAtt': [journalBucketId, 'Arn'],
      },
      'kms:ViaService': expect.anything(),
    }),
  }));
  expect(kmsStatement?.Action).toEqual([
    'kms:Decrypt',
    'kms:GenerateDataKey',
  ]);

  for (const forbiddenAction of [
    'dynamodb:TransactWriteItems',
    's3:AbortMultipartUpload',
    's3:BypassGovernanceRetention',
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:PutObjectLegalHold',
  ]) {
    expect(serializedOperatorPolicy).not.toContain(`"${forbiddenAction}"`);
  }
  expect(serializedOperatorPolicy).not.toMatch(/"s3:PutBucket[A-Za-z]*"/u);
  expect(serializedOperatorPolicy).not.toContain('"Resource":"*"');
});

test('Workspace Search migration resources publish only stable non-secret locators', () => {
  const template = synthesizedTemplate;

  template.hasOutput('WorkspaceSearchMigrationStateTableName', {});
  template.hasOutput('WorkspaceSearchMigrationJournalBucketName', {});
  template.hasOutput('WorkspaceSearchMigrationJournalKeyArn', {});
  template.hasOutput('WorkspaceSearchMigrationOperatorPolicyArn', {});
});
