/** Registers durable data and file storage tests. */
import { Match } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import {
  API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  findApiRuntimeConfigurationSource,
  synthesizedTemplate,
} from './test-support';

test('upgrade keeps stateful resource logical IDs and enables retain with PITR', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const stableResourceIds = [
    'ProjectTasksTableE21F6637',
    'TeamIssuesTable189D851D',
    'WorkItemConfigurationTable35E94558',
    'AutomationTableE3D67F0D',
    'PlanningTable2A0D4CC5',
    'DeveloperPlatformTable772E085C',
    'TeamIssueEventsTableDD2B0F96',
    'ProjectDirectoryTable9ED01C01',
    'TenantAdministrationTable621D59EB',
    'ListProjectTasksFunction2134AF4A',
    'DocumentsTable7E808EE5',
    'WorkItemCollaborationTableFDECF217',
    'WorkspaceSearchTable2575AD6B',
    'NotificationsTable76DCFC6C',
    'FocusTable8B0E7E68',
    'RealtimeSessionsTable607096EB',
  ];

  for (const logicalId of stableResourceIds) {
    expect(resources[logicalId]).toBeDefined();
  }

  const tables = template.findResources('AWS::DynamoDB::Table');

  expect(Object.keys(tables)).toHaveLength(25);

  for (const table of Object.values(tables)) {
    expect(table).toEqual(expect.objectContaining({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      }),
    }));
  }

  expect(resources.CapacityPlanningTable0EECD517.Properties)
    .toEqual(expect.objectContaining({
      SSESpecification: {
        SSEEnabled: true,
      },
    }));

  expect(resources.ProjectDirectoryTable9ED01C01.Properties)
    .toEqual(expect.objectContaining({
      GlobalSecondaryIndexes: expect.arrayContaining([
        expect.objectContaining({
          IndexName: 'WebhookAuthorizationIndex',
          KeySchema: [
            { AttributeName: 'webhookAuthorizationKey', KeyType: 'HASH' },
            { AttributeName: 'webhookAuthorizationSortKey', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
      ]),
    }));
  expect(resources.TenantAdministrationTable621D59EB.Properties)
    .toEqual(expect.objectContaining({
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    }));
  expect(resources.TeamIssuesTable189D851D.Properties)
    .toEqual(expect.objectContaining({
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'directoryTeamId', AttributeType: 'S' },
        { AttributeName: 'issueId', AttributeType: 'S' },
        { AttributeName: 'directoryProjectId', AttributeType: 'S' },
        { AttributeName: 'sortOrder', AttributeType: 'N' },
        { AttributeName: 'updatedAt', AttributeType: 'S' },
      ]),
      KeySchema: [
        { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
        { AttributeName: 'issueId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        expect.objectContaining({
          IndexName: 'TeamIssueSortOrderIndex',
          KeySchema: [
            { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
            { AttributeName: 'sortOrder', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
        expect.objectContaining({
          IndexName: 'TeamIssueUpdatedAtIndex',
          KeySchema: [
            { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
        expect.objectContaining({
          IndexName: 'AssignedProjectIssueIndex',
          KeySchema: [
            { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
            { AttributeName: 'sortOrder', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ],
    }));
});

test('Focus state uses a retained expiring scope and record key table', () => {
  const template = synthesizedTemplate;
  const document = template.toJSON();
  const focusTableLogicalId = document.Outputs.FocusTableName?.Value?.Ref;

  expect(typeof focusTableLogicalId).toBe('string');
  if (typeof focusTableLogicalId !== 'string') {
    throw new Error('Focus table output was not synthesized.');
  }

  expect(document.Resources[focusTableLogicalId]).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: [
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      SSESpecification: {
        SSEEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    }),
  }));
  template.hasOutput('FocusTableName', {
    Value: { Ref: focusTableLogicalId },
  });

  const workflowConfiguration =
    document.Resources.ApiWorkflowRuntimeConfigurationSecret225372D1
      .Properties.SecretString;
  expect(findApiRuntimeConfigurationSource(
    workflowConfiguration,
    'FOCUS_TABLE_NAME',
  )).toEqual({
    'Fn::Base64': { Ref: focusTableLogicalId },
  });
});

test('automation state is retained with due-schedule and execution history indexes', () => {
  const template = synthesizedTemplate;
  const automationTableEntry = Object.entries(template.findResources('AWS::DynamoDB::Table'))
    .find(([, resource]) => {
      const properties = (resource as { Properties?: Record<string, unknown> }).Properties;
      return JSON.stringify(properties?.GlobalSecondaryIndexes ?? []).includes('ScheduleDueIndex');
    });

  expect(automationTableEntry).toBeDefined();
  expect(automationTableEntry?.[1]).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
        { AttributeName: 'scheduleShard', AttributeType: 'S' },
        { AttributeName: 'nextRunAtRecordKey', AttributeType: 'S' },
        { AttributeName: 'ruleExecutionKey', AttributeType: 'S' },
        { AttributeName: 'startedAtExecutionId', AttributeType: 'S' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: expect.arrayContaining([
        expect.objectContaining({ IndexName: 'ScheduleDueIndex' }),
        expect.objectContaining({ IndexName: 'RuleExecutionIndex' }),
        expect.objectContaining({
          IndexName: 'WorkspaceExecutionIndex',
          KeySchema: [
            { AttributeName: 'scopeKey', KeyType: 'HASH' },
            { AttributeName: 'startedAtExecutionId', KeyType: 'RANGE' },
          ],
        }),
      ]),
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    }),
  }));
  template.hasOutput('AutomationTableName', {});
});

test('enterprise identity state is retained, protected, and free of unused indexes', () => {
  const template = synthesizedTemplate;
  const tableLogicalId = template.toJSON().Outputs.EnterpriseIdentityTableName?.Value?.Ref;
  const table = template.toJSON().Resources[tableLogicalId];

  expect(typeof tableLogicalId).toBe('string');
  expect(table).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: [
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      StreamSpecification: {
        StreamViewType: 'NEW_IMAGE',
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    }),
  }));
  expect(JSON.stringify(template.toJSON().Outputs))
    .not.toContain('EnterpriseIdentityTokenHashSecret');
});

test('analytics state is retained with a due-delivery index and scoped API access', () => {
  const template = synthesizedTemplate;
  const analyticsTableLogicalId = template.toJSON().Outputs.AnalyticsTableName?.Value?.Ref;

  expect(typeof analyticsTableLogicalId).toBe('string');
  if (typeof analyticsTableLogicalId !== 'string') {
    throw new Error('Analytics table output does not reference a table.');
  }

  const analyticsTable = template.toJSON().Resources[analyticsTableLogicalId];

  expect(analyticsTable).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'workspaceId', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
        { AttributeName: 'scheduleShard', AttributeType: 'S' },
        { AttributeName: 'nextDeliveryAtRecordKey', AttributeType: 'S' },
        { AttributeName: 'teamId', AttributeType: 'S' },
        { AttributeName: 'startAt', AttributeType: 'S' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        expect.objectContaining({
          IndexName: 'ScheduleDueIndex',
          KeySchema: [
            { AttributeName: 'scheduleShard', KeyType: 'HASH' },
            { AttributeName: 'nextDeliveryAtRecordKey', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
        expect.objectContaining({
          IndexName: 'TimeEntryTeamDateIndex',
          KeySchema: [
            { AttributeName: 'teamId', KeyType: 'HASH' },
            { AttributeName: 'startAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    }),
  }));

  const resources = template.toJSON().Resources;
  const dataConfigurationSecretId =
    API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID;
  const dataConfiguration = resources[dataConfigurationSecretId]
    .Properties.SecretString;
  expect(findApiRuntimeConfigurationSource(
    dataConfiguration,
    'ANALYTICS_SCHEDULE_INDEX_NAME',
  )).toEqual({
    'Fn::Base64': 'ScheduleDueIndex',
  });
  expect(findApiRuntimeConfigurationSource(
    dataConfiguration,
    'ANALYTICS_TABLE_NAME',
  )).toEqual({
    'Fn::Base64': { Ref: analyticsTableLogicalId },
  });
  expect(
    resources.ListProjectTasksFunction2134AF4A
      .Properties.Environment.Variables,
  ).toEqual(expect.objectContaining({
    MUKUROJI_API_DATA_CONFIG_SECRET_ARN: {
      Ref: dataConfigurationSecretId,
    },
  }));

  const apiAnalyticsPolicy = Object.entries(template.toJSON().Resources)
    .find(([logicalId, resource]) =>
      logicalId.startsWith('ApiAnalyticsDataPolicy') &&
      (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
    )?.[1];
  expect(JSON.stringify(apiAnalyticsPolicy)).toContain(analyticsTableLogicalId);

  const apiTransactionConditionCheckPolicy = Object.entries(template.toJSON().Resources)
    .find(([logicalId, resource]) =>
      logicalId.startsWith('ApiTransactWritePolicy') &&
      (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
    )?.[1];
  const serializedApiTransactionConditionCheckPolicy = JSON.stringify(
    apiTransactionConditionCheckPolicy,
  );
  expect(serializedApiTransactionConditionCheckPolicy).toContain(
    'dynamodb:ConditionCheckItem',
  );
  expect(serializedApiTransactionConditionCheckPolicy).toContain(
    'dynamodb:EnclosingOperation',
  );
  expect(serializedApiTransactionConditionCheckPolicy)
    .not.toContain('dynamodb:TransactWriteItems');
  expect(serializedApiTransactionConditionCheckPolicy).not.toContain(analyticsTableLogicalId);
});

test('file proofing metadata uses a retained point-in-time recoverable table', () => {
  const template = synthesizedTemplate;
  const fileProofingTableEntry = Object.entries(template.findResources('AWS::DynamoDB::Table'))
    .find(([logicalId]) => logicalId === 'FileProofingTable81DA272F');

  expect(fileProofingTableEntry).toBeDefined();
  expect(fileProofingTableEntry?.[1]).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    }),
  }));
  template.hasOutput('FileProofingTableName', {});
});

test('Work Item configuration uses a retained scope and record key table', () => {
  const template = synthesizedTemplate;
  const table = template.toJSON().Resources.WorkItemConfigurationTable35E94558;

  expect(table).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAtEpochSeconds',
        Enabled: true,
      },
    }),
  }));
});

test('planning data uses retained storage with a sparse update schedule due index', () => {
  const template = synthesizedTemplate;
  const table = template.toJSON().Resources.PlanningTable2A0D4CC5;

  expect(table).toEqual({
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      AttributeDefinitions: [
        { AttributeName: 'workspaceId', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
        { AttributeName: 'updateScheduleShard', AttributeType: 'S' },
        { AttributeName: 'nextNotificationAtRecordKey', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [{
        IndexName: 'UpdateScheduleDueIndex',
        KeySchema: [
          { AttributeName: 'updateScheduleShard', KeyType: 'HASH' },
          { AttributeName: 'nextNotificationAtRecordKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    },
    UpdateReplacePolicy: 'Retain',
    DeletionPolicy: 'Retain',
  });
});

test('developer platform uses a retained TTL table with a lookup GSI', () => {
  const template = synthesizedTemplate;
  const table = template.toJSON().Resources.DeveloperPlatformTable772E085C;

  expect(table).toEqual({
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      AttributeDefinitions: [
        { AttributeName: 'workspaceId', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
        { AttributeName: 'lookupKey', AttributeType: 'S' },
        { AttributeName: 'lookupSortKey', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [{
        IndexName: 'LookupKeyIndex',
        KeySchema: [
          { AttributeName: 'lookupKey', KeyType: 'HASH' },
          { AttributeName: 'lookupSortKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      SSESpecification: {
        SSEEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    },
    UpdateReplacePolicy: 'Retain',
    DeletionPolicy: 'Retain',
  });
  template.hasOutput('DeveloperPlatformTableName', {
    Value: { Ref: 'DeveloperPlatformTable772E085C' },
  });
  template.hasOutput('DeveloperPlatformLookupIndexName', {
    Value: 'LookupKeyIndex',
  });
});

test('request intake uses a retained queue-indexed table with transient row expiry', () => {
  const template = synthesizedTemplate;
  const output = template.toJSON().Outputs.RequestIntakeTableName;
  const tableLogicalId = output?.Value?.Ref;

  expect(typeof tableLogicalId).toBe('string');
  if (typeof tableLogicalId !== 'string') {
    throw new Error('Request intake table output was not found.');
  }

  const table = template.toJSON().Resources[tableLogicalId];

  expect(table).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
        { AttributeName: 'queueKey', AttributeType: 'S' },
        { AttributeName: 'queueRecordKey', AttributeType: 'S' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: expect.arrayContaining([
        expect.objectContaining({
          IndexName: 'RequestQueueIndex',
          KeySchema: [
            { AttributeName: 'queueKey', KeyType: 'HASH' },
            { AttributeName: 'queueRecordKey', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    }),
  }));
});

test('file bucket is private durable and scoped for direct browser transfers', () => {
  const template = synthesizedTemplate;
  const allowedOrigins = {
    'Fn::Split': [
      ',',
      {
        Ref: 'TaskApiAllowedOrigins',
      },
    ],
  };

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [{
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: 'AES256',
        },
      }],
    },
    CorsConfiguration: {
      CorsRules: [{
        AllowedHeaders: [
          'content-length',
          'content-type',
          'if-none-match',
          'x-amz-checksum-*',
          'x-amz-meta-*',
          'x-amz-server-side-encryption',
          'x-amz-tagging',
        ],
        AllowedMethods: ['GET', 'HEAD', 'PUT'],
        AllowedOrigins: allowedOrigins,
        ExposedHeaders: ['ETag', 'x-amz-checksum-sha256', 'x-amz-version-id'],
        MaxAge: 600,
      }],
    },
    LifecycleConfiguration: {
      Rules: Match.arrayWith([
        Match.objectLike({
          AbortIncompleteMultipartUpload: {
            DaysAfterInitiation: 1,
          },
          Id: 'AbortIncompleteUploads',
          Status: 'Enabled',
        }),
        Match.objectLike({
          ExpirationInDays: 1,
          Id: 'ExpireAbandonedUploads',
          Status: 'Enabled',
          TagFilters: [{
            Key: 'mukuroji-upload',
            Value: 'pending',
          }],
        }),
        Match.objectLike({
          ExpirationInDays: 1,
          Id: 'ExpireDeletedCurrentObjects',
          Status: 'Enabled',
          TagFilters: [{
            Key: 'mukuroji-deleted',
            Value: 'true',
          }],
        }),
        Match.objectLike({
          Id: 'ExpireDeletedFileVersions',
          NoncurrentVersionExpiration: {
            NoncurrentDays: {
              Ref: 'FileRetentionDays',
            },
          },
          Status: 'Enabled',
        }),
        Match.objectLike({
          ExpiredObjectDeleteMarker: true,
          Id: 'DeleteExpiredMarkers',
          Status: 'Enabled',
        }),
      ]),
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
    VersioningConfiguration: {
      Status: 'Enabled',
    },
  });
  template.hasResourceProperties('Custom::S3BucketNotifications', {
    BucketName: Match.anyValue(),
    Managed: true,
    NotificationConfiguration: {
      EventBridgeConfiguration: {},
    },
  });

  const [, fileBucket] = Object.entries(template.findResources('AWS::S3::Bucket'))[0] ?? [];
  expect(fileBucket).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  }));
  template.hasOutput('FileBucketName', {});
});

test('file bucket incarnation marker is create-once, immutable, and published exactly', () => {
  const template = synthesizedTemplate;
  const document = template.toJSON();
  const fileBucketLogicalId = document.Outputs.FileBucketName?.Value?.Ref;
  if (typeof fileBucketLogicalId !== 'string') {
    throw new Error('File bucket output does not reference the retained bucket.');
  }
  expect(fileBucketLogicalId).toBe('FileBucketCDFCD6DE');

  const markerEntries = Object.entries(
    template.findResources('Custom::FileBucketIncarnationMarker'),
  );
  expect(markerEntries).toHaveLength(1);
  const markerEntry = markerEntries[0];
  if (!markerEntry) {
    throw new Error('File bucket incarnation marker was not synthesized.');
  }
  const [markerLogicalId, markerResource] = markerEntry;
  expect(markerResource).toEqual(expect.objectContaining({
    Properties: expect.objectContaining({
      BucketName: { Ref: fileBucketLogicalId },
      ExpectedAccount: { Ref: 'AWS::AccountId' },
      MarkerKey: 'system/data-integrity/file-bucket-incarnation/v1.json',
      ServiceToken: expect.anything(),
    }),
  }));

  expect(document.Outputs.FileBucketIncarnationMarkerKey?.Value).toEqual({
    'Fn::GetAtt': [markerLogicalId, 'Key'],
  });
  expect(document.Outputs.FileBucketIncarnationMarkerVersionId?.Value).toEqual({
    'Fn::GetAtt': [markerLogicalId, 'VersionId'],
  });
  expect(
    document.Outputs.FileBucketIncarnationMarkerChecksumSha256?.Value,
  ).toEqual({
    'Fn::GetAtt': [markerLogicalId, 'ChecksumSHA256'],
  });
  expect(document.Outputs.FileBucketIncarnationMarkerSize?.Value).toEqual({
    'Fn::GetAtt': [markerLogicalId, 'Size'],
  });

  const fileBucket = document.Resources[fileBucketLogicalId];
  expect(fileBucket.Properties).not.toHaveProperty('ObjectLockEnabled');
  expect(fileBucket.Properties).not.toHaveProperty('ObjectLockConfiguration');

  const bucketPolicyEntry = Object.entries(
    template.findResources('AWS::S3::BucketPolicy'),
  ).find(([, resource]) =>
    resource.Properties?.Bucket?.Ref === fileBucketLogicalId);
  if (!bucketPolicyEntry) {
    throw new Error('File bucket policy was not synthesized.');
  }
  const [bucketPolicyLogicalId, bucketPolicy] = bucketPolicyEntry;
  const markerDependencies = Array.isArray(markerResource.DependsOn)
    ? markerResource.DependsOn
    : [markerResource.DependsOn];
  expect(markerDependencies).toContain(bucketPolicyLogicalId);
  const bucketPolicyDependencies = Array.isArray(bucketPolicy.DependsOn)
    ? bucketPolicy.DependsOn
    : [bucketPolicy.DependsOn];
  expect(bucketPolicyDependencies).not.toContain(markerLogicalId);
  const markerObjectArn = {
    'Fn::Join': [
      '',
      [
        { 'Fn::GetAtt': [fileBucketLogicalId, 'Arn'] },
        '/system/data-integrity/file-bucket-incarnation/v1.json',
      ],
    ],
  };
  expect(bucketPolicy.Properties.PolicyDocument.Statement).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Resource: markerObjectArn,
        Sid: 'FileBucketIncarnationMarkerCannotBeDeleted',
      }),
      expect.objectContaining({
        Action: 's3:PutObject',
        Condition: {
          ArnNotEquals: {
            'aws:PrincipalArn': expect.anything(),
          },
        },
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Resource: markerObjectArn,
        Sid: 'OnlyFileBucketIncarnationMarkerProviderCanPut',
      }),
      expect.objectContaining({
        Action: 's3:PutObject',
        Condition: {
          StringNotEquals: {
            's3:if-none-match': '*',
          },
        },
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Resource: markerObjectArn,
        Sid: 'FileBucketIncarnationMarkerRequiresCreateOnlyPut',
      }),
    ]),
  );

  const providerFunction = Object.values(
    template.findResources('AWS::Lambda::Function'),
  ).find((resource) =>
    resource.Properties?.Description ===
      'Creates or reconciles the immutable file-bucket incarnation marker.');
  expect(providerFunction).toEqual(expect.objectContaining({
    Properties: expect.objectContaining({
      Handler: 'index.handler',
      MemorySize: 256,
      Runtime: 'nodejs22.x',
      Timeout: 30,
      TracingConfig: { Mode: 'Active' },
    }),
  }));
  const providerPrincipalBoundary =
    bucketPolicy.Properties.PolicyDocument.Statement.find(
      (statement: unknown) =>
        statement !== null &&
        typeof statement === 'object' &&
        Reflect.get(statement, 'Sid') ===
          'OnlyFileBucketIncarnationMarkerProviderCanPut',
    );
  const providerPrincipalCondition =
    providerPrincipalBoundary !== null &&
    typeof providerPrincipalBoundary === 'object'
      ? Reflect.get(providerPrincipalBoundary, 'Condition')
      : undefined;
  expect(providerPrincipalCondition).toEqual({
    ArnNotEquals: {
      'aws:PrincipalArn': providerFunction?.Properties.Role,
    },
  });

  const providerPolicy = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ).find((resource) => {
    const serialized = JSON.stringify(resource);
    return serialized.includes('FileBucketIncarnationMarkerFunction') &&
      serialized.includes('s3:PutObject');
  });
  if (!providerPolicy) {
    throw new Error('Marker provider IAM policy was not synthesized.');
  }
  expect(providerPolicy.Properties.PolicyDocument.Statement).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Action: 's3:GetBucketVersioning',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [fileBucketLogicalId, 'Arn'] },
      }),
      expect.objectContaining({
        Action: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        Effect: 'Allow',
        Resource: {
          'Fn::Join': [
            '',
            [
              { 'Fn::GetAtt': [fileBucketLogicalId, 'Arn'] },
              '/system/data-integrity/file-bucket-incarnation/v1.json',
            ],
          ],
        },
      }),
    ]),
  );
  expect(JSON.stringify(providerPolicy)).not.toContain('"s3:ListBucket"');
});

test('collaboration notifications and realtime sessions use production-safe DynamoDB schemas', () => {
  const template = synthesizedTemplate;
  const bootstrapPayload = JSON.stringify(template.findResources('Custom::AWS'));

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'entityKey', KeyType: 'HASH' },
      { AttributeName: 'recordKey', KeyType: 'RANGE' },
    ],
    TimeToLiveSpecification: {
      AttributeName: 'expiresAt',
      Enabled: true,
    },
  });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'recipientKey', KeyType: 'HASH' },
      { AttributeName: 'notificationKey', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'RecipientStatusIndex',
        KeySchema: [
          { AttributeName: 'recipientStatusKey', KeyType: 'HASH' },
          { AttributeName: 'notificationKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }),
    ]),
    TimeToLiveSpecification: {
      AttributeName: 'expiresAt',
      Enabled: true,
    },
  });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'ScopeConnectionsIndex',
        KeySchema: [
          { AttributeName: 'scopeKey', KeyType: 'HASH' },
          { AttributeName: 'connectionId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }),
    ]),
    TimeToLiveSpecification: {
      AttributeName: 'expiresAt',
      Enabled: true,
    },
  });
  expect(bootstrapPayload).not.toContain('WorkItemCollaborationTableFDECF217');
  expect(bootstrapPayload).not.toContain('NotificationsTable76DCFC6C');
  expect(bootstrapPayload).not.toContain('RealtimeSessionsTable607096EB');
});

test('workspace search persists documents views and preferences in one retained table', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    AttributeDefinitions: [
      { AttributeName: 'workspaceId', AttributeType: 'S' },
      { AttributeName: 'recordKey', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'workspaceId', KeyType: 'HASH' },
      { AttributeName: 'recordKey', KeyType: 'RANGE' },
    ],
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
    },
    TimeToLiveSpecification: {
      AttributeName: 'expiresAt',
      Enabled: true,
    },
  });

  const resource = template.toJSON().Resources.WorkspaceSearchTable2575AD6B;

  expect(resource).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  }));
  expect(resource.Properties.GlobalSecondaryIndexes).toBeUndefined();
});

test('documents use one retained workspace-partitioned table with expiry support', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    AttributeDefinitions: [
      { AttributeName: 'workspaceId', AttributeType: 'S' },
      { AttributeName: 'recordKey', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'workspaceId', KeyType: 'HASH' },
      { AttributeName: 'recordKey', KeyType: 'RANGE' },
    ],
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
    },
    SSESpecification: {
      SSEEnabled: true,
    },
    TimeToLiveSpecification: {
      AttributeName: 'expiresAtEpoch',
      Enabled: true,
    },
  });

  const resource = template.toJSON().Resources.DocumentsTable7E808EE5;

  expect(resource).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  }));
  expect(resource.Properties.GlobalSecondaryIndexes).toBeUndefined();
});
