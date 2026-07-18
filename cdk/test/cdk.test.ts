import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import { CdkStack } from '../lib/cdk-stack';

/**
 * 各 test で使用する synthesized CloudFormation template を作成します。
 */
function createTemplate() {
  const app = new cdk.App({
    context: {
      '@aws-cdk/aws-iam:minimizePolicies': true,
      '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
    },
  });
  const stack = new CdkStack(app, 'TestStack');

  return Template.fromStack(stack);
}

/**
 * 指定した AWS SDK action を実行する custom resource を取得します。
 */
function findCustomResource(template: Template, action: string) {
  const resource = Object.entries(template.findResources('Custom::AWS')).find(([, candidate]) =>
    JSON.stringify(candidate).includes(action),
  );

  if (!resource) {
    throw new Error(`Custom resource for ${action} was not found.`);
  }

  return resource;
}

/**
 * CloudFormation intrinsic を含む AWS SDK call を検証用文字列に変換します。
 */
function serializeAwsSdkCall(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(serializeAwsSdkCall).join('');
  }

  if (!value || typeof value !== 'object') {
    return String(value ?? '');
  }

  const record = value as Record<string, unknown>;
  const join = record['Fn::Join'];

  if (Array.isArray(join) && Array.isArray(join[1])) {
    return join[1].map(serializeAwsSdkCall).join(String(join[0] ?? ''));
  }

  if (typeof record.Ref === 'string') {
    return `{{Ref:${record.Ref}}}`;
  }

  return Object.entries(record)
    .map(([key, entry]) => `${key}:${serializeAwsSdkCall(entry)}`)
    .join('');
}

const synthesizedTemplate = createTemplate();

test('fresh deployment requires explicit external Cognito and workspace parameters', () => {
  const template = synthesizedTemplate;
  const parameters = template.toJSON().Parameters;

  expect(parameters.CognitoUserPoolId).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^[a-z]{2}(?:-[a-z0-9]+)+_[A-Za-z0-9]+$',
  }));
  expect(parameters.CognitoUserPoolClientId).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^[A-Za-z0-9]+$',
  }));
  expect(parameters.WorkspaceDirectoryId).toEqual(expect.objectContaining({
    Type: 'String',
    MinLength: 1,
    AllowedPattern: '^\\S+$',
  }));
  expect(parameters.WorkspaceAuditPseudonymKey).toEqual(expect.objectContaining({
    Type: 'String',
    NoEcho: true,
    AllowedPattern: '^[0-9a-f]{64}$',
    ConstraintDescription:
      'WorkspaceAuditPseudonymKey must be exactly 64 lowercase hexadecimal characters.',
  }));
  expect(parameters.ConnectorRuntimeConfiguration).toEqual(expect.objectContaining({
    Type: 'String',
    Default: '{}',
    NoEcho: true,
  }));
  expect(parameters.DeveloperPlatformSecretProtectorKey).toBeUndefined();
  expect(parameters.InitialOwnerEmail).toEqual(expect.objectContaining({
    Type: 'String',
    ConstraintDescription: 'InitialOwnerEmail must be a lowercase email address.',
  }));
  expect(parameters.InitialOwnerUsername).toEqual(expect.objectContaining({
    Type: 'String',
    MinLength: 1,
    AllowedPattern: '^\\S+$',
  }));
  expect(parameters.TaskApiAllowedOrigins).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^https?://[^,\\s]+(,https?://[^,\\s]+)*$',
  }));
  expect(parameters.FileRetentionDays).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 30,
    MinValue: 1,
  }));
  expect(parameters.FileUploadUrlTtlSeconds).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 600,
    MinValue: 60,
    MaxValue: 3600,
  }));
  expect(parameters.FileDownloadUrlTtlSeconds).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 300,
    MinValue: 60,
    MaxValue: 3600,
  }));

  for (const parameterName of [
    'CognitoUserPoolId',
    'CognitoUserPoolClientId',
    'WorkspaceDirectoryId',
    'WorkspaceAuditPseudonymKey',
    'InitialOwnerEmail',
    'InitialOwnerUsername',
  ]) {
    expect(parameters[parameterName].Default).toBeUndefined();
  }

  template.resourceCountIs('AWS::Cognito::UserPool', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
});

test('upgrade keeps stateful resource logical IDs and enables retain with PITR', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const stableResourceIds = [
    'ProjectTasksTableE21F6637',
    'TeamIssuesTable189D851D',
    'WorkItemConfigurationTable35E94558',
    'PlanningTable2A0D4CC5',
    'DeveloperPlatformTable772E085C',
    'TeamIssueEventsTableDD2B0F96',
    'ProjectDirectoryTable9ED01C01',
    'ListProjectTasksFunction2134AF4A',
    'WorkItemCollaborationTableFDECF217',
    'WorkspaceSearchTable2575AD6B',
    'NotificationsTable76DCFC6C',
    'RealtimeSessionsTable607096EB',
  ];

  for (const logicalId of stableResourceIds) {
    expect(resources[logicalId]).toBeDefined();
  }

  const tables = template.findResources('AWS::DynamoDB::Table');

  expect(Object.keys(tables)).toHaveLength(15);

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

test('shared server handler is bundled as a Lambda asset with production environment', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description: 'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        COGNITO_CLIENT_ID: {
          Ref: 'CognitoUserPoolClientId',
        },
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
        DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID: Match.anyValue(),
        DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
        DEVELOPER_PLATFORM_STATE_KMS_KEY_ID: Match.anyValue(),
        DEVELOPER_PLATFORM_TABLE_NAME: {
          Ref: 'DeveloperPlatformTable772E085C',
        },
        DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID: Match.anyValue(),
        MUKUROJI_PROJECT_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
        },
        MUKUROJI_WORKSPACE_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
        },
        MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY: {
          Ref: 'WorkspaceAuditPseudonymKey',
        },
        MUKUROJI_PROJECT_DIRECTORY_TABLE: {
          Ref: 'ProjectDirectoryTable9ED01C01',
        },
        MUKUROJI_PROJECT_TASKS_TABLE: {
          Ref: 'ProjectTasksTableE21F6637',
        },
        MUKUROJI_TEAM_ISSUES_TABLE: {
          Ref: 'TeamIssuesTable189D851D',
        },
        MUKUROJI_WORK_ITEMS_TABLE: {
          Ref: 'TeamIssuesTable189D851D',
        },
        TEAM_ISSUES_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
        WORK_ITEMS_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
        WORKSPACE_SEARCH_TABLE_NAME: {
          Ref: 'WorkspaceSearchTable2575AD6B',
        },
        WORK_ITEM_CONFIGURATION_TABLE_NAME: {
          Ref: 'WorkItemConfigurationTable35E94558',
        },
        COLLABORATION_TABLE_NAME: {
          Ref: 'WorkItemCollaborationTableFDECF217',
        },
        NOTIFICATIONS_TABLE_NAME: {
          Ref: 'NotificationsTable76DCFC6C',
        },
        NOTIFICATIONS_STATUS_INDEX_NAME: 'RecipientStatusIndex',
        PLANNING_TABLE_NAME: {
          Ref: 'PlanningTable2A0D4CC5',
        },
        REALTIME_SESSIONS_TABLE_NAME: {
          Ref: 'RealtimeSessionsTable607096EB',
        },
        REALTIME_WEBSOCKET_URL: Match.anyValue(),
        WEBHOOK_DELIVERY_QUEUE_URL: {
          Ref: 'WebhookDeliveryQueue2A244492',
        },
        FILE_BUCKET_NAME: Match.anyValue(),
        FILE_DOWNLOAD_URL_TTL_SECONDS: {
          Ref: 'FileDownloadUrlTtlSeconds',
        },
        FILE_PROOFING_TABLE_NAME: Match.anyValue(),
        FILE_RETENTION_DAYS: {
          Ref: 'FileRetentionDays',
        },
        FILE_UPLOAD_URL_TTL_SECONDS: {
          Ref: 'FileUploadUrlTtlSeconds',
        },
      }),
    },
  });

  const lambdaResource = template.toJSON().Resources.ListProjectTasksFunction2134AF4A;

  expect(lambdaResource.Properties.Code.ZipFile).toBeUndefined();
  expect(lambdaResource.Properties.Environment.Variables)
    .not.toHaveProperty('MUKUROJI_WORK_ITEM_CONFIGURATION_TABLE');
});

test('durable Work Item imports use retained versioned sources and an isolated resumable worker', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources as Record<string, {
    Type: string;
    Properties: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  const outputs = template.toJSON().Outputs;
  const importBucketEntry = Object.entries(resources).find(([, resource]) =>
    resource.Type === 'AWS::S3::Bucket' &&
    JSON.stringify(resource).includes('ExpireImportSources')
  );
  const importQueueEntry = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('WorkItemImportQueue') &&
    resources[logicalId].Type === 'AWS::SQS::Queue'
  );
  const importDlqEntry = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('WorkItemImportDlq') &&
    resources[logicalId].Type === 'AWS::SQS::Queue'
  );
  const workerEntry = Object.entries(resources).find(([, resource]) =>
    resource.Type === 'AWS::Lambda::Function' &&
    resource.Properties?.Handler === 'index.workItemImportHandler'
  );

  expect(importBucketEntry).toBeDefined();
  expect(importQueueEntry).toBeDefined();
  expect(importDlqEntry).toBeDefined();
  expect(workerEntry).toBeDefined();
  if (!importBucketEntry || !importQueueEntry || !importDlqEntry || !workerEntry) {
    throw new Error('Durable Work Item import resources were not synthesized.');
  }

  const [importBucketId, importBucket] = importBucketEntry;
  const [importQueueId, importQueue] = importQueueEntry;
  const [importDlqId, importDlq] = importDlqEntry;
  const [workerId, worker] = workerEntry;
  const workerEnvironment = worker.Properties.Environment as {
    Variables: Record<string, unknown>;
  };
  expect(importBucket).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        }],
      },
      LifecycleConfiguration: {
        Rules: expect.arrayContaining([
          expect.objectContaining({
            ExpirationInDays: 15,
            Id: 'ExpireImportSources',
            NoncurrentVersionExpiration: { NoncurrentDays: 15 },
            Status: 'Enabled',
          }),
        ]),
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
  expect(importQueue.Properties).toEqual(expect.objectContaining({
    MessageRetentionPeriod: 14 * 24 * 60 * 60,
    RedrivePolicy: {
      deadLetterTargetArn: { 'Fn::GetAtt': [importDlqId, 'Arn'] },
      maxReceiveCount: 5,
    },
    SqsManagedSseEnabled: true,
    VisibilityTimeout: 90 * 60,
  }));
  expect(importDlq.Properties).toEqual(expect.objectContaining({
    MessageRetentionPeriod: 14 * 24 * 60 * 60,
    SqsManagedSseEnabled: true,
  }));
  expect(worker.Properties).toEqual(expect.objectContaining({
    Description: 'Processes durable Work Item imports with resumable row receipts.',
    Handler: 'index.workItemImportHandler',
    MemorySize: 1024,
    Runtime: 'nodejs22.x',
    Timeout: 15 * 60,
    Environment: {
      Variables: expect.objectContaining({
        DEVELOPER_PLATFORM_TABLE_NAME: { Ref: 'DeveloperPlatformTable772E085C' },
        MUKUROJI_RUNTIME_ROLE: 'work-item-import-worker',
        WORK_ITEM_IMPORT_BUCKET_NAME: { Ref: importBucketId },
        WORK_ITEM_IMPORT_QUEUE_URL: { Ref: importQueueId },
      }),
    },
  }));
  expect(workerEnvironment.Variables)
    .not.toHaveProperty('DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID');
  expect(workerEnvironment.Variables)
    .not.toHaveProperty('MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY');

  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 1,
    EventSourceArn: { 'Fn::GetAtt': [importQueueId, 'Arn'] },
    FunctionName: { Ref: workerId },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
  });
  const workerPolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('WorkItemImportFunctionServiceRoleDefaultPolicy')
  )?.[1];
  expect(workerPolicy).toBeDefined();
  const serializedWorkerPolicy = JSON.stringify(workerPolicy);
  for (const requiredPermission of [
    'cognito-idp:AdminGetUser',
    'cognito-idp:AdminListGroupsForUser',
    'dynamodb:TransactWriteItems',
    's3:DeleteObjectVersion',
    's3:GetObjectVersion',
    'sqs:ReceiveMessage',
  ]) {
    expect(serializedWorkerPolicy).toContain(requiredPermission);
  }
  expect(serializedWorkerPolicy).toContain(importBucketId);
  expect(serializedWorkerPolicy).toContain(importQueueId);
  expect(serializedWorkerPolicy).not.toContain('kms:Decrypt');
  expect(serializedWorkerPolicy).not.toContain('kms:Encrypt');

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects Work Item imports that exhausted resumable queue attempts.',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    EvaluationPeriods: 1,
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  expect(outputs.WorkItemImportBucketName.Value).toEqual({ Ref: importBucketId });
  expect(outputs.WorkItemImportQueueUrl.Value).toEqual({ Ref: importQueueId });
  expect(outputs.WorkItemImportDlqUrl.Value).toEqual({ Ref: importDlqId });
});

test('Function URL and API Gateway invoke the same Lambda handler', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = 'ListProjectTasksFunction2134AF4A';

  template.hasResourceProperties('AWS::Lambda::Url', {
    AuthType: 'NONE',
    TargetFunctionArn: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
    PayloadFormatVersion: '2.0',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    AuthorizationType: 'NONE',
    RouteKey: '$default',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    AutoDeploy: true,
    StageName: '$default',
  });
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    FunctionName: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
    Principal: 'apigateway.amazonaws.com',
    SourceArn: Match.anyValue(),
  });
  template.hasOutput('ProjectTasksFunctionUrl', {});
  template.hasOutput('ProjectTasksApiGatewayUrl', {});
  template.hasOutput('WorkspaceDirectoryId', {
    Value: {
      Ref: 'WorkspaceDirectoryId',
    },
  });
  template.hasOutput('ProjectTasksApiUrl', {
    Description: 'Backward-compatible alias for the Lambda Function URL.',
  });
  template.hasOutput('ProjectTasksTableName', {
    Value: { Ref: 'ProjectTasksTableE21F6637' },
  });
  template.hasOutput('TeamIssuesTableName', {
    Value: { Ref: 'TeamIssuesTable189D851D' },
  });
  template.hasOutput('WorkItemsTableName', {
    Value: { Ref: 'TeamIssuesTable189D851D' },
  });
  template.hasOutput('WorkspaceSearchTableName', {
    Value: { Ref: 'WorkspaceSearchTable2575AD6B' },
  });
  template.hasOutput('WorkItemConfigurationTableName', {
    Value: { Ref: 'WorkItemConfigurationTable35E94558' },
  });
  template.hasOutput('PlanningTableName', {
    Value: { Ref: 'PlanningTable2A0D4CC5' },
  });
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

test('planning data uses a retained point-in-time recoverable workspace table', () => {
  const template = synthesizedTemplate;
  const table = template.toJSON().Resources.PlanningTable2A0D4CC5;

  expect(table).toEqual({
    Type: 'AWS::DynamoDB::Table',
    Properties: {
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

test('developer platform and connector runtime secrets use rotated purpose-specific KMS keys', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;

  template.resourceCountIs('AWS::KMS::Key', 4);
  for (const description of [
    'Envelope key for developer platform Webhook signing secrets.',
    'Envelope key for developer platform connector credentials.',
    'Envelope key for developer platform cursors and idempotency state.',
    'Encryption key for connector provider runtime configuration.',
  ]) {
    template.hasResourceProperties('AWS::KMS::Key', {
      Description: description,
      EnableKeyRotation: true,
    });
  }
  const developerKmsKeys = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::KMS::Key' &&
    String((resource as { Properties?: { Description?: string } }).Properties?.Description)
      .startsWith('Envelope key for developer platform')
  ) as Array<{ DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
  expect(developerKmsKeys).toHaveLength(3);
  expect(developerKmsKeys.every((resource) =>
    resource.DeletionPolicy === 'Retain' &&
    resource.UpdateReplacePolicy === 'Retain'
  )).toBe(true);
  expect(JSON.stringify(resources)).not.toContain(
    'DEVELOPER_PLATFORM_SECRET_PROTECTOR_KEY',
  );
  expect(JSON.stringify(resources)).not.toContain(
    'DeveloperPlatformSecretProtectorKey',
  );
});

test('Function URL and API Gateway expose the same restricted CORS contract', () => {
  const template = synthesizedTemplate;
  const allowedOrigins = {
    'Fn::Split': [
      ',',
      {
        Ref: 'TaskApiAllowedOrigins',
      },
    ],
  };
  const exposedHeaders = [
    'content-disposition',
    'idempotency-replayed',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-request-id',
  ];

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
      AllowHeaders: [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-correlation-id',
        'x-request-id',
      ],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      AllowOrigins: allowedOrigins,
      ExposeHeaders: exposedHeaders,
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    CorsConfiguration: {
      AllowHeaders: [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-correlation-id',
        'x-request-id',
      ],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
      AllowOrigins: allowedOrigins,
      ExposeHeaders: exposedHeaders,
    },
    ProtocolType: 'HTTP',
  });
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

test('GuardDuty scanning and bucket policy quarantine files until a clean result', () => {
  const template = synthesizedTemplate;
  const serializedBucketPolicy = JSON.stringify(
    Object.values(template.findResources('AWS::S3::BucketPolicy'))[0],
  );

  expect(serializedBucketPolicy).toContain('ListProjectTasksFunctionServiceRole');

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: {
            Service: 'malware-protection-plan.guardduty.amazonaws.com',
          },
        }),
      ]),
    },
  });
  template.hasResourceProperties('AWS::GuardDuty::MalwareProtectionPlan', {
    Actions: {
      Tagging: {
        Status: 'ENABLED',
      },
    },
    ProtectedResource: {
      S3Bucket: {
        BucketName: Match.anyValue(),
        ObjectPrefixes: ['workspaces/'],
      },
    },
    Role: Match.anyValue(),
  });

  const malwarePolicy = Object.values(template.findResources('AWS::IAM::Policy'))
    .find((resource) => JSON.stringify(resource).includes('events:ManagedBy'));
  const serializedMalwarePolicy = JSON.stringify(malwarePolicy);

  expect(malwarePolicy).toBeDefined();
  expect(serializedMalwarePolicy).toContain('DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3');
  expect(serializedMalwarePolicy).toContain('malware-protection-plan.guardduty.amazonaws.com');
  expect(serializedMalwarePolicy).toContain('s3:GetBucketNotification');
  expect(serializedMalwarePolicy).toContain('s3:GetObjectVersion');
  expect(serializedMalwarePolicy).toContain('s3:PutObjectVersionTagging');

  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Condition: {
            Bool: {
              'aws:SecureTransport': 'false',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
        }),
        Match.objectLike({
          Action: 's3:PutObject',
          Condition: {
            ArnNotEquals: {
              'aws:PrincipalArn': Match.anyValue(),
            },
            'ForAnyValue:StringEquals': {
              's3:RequestObjectTagKeys': 'GuardDutyMalwareScanStatus',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'OnlyGuardDutyCanUploadScanStatus',
        }),
        Match.objectLike({
          Action: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
          Condition: {
            ArnNotEquals: {
              'aws:PrincipalArn': Match.anyValue(),
            },
            Null: {
              's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'true',
              's3:RequestObjectTag/GuardDutyMalwareScanStatus': 'false',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'OnlyGuardDutyCanSetScanStatus',
        }),
        Match.objectLike({
          Action: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
          Condition: {
            ArnNotEquals: {
              'aws:PrincipalArn': Match.anyValue(),
            },
            Null: {
              's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'false',
            },
            StringNotEquals: {
              's3:RequestObjectTag/GuardDutyMalwareScanStatus':
                '${s3:ExistingObjectTag/GuardDutyMalwareScanStatus}',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'GuardDutyScanStatusCannotBeChanged',
        }),
        Match.objectLike({
          Action: 's3:PutObject',
          Condition: {
            NumericGreaterThan: {
              's3:signatureAge': {
                'Fn::Join': ['', [{ Ref: 'FileUploadUrlTtlSeconds' }, '000']],
              },
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'RejectStalePresignedFileUploads',
        }),
        Match.objectLike({
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Condition: {
            NumericGreaterThan: {
              's3:signatureAge': {
                'Fn::Join': ['', [{ Ref: 'FileDownloadUrlTtlSeconds' }, '000']],
              },
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'RejectStalePresignedFileDownloads',
        }),
        Match.objectLike({
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Condition: {
            ArnNotEquals: {
              'aws:PrincipalArn': Match.anyValue(),
            },
            StringNotEquals: {
              's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'NO_THREATS_FOUND',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'NoReadUnlessGuardDutyClean',
        }),
        Match.objectLike({
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Condition: {
            StringEquals: {
              's3:ExistingObjectTag/mukuroji-deleted': 'true',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'DeletedObjectsCannotBeRead',
        }),
        Match.objectLike({
          Action: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
          Condition: {
            StringEquals: {
              's3:ExistingObjectTag/mukuroji-deleted': 'true',
            },
            StringNotEquals: {
              's3:RequestObjectTag/mukuroji-deleted': 'true',
            },
          },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Sid: 'DeletedObjectQuarantineCannotBeRemoved',
        }),
      ]),
    },
  });
  template.hasOutput('FileMalwareProtectionPlanId', {});
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
  });

  const resource = template.toJSON().Resources.WorkspaceSearchTable2575AD6B;

  expect(resource).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  }));
  expect(resource.Properties.GlobalSecondaryIndexes).toBeUndefined();
});

test('realtime WebSocket routes use the dedicated ticket-consuming Lambda', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description: 'Consumes one-time tickets and handles mukuroji WebSocket presence events.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: 'ProjectDirectoryTable9ED01C01',
        },
        REALTIME_SESSIONS_TABLE_NAME: {
          Ref: 'RealtimeSessionsTable607096EB',
        },
        REALTIME_SESSION_TTL_SECONDS: '3600',
        SYSTEM_ADMIN_GROUPS: {
          Ref: 'SystemAdminGroups',
        },
        MUKUROJI_WORK_ITEMS_TABLE: {
          Ref: 'TeamIssuesTable189D851D',
        },
        TEAM_ISSUES_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
        WORK_ITEMS_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
        WORKSPACE_ACCESS_TABLE_NAME: {
          Ref: 'WorkspaceAccessTableD7C8D2C7',
        },
      }),
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'WEBSOCKET',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$connect' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$disconnect' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    AutoDeploy: true,
    StageName: 'production',
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'dynamodb:TransactWriteItems',
          Effect: 'Allow',
          Resource: {
            'Fn::GetAtt': ['RealtimeSessionsTable607096EB', 'Arn'],
          },
        }),
        Match.objectLike({
          Action: 'execute-api:ManageConnections',
          Effect: 'Allow',
          Resource: Match.anyValue(),
        }),
      ]),
    },
  });
  template.hasOutput('RealtimeWebSocketUrl', {});
  template.hasOutput('RealtimeSessionsTableName', {});

  const realtimePolicy = template.toJSON().Resources
    .RealtimeHandlerFunctionServiceRoleDefaultPolicy58738CCE;
  const serializedRealtimePolicy = JSON.stringify(realtimePolicy);

  expect(serializedRealtimePolicy).toContain('ProjectDirectoryTable9ED01C01');
  expect(serializedRealtimePolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedRealtimePolicy).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(serializedRealtimePolicy).toContain('cognito-idp:AdminListGroupsForUser');
  expect(serializedRealtimePolicy).toContain('CognitoUserPoolId');
  expect(serializedRealtimePolicy).toContain('production/*/@connections/*');
  expect(serializedRealtimePolicy).not.toContain('/*/*/@connections/*');
});

test('audit stream projects notifications with retries DLQ and scoped production environment', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description: 'Projects audit outbox events into notifications and realtime invalidations.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        COLLABORATION_TABLE_NAME: {
          Ref: 'WorkItemCollaborationTableFDECF217',
        },
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
        FILE_BUCKET_NAME: Match.anyValue(),
        FILE_PROOFING_TABLE_NAME: Match.anyValue(),
        NOTIFICATIONS_TABLE_NAME: {
          Ref: 'NotificationsTable76DCFC6C',
        },
        PROCESSED_AUDIT_EVENTS_TABLE_NAME: {
          Ref: 'ProcessedAuditEventsTableFF485133',
        },
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: 'ProjectDirectoryTable9ED01C01',
        },
        REALTIME_SESSIONS_TABLE_NAME: {
          Ref: 'RealtimeSessionsTable607096EB',
        },
        SYSTEM_ADMIN_GROUPS: {
          Ref: 'SystemAdminGroups',
        },
        MUKUROJI_WORK_ITEMS_TABLE: {
          Ref: 'TeamIssuesTable189D851D',
        },
        TEAM_ISSUES_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
        WORK_ITEMS_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
        WEBSOCKET_CALLBACK_ENDPOINT: Match.anyValue(),
        WORKSPACE_ACCESS_TABLE_NAME: {
          Ref: 'WorkspaceAccessTableD7C8D2C7',
        },
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 10,
    BisectBatchOnFunctionError: true,
    EventSourceArn: {
      'Fn::GetAtt': ['AuditEventsTable0723963E', 'StreamArn'],
    },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumRetryAttempts: 3,
    StartingPosition: 'TRIM_HORIZON',
    DestinationConfig: {
      OnFailure: {
        Destination: Match.anyValue(),
      },
    },
  });
  template.hasResourceProperties('AWS::SQS::Queue', {
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true,
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'dynamodb:TransactWriteItems',
          Effect: 'Allow',
          Resource: Match.arrayWith([
            { 'Fn::GetAtt': ['NotificationsTable76DCFC6C', 'Arn'] },
            { 'Fn::GetAtt': ['ProcessedAuditEventsTableFF485133', 'Arn'] },
          ]),
        }),
        Match.objectLike({
          Action: 'execute-api:ManageConnections',
          Effect: 'Allow',
          Resource: Match.anyValue(),
        }),
      ]),
    },
  });
  template.hasOutput('NotificationsTableName', {});
  template.hasOutput('CollaborationProjectionDlqUrl', {});

  const projectionPolicy = template.toJSON().Resources
    .CollaborationProjectionFunctionServiceRoleDefaultPolicyDCBB176C;
  const serializedProjectionPolicy = JSON.stringify(projectionPolicy);
  const projectionStatements = projectionPolicy.Properties.PolicyDocument.Statement as Array<
    Record<string, unknown>
  >;
  const fileCleanupDynamoStatement = projectionStatements.find((statement) =>
    JSON.stringify(statement.Resource).includes('FileProofingTable') &&
    JSON.stringify(statement.Action).includes('dynamodb:UpdateItem')
  );
  const fileCleanupS3Statement = projectionStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('s3:PutObjectVersionTagging')
  );

  expect(serializedProjectionPolicy).toContain('production/*/@connections/*');
  expect(serializedProjectionPolicy).toContain('WorkItemCollaborationTableFDECF217');
  expect(serializedProjectionPolicy).toContain('cognito-idp:AdminListGroupsForUser');
  expect(serializedProjectionPolicy).toContain('CognitoUserPoolId');
  expect(serializedProjectionPolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedProjectionPolicy).toContain('FileProofingTable');
  expect(serializedProjectionPolicy).toContain('dynamodb:GetItem');
  expect(serializedProjectionPolicy).toContain('dynamodb:Query');
  expect(serializedProjectionPolicy).toContain('dynamodb:UpdateItem');
  expect(serializedProjectionPolicy).toContain('s3:GetObjectVersionTagging');
  expect(serializedProjectionPolicy).toContain('s3:PutObjectVersionTagging');
  expect(serializedProjectionPolicy).not.toContain('s3:DeleteObjectVersion');
  expect(serializedProjectionPolicy).not.toContain('/*/*/@connections/*');
  expect(fileCleanupDynamoStatement).toEqual(expect.objectContaining({
    Action: 'dynamodb:UpdateItem',
    Condition: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': ['scopeKey', 'recordKey', 'expiresAt', 'retentionUntil'],
      },
    },
    Effect: 'Allow',
  }));
  expect(fileCleanupS3Statement).toEqual(expect.objectContaining({
    Action: 's3:PutObjectVersionTagging',
    Condition: {
      'ForAllValues:StringEquals': {
        's3:RequestObjectTagKeys': [
          'GuardDutyMalwareScanStatus',
          'mukuroji-deleted',
          'mukuroji-upload',
        ],
      },
      StringEquals: {
        's3:RequestObjectTag/mukuroji-deleted': 'true',
      },
    },
    Effect: 'Allow',
  }));
  expect(JSON.stringify(fileCleanupS3Statement)).toContain('workspaces/*');
});

test('audit Webhook projection and SQS delivery are durable encrypted and observable', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const projectionEnvironment = {
    Variables: Match.objectLike({
      DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
      DEVELOPER_PLATFORM_TABLE_NAME: {
        Ref: 'DeveloperPlatformTable772E085C',
      },
      PROJECT_DIRECTORY_TABLE_NAME: {
        Ref: 'ProjectDirectoryTable9ED01C01',
      },
      WEBHOOK_DELIVERY_QUEUE_URL: {
        Ref: 'WebhookDeliveryQueue2A244492',
      },
      WORKSPACE_ACCESS_TABLE_NAME: {
        Ref: 'WorkspaceAccessTableD7C8D2C7',
      },
    }),
  };
  const deliveryEnvironment = {
    Variables: Match.objectLike({
      DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
      DEVELOPER_PLATFORM_TABLE_NAME: {
        Ref: 'DeveloperPlatformTable772E085C',
      },
      DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID: Match.anyValue(),
      PROJECT_DIRECTORY_TABLE_NAME: {
        Ref: 'ProjectDirectoryTable9ED01C01',
      },
      WEBHOOK_DELIVERY_QUEUE_URL: {
        Ref: 'WebhookDeliveryQueue2A244492',
      },
      WORKSPACE_ACCESS_TABLE_NAME: {
        Ref: 'WorkspaceAccessTableD7C8D2C7',
      },
    }),
  };

  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description: 'Projects audit events into durable signed Webhook deliveries.',
    Handler: 'index.projectionHandler',
    Runtime: 'nodejs22.x',
    Timeout: 30,
    Environment: projectionEnvironment,
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description: 'Delivers signed Webhooks from the durable SQS queue.',
    Handler: 'index.deliveryHandler',
    Runtime: 'nodejs22.x',
    Timeout: 30,
    Environment: deliveryEnvironment,
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 10,
    BisectBatchOnFunctionError: true,
    DestinationConfig: {
      OnFailure: {
        Destination: {
          'Fn::GetAtt': ['WebhookProjectionDlq93E06A80', 'Arn'],
        },
      },
    },
    EventSourceArn: {
      'Fn::GetAtt': ['AuditEventsTable0723963E', 'StreamArn'],
    },
    FunctionName: {
      Ref: 'WebhookProjectionFunctionDA24C36F',
    },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumRetryAttempts: 3,
    StartingPosition: 'TRIM_HORIZON',
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 10,
    EventSourceArn: {
      'Fn::GetAtt': ['WebhookDeliveryQueue2A244492', 'Arn'],
    },
    FunctionName: {
      Ref: 'WebhookDeliveryFunctionEA305509',
    },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
  });

  expect(resources.WebhookProjectionDlq93E06A80).toEqual({
    Type: 'AWS::SQS::Queue',
    Properties: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    },
    UpdateReplacePolicy: 'Delete',
    DeletionPolicy: 'Delete',
  });
  expect(resources.WebhookDeliveryDlq163DBE73).toEqual({
    Type: 'AWS::SQS::Queue',
    Properties: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    },
    UpdateReplacePolicy: 'Delete',
    DeletionPolicy: 'Delete',
  });
  expect(resources.WebhookDeliveryQueue2A244492).toEqual({
    Type: 'AWS::SQS::Queue',
    Properties: {
      MessageRetentionPeriod: 1209600,
      RedrivePolicy: {
        deadLetterTargetArn: {
          'Fn::GetAtt': ['WebhookDeliveryDlq163DBE73', 'Arn'],
        },
        maxReceiveCount: 5,
      },
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 120,
    },
    UpdateReplacePolicy: 'Delete',
    DeletionPolicy: 'Delete',
  });
  expect(resources.WebhookDeliveryQueue2A244492.Properties.FifoQueue).toBeUndefined();

  for (const [alarmDescription, queueLogicalId] of [
    [
      'Detects audit events that exhausted Webhook projection retries.',
      'WebhookProjectionDlq93E06A80',
    ],
    [
      'Detects signed Webhook deliveries that exhausted queue redrive attempts.',
      'WebhookDeliveryDlq163DBE73',
    ],
  ] as const) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmDescription: alarmDescription,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      DatapointsToAlarm: 1,
      Dimensions: [{
        Name: 'QueueName',
        Value: {
          'Fn::GetAtt': [queueLogicalId, 'QueueName'],
        },
      }],
      EvaluationPeriods: 1,
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Period: 300,
      Statistic: 'Maximum',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
  }

  const projectionRoleId = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('WebhookProjectionFunctionServiceRole') &&
    (resource as { Type?: string }).Type === 'AWS::IAM::Role'
  )?.[0];
  const deliveryRoleId = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('WebhookDeliveryFunctionServiceRole') &&
    (resource as { Type?: string }).Type === 'AWS::IAM::Role'
  )?.[0];
  expect(projectionRoleId).toBeDefined();
  expect(deliveryRoleId).toBeDefined();
  const policiesForRole = (roleId: string | undefined) =>
    Object.values(resources).filter((resource) => {
      if (!roleId || (resource as { Type?: string }).Type !== 'AWS::IAM::Policy') return false;
      const roles = (resource as { Properties?: { Roles?: unknown[] } }).Properties?.Roles ?? [];
      return roles.some((role) => (role as { Ref?: string }).Ref === roleId);
    });
  const projectionPolicies = JSON.stringify(policiesForRole(projectionRoleId));
  const deliveryPolicies = JSON.stringify(policiesForRole(deliveryRoleId));

  expect(projectionPolicies).toContain('AuditEventsTable0723963E');
  expect(projectionPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(projectionPolicies).toContain('ProjectDirectoryTable9ED01C01');
  expect(projectionPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(projectionPolicies).toContain('WebhookDeliveryQueue2A244492');
  expect(projectionPolicies).toContain('WebhookProjectionDlq93E06A80');
  expect(projectionPolicies).toContain('dynamodb:GetRecords');
  expect(projectionPolicies).toContain('dynamodb:TransactWriteItems');
  expect(projectionPolicies).not.toContain('kms:');
  expect(projectionPolicies).toContain('sqs:SendMessage');
  expect(deliveryPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(deliveryPolicies).toContain('ProjectDirectoryTable9ED01C01');
  expect(deliveryPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(deliveryPolicies).toContain('WebhookDeliveryQueue2A244492');
  expect(deliveryPolicies).toContain('dynamodb:PutItem');
  expect(deliveryPolicies).toContain('kms:Decrypt');
  expect(deliveryPolicies).not.toContain('kms:Encrypt');
  expect(deliveryPolicies).not.toContain('kms:GenerateDataKey');
  expect(deliveryPolicies).toContain('sqs:ReceiveMessage');
  expect(deliveryPolicies).toContain('sqs:DeleteMessage');
  expect(deliveryPolicies).toContain('sqs:SendMessage');
  const projectionFunction = Object.values(resources).find((resource) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Projects audit events into durable signed Webhook deliveries.'
  ) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
  const deliveryFunction = Object.values(resources).find((resource) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Delivers signed Webhooks from the durable SQS queue.'
  ) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
  expect(projectionFunction.Properties.Environment.Variables)
    .not.toHaveProperty('DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID');
  expect(deliveryFunction.Properties.Environment.Variables)
    .toHaveProperty('DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID');
  const projectionWildcardStatements = policiesForRole(projectionRoleId).flatMap((resource) =>
    (
      resource as {
        Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
      }
    ).Properties.PolicyDocument.Statement.filter((statement) => statement.Resource === '*')
  );
  expect(projectionWildcardStatements).toEqual([{
    Action: 'dynamodb:ListStreams',
    Effect: 'Allow',
    Resource: '*',
  }]);
  expect(deliveryPolicies).not.toContain('"Resource":"*"');

  template.hasOutput('WebhookProjectionDlqUrl', {
    Value: { Ref: 'WebhookProjectionDlq93E06A80' },
  });
  template.hasOutput('WebhookDeliveryQueueUrl', {
    Value: { Ref: 'WebhookDeliveryQueue2A244492' },
  });
  template.hasOutput('WebhookDeliveryDlqUrl', {
    Value: { Ref: 'WebhookDeliveryDlq163DBE73' },
  });
});

test('connector runtime uses secret-backed configuration and isolated durable workers', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const findResourceId = (
    prefix: string,
    type: string,
  ) => Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith(prefix) &&
    (resource as { Type?: string }).Type === type
  )?.[0];
  const secretId = findResourceId('ConnectorRuntimeSecret', 'AWS::SecretsManager::Secret');
  const configurationKeyId = findResourceId(
    'ConnectorRuntimeConfigurationKey',
    'AWS::KMS::Key',
  );
  const queueId = findResourceId('ConnectorSyncQueue', 'AWS::SQS::Queue');
  const dlqId = findResourceId('ConnectorSyncDlq', 'AWS::SQS::Queue');
  const projectionFunctionId = findResourceId(
    'ConnectorAuditProjectionFunction',
    'AWS::Lambda::Function',
  );
  const workerFunctionId = findResourceId('ConnectorSyncFunction', 'AWS::Lambda::Function');
  const pollFunctionId = findResourceId('ConnectorPollFunction', 'AWS::Lambda::Function');

  expect(secretId).toBeDefined();
  expect(configurationKeyId).toBeDefined();
  expect(queueId).toBeDefined();
  expect(dlqId).toBeDefined();
  expect(projectionFunctionId).toBeDefined();
  expect(workerFunctionId).toBeDefined();
  expect(pollFunctionId).toBeDefined();
  if (
    !secretId ||
    !configurationKeyId ||
    !queueId ||
    !dlqId ||
    !projectionFunctionId ||
    !workerFunctionId ||
    !pollFunctionId
  ) {
    throw new Error('Connector runtime resources were not synthesized.');
  }

  expect(resources[secretId]).toEqual(expect.objectContaining({
    Type: 'AWS::SecretsManager::Secret',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      Description:
        'Provider configuration and signing secrets loaded only by connector runtimes.',
      KmsKeyId: { 'Fn::GetAtt': [configurationKeyId, 'Arn'] },
      SecretString: { Ref: 'ConnectorRuntimeConfiguration' },
    }),
  }));
  expect(resources[queueId]).toEqual(expect.objectContaining({
    Type: 'AWS::SQS::Queue',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1209600,
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
        maxReceiveCount: 5,
      },
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 360,
    }),
  }));
  expect(resources[dlqId]).toEqual(expect.objectContaining({
    Type: 'AWS::SQS::Queue',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    }),
  }));

  for (const [description, handler, timeout, runtimeRole] of [
    [
      'Projects audit events into provider-neutral connector sync jobs.',
      'index.auditProjectionHandler',
      30,
      'connector-audit-projection',
    ],
    [
      'Processes provider-neutral connector synchronization jobs with current Work Item RBAC.',
      'index.queueHandler',
      300,
      'connector-queue-worker',
    ],
    [
      'Schedules bounded polling jobs for connected provider installations.',
      'index.pollHandler',
      120,
      'connector-poll',
    ],
  ] as const) {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Code: {
        S3Bucket: Match.anyValue(),
        S3Key: Match.stringLikeRegexp('\\.zip$'),
      },
      Description: description,
      Handler: handler,
      Runtime: 'nodejs22.x',
      Timeout: timeout,
      Environment: {
        Variables: Match.objectLike({
          CONNECTOR_SYNC_QUEUE_URL: { Ref: queueId },
          MUKUROJI_RUNTIME_ROLE: runtimeRole,
        }),
      },
    });
  }
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description:
      'Processes provider-neutral connector synchronization jobs with current Work Item RBAC.',
    Environment: {
      Variables: Match.objectLike({
        CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN: { Ref: secretId },
        DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID: Match.anyValue(),
        DEVELOPER_PLATFORM_STATE_KMS_KEY_ID: Match.anyValue(),
        DEVELOPER_PLATFORM_TABLE_NAME: {
          Ref: 'DeveloperPlatformTable772E085C',
        },
        WORK_ITEMS_TABLE_NAME: {
          Ref: 'TeamIssuesTable189D851D',
        },
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: 'Schedules bounded polling jobs for connected provider installations.',
    Environment: {
      Variables: Match.objectLike({
        DEVELOPER_PLATFORM_TABLE_NAME: {
          Ref: 'DeveloperPlatformTable772E085C',
        },
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: 'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
    Environment: {
      Variables: Match.objectLike({
        CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN: { Ref: secretId },
      }),
    },
  });
  const apiFunction = Object.values(resources).find((resource) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.'
  ) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
  expect(apiFunction.Properties.Environment.Variables)
    .not.toHaveProperty('CONNECTOR_SYNC_QUEUE_URL');

  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 1,
    EventSourceArn: { 'Fn::GetAtt': [queueId, 'Arn'] },
    FunctionName: { Ref: workerFunctionId },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 10,
    BisectBatchOnFunctionError: true,
    DestinationConfig: {
      OnFailure: {
        Destination: { 'Fn::GetAtt': [dlqId, 'Arn'] },
      },
    },
    EventSourceArn: {
      'Fn::GetAtt': ['AuditEventsTable0723963E', 'StreamArn'],
    },
    FunctionName: { Ref: projectionFunctionId },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumRetryAttempts: 3,
    StartingPosition: 'LATEST',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Schedules bounded connector polling for providers without push events.',
    ScheduleExpression: 'rate(5 minutes)',
    State: 'ENABLED',
    Targets: Match.arrayWith([
      Match.objectLike({
        Arn: { 'Fn::GetAtt': [pollFunctionId, 'Arn'] },
        DeadLetterConfig: {
          Arn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
        },
        RetryPolicy: {
          MaximumEventAgeInSeconds: 3600,
          MaximumRetryAttempts: 2,
        },
      }),
    ]),
  });

  const policiesForFunction = (functionId: string) => {
    const functionResource = resources[functionId] as {
      Properties: { Role: { 'Fn::GetAtt': [string, string] } };
    };
    const roleId = functionResource.Properties.Role['Fn::GetAtt'][0];
    return Object.values(resources).filter((resource) => {
      if ((resource as { Type?: string }).Type !== 'AWS::IAM::Policy') return false;
      const roles = (
        resource as { Properties?: { Roles?: Array<{ Ref?: string }> } }
      ).Properties?.Roles ?? [];
      return roles.some((role) => role.Ref === roleId);
    });
  };
  const projectionPolicies = JSON.stringify(policiesForFunction(projectionFunctionId));
  const workerPolicies = JSON.stringify(policiesForFunction(workerFunctionId));
  const pollPolicies = JSON.stringify(policiesForFunction(pollFunctionId));

  expect(projectionPolicies).toContain('AuditEventsTable0723963E');
  expect(projectionPolicies).toContain(queueId);
  expect(projectionPolicies).toContain(dlqId);
  expect(projectionPolicies).not.toContain('ConnectorRuntimeSecret');
  expect(projectionPolicies).not.toContain('DeveloperPlatformTable772E085C');
  expect(workerPolicies).toContain(secretId);
  expect(workerPolicies).toContain(queueId);
  expect(workerPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(workerPolicies).toContain('TeamIssuesTable189D851D');
  expect(workerPolicies).toContain('AuditEventsTable0723963E');
  expect(workerPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(workerPolicies).toContain('dynamodb:TransactWriteItems');
  expect(workerPolicies).toContain('kms:Decrypt');
  expect(workerPolicies).toContain('kms:Encrypt');
  expect(workerPolicies).toContain('secretsmanager:GetSecretValue');
  expect(pollPolicies).toContain(queueId);
  expect(pollPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(pollPolicies).toContain('dynamodb:Scan');
  expect(pollPolicies).not.toContain(secretId);
  expect(pollPolicies).not.toContain('secretsmanager:GetSecretValue');
  expect(pollPolicies).not.toContain('TeamIssuesTable189D851D');
  expect(pollPolicies).not.toContain('AuditEventsTable0723963E');
  expect(pollPolicies).not.toContain('DeveloperPlatformConnectorKey');

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects connector projection, polling, or sync jobs that exhausted retries.',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Threshold: 1,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects connector synchronization jobs delayed for 15 minutes.',
    ComparisonOperator: 'GreaterThanThreshold',
    MetricName: 'ApproximateAgeOfOldestMessage',
    Threshold: 900,
  });
  template.hasOutput('ConnectorRuntimeSecretArn', {
    Value: { Ref: secretId },
  });
  template.hasOutput('ConnectorSyncQueueUrl', {
    Value: { Ref: queueId },
  });
  template.hasOutput('ConnectorSyncDlqUrl', {
    Value: { Ref: dlqId },
  });
});

test('hourly schedule emits deterministic events and surfaces bounded scan failures', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: 'Emits deterministic due and overdue Work Item notification events.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 300,
    Environment: {
      Variables: Match.objectLike({
        AUDIT_EVENTS_TABLE_NAME: { Ref: 'AuditEventsTable0723963E' },
        AUDIT_RETENTION_DAYS: { Ref: 'AuditRetentionDays' },
        NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
        NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
        WORK_ITEMS_TABLE_NAME: { Ref: 'TeamIssuesTable189D851D' },
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    DestinationConfig: {
      OnFailure: {
        Destination: Match.anyValue(),
      },
    },
    MaximumRetryAttempts: 2,
  });
  template.resourceCountIs('AWS::SQS::Queue', 9);
  template.hasResourceProperties('AWS::SQS::Queue', {
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects notification schedule failures after asynchronous retries, including scan page limit exhaustion.',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    DatapointsToAlarm: 1,
    EvaluationPeriods: 1,
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    Period: 300,
    Statistic: 'Maximum',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Checks canonical Work Items for due and overdue notifications.',
    ScheduleExpression: 'rate(1 hour)',
    State: 'ENABLED',
    Targets: Match.arrayWith([
      Match.objectLike({
        Arn: Match.anyValue(),
        Id: Match.anyValue(),
      }),
    ]),
  });

  const schedulePolicy = Object.entries(template.toJSON().Resources).find(([logicalId]) =>
    logicalId.startsWith('NotificationScheduleFunctionServiceRoleDefaultPolicy')
  )?.[1];
  const serializedSchedulePolicy = JSON.stringify(schedulePolicy);

  expect(serializedSchedulePolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedSchedulePolicy).toContain('AuditEventsTable0723963E');
  expect(serializedSchedulePolicy).toContain('dynamodb:Scan');
  expect(serializedSchedulePolicy).toContain('dynamodb:PutItem');
  expect(serializedSchedulePolicy).toContain('sqs:SendMessage');
  template.hasOutput('NotificationScheduleDlqUrl', {});
});

test('API IAM is limited to the data tables and configured Cognito user pool', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const apiRoleLogicalId = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('ListProjectTasksFunctionServiceRole') &&
    (resource as { Type?: string }).Type === 'AWS::IAM::Role'
  )?.[0];
  expect(apiRoleLogicalId).toBeDefined();
  if (!apiRoleLogicalId) {
    throw new Error('API Lambda execution role was not found.');
  }
  const apiPolicies = Object.values(resources)
    .filter((resource) => {
      if ((resource as { Type?: string }).Type !== 'AWS::IAM::Policy') return false;
      const roles = (resource as { Properties?: { Roles?: unknown[] } }).Properties?.Roles ?? [];
      return roles.some((role) =>
        (role as { Ref?: string }).Ref === apiRoleLogicalId
      );
    })
    .map((resource) => resource as {
      Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
    });
  expect(apiPolicies).not.toHaveLength(0);
  const statements = apiPolicies.flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement
  );
  const fileObjectStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('FileBucket')
  );
  const fileObjectActions = fileObjectStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  const serializedApiPolicies = JSON.stringify(apiPolicies);
  const transactStatement = statements.find((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes('dynamodb:TransactWriteItems') &&
      JSON.stringify(statement.Resource).includes('WorkspaceSearchTable2575AD6B');
  });
  const configurationDataStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource) === JSON.stringify({
      'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'],
    }) &&
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:ConditionCheckItem')
  );
  const configurationStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('WorkItemConfigurationTable35E94558')
  );
  const planningDataStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource) === JSON.stringify({
      'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'],
    }) &&
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:ConditionCheckItem')
  );
  const planningStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('PlanningTable2A0D4CC5')
  );
  const developerPlatformDataStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource).includes('DeveloperPlatformTable772E085C') &&
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:Query')
  );
  const webhookQueueSendStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource).includes('WebhookDeliveryQueue2A244492') &&
    statement.Action === 'sqs:SendMessage'
  );
  const connectorSyncQueueLogicalId = Object.entries(resources).find(
    ([logicalId, resource]) =>
      logicalId.startsWith('ConnectorSyncQueue') &&
      (resource as { Type?: string }).Type === 'AWS::SQS::Queue',
  )?.[0];
  expect(connectorSyncQueueLogicalId).toBeDefined();
  const cognitoPolicy = Object.values(template.toJSON().Resources).find((resource) =>
    JSON.stringify(resource).includes('cognito-idp:AdminGetUser')
  );

  expect(transactStatement).toEqual(expect.objectContaining({
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'] },
      { 'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'] },
      { 'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemCollaborationTableFDECF217', 'Arn'] },
      { 'Fn::GetAtt': ['FileProofingTable81DA272F', 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceSearchTable2575AD6B', 'Arn'] },
      { 'Fn::GetAtt': ['DeveloperPlatformTable772E085C', 'Arn'] },
    ]),
  }));
  expect(serializedApiPolicies).toContain('WorkspaceSearchTable2575AD6B');
  expect(serializedApiPolicies).toContain('kms:Decrypt');
  expect(serializedApiPolicies).toContain('kms:GenerateDataKey');
  expect(serializedApiPolicies).toContain('DeveloperPlatformWebhookKey');
  expect(serializedApiPolicies).toContain('DeveloperPlatformConnectorKey');
  expect(serializedApiPolicies).toContain('DeveloperPlatformStateKey');
  expect(JSON.stringify(transactStatement)).not.toContain('ProjectTasksTableE21F6637');
  expect(JSON.stringify(transactStatement)).toContain('FileProofingTable');
  expect(fileObjectStatements).not.toHaveLength(0);
  expect(fileObjectStatements).toEqual(expect.arrayContaining([
    expect.objectContaining({ Effect: 'Allow' }),
  ]));
  expect(fileObjectActions).toEqual(expect.arrayContaining([
    's3:DeleteObject',
    's3:GetObject',
    's3:GetObjectAttributes',
    's3:GetObjectVersion',
    's3:GetObjectVersionTagging',
    's3:PutObject',
    's3:PutObjectVersionTagging',
  ]));
  expect(JSON.stringify(fileObjectStatements)).toContain('workspaces/*');
  expect(fileObjectActions).not.toContain('s3:ListBucket');
  expect(fileObjectActions).not.toContain('s3:DeleteObjectVersion');
  expect(fileObjectActions).not.toContain('s3:DeleteObjectTagging');
  expect(serializedApiPolicies).toContain('NotificationsTable76DCFC6C');
  expect(serializedApiPolicies).toContain('dynamodb:Query');
  expect(serializedApiPolicies).toContain('dynamodb:PutItem');

  const workspaceSearchStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('WorkspaceSearchTable2575AD6B')
  );
  const workspaceSearchActions = workspaceSearchStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  expect(workspaceSearchActions).toEqual(expect.arrayContaining([
    'dynamodb:DeleteItem',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:TransactWriteItems',
    'dynamodb:UpdateItem',
  ]));
  expect(configurationDataStatement).toEqual({
    Action: [
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:DescribeTable',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    Effect: 'Allow',
    Resource: { 'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'] },
  });
  expect(configurationStatements).toHaveLength(2);
  expect(configurationStatements).toEqual(expect.arrayContaining([
    configurationDataStatement,
    transactStatement,
  ]));
  expect(planningDataStatement).toEqual(expect.objectContaining({
    Action: [
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:DescribeTable',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    Effect: 'Allow',
    Resource: { 'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'] },
  }));
  expect(planningStatements).toHaveLength(2);
  expect(planningStatements).toEqual(expect.arrayContaining([
    planningDataStatement,
    transactStatement,
  ]));
  expect(developerPlatformDataStatement).toEqual({
    Action: [
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    Effect: 'Allow',
    Resource: [
      { 'Fn::GetAtt': ['DeveloperPlatformTable772E085C', 'Arn'] },
      {
        'Fn::Join': [
          '',
          [
            { 'Fn::GetAtt': ['DeveloperPlatformTable772E085C', 'Arn'] },
            '/index/*',
          ],
        ],
      },
    ],
  });
  expect(webhookQueueSendStatement).toEqual(expect.objectContaining({
    Action: 'sqs:SendMessage',
    Effect: 'Allow',
    Resource: [
      {
        'Fn::GetAtt': ['WebhookDeliveryQueue2A244492', 'Arn'],
      },
      {
        'Fn::GetAtt': ['WorkItemImportQueueA2F07A30', 'Arn'],
      },
    ],
  }));
  expect(serializedApiPolicies).not.toContain(connectorSyncQueueLogicalId);

  const legacyTaskStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('ProjectTasksTableE21F6637')
  );
  const legacyTaskActions = legacyTaskStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );

  expect(legacyTaskStatements).not.toHaveLength(0);
  expect(legacyTaskActions).toEqual(expect.arrayContaining([
    'dynamodb:BatchGetItem',
    'dynamodb:GetItem',
    'dynamodb:Query',
    'dynamodb:Scan',
  ]));
  for (const writeAction of [
    'dynamodb:BatchWriteItem',
    'dynamodb:DeleteItem',
    'dynamodb:PutItem',
    'dynamodb:TransactWriteItems',
    'dynamodb:UpdateItem',
  ]) {
    expect(legacyTaskActions).not.toContain(writeAction);
  }
  expect(JSON.stringify(cognitoPolicy)).toContain('cognito-idp:ListUsers');
  expect(JSON.stringify(cognitoPolicy)).toContain('cognito-idp:AdminDeleteUserAttributes');
  expect(JSON.stringify(cognitoPolicy)).toContain('CognitoUserPoolId');
  expect(serializedApiPolicies).not.toContain('"Resource":"*"');
  expect(serializedApiPolicies).not.toContain('"Action":"s3:*"');
  expect(JSON.stringify(cognitoPolicy)).not.toContain('"Resource":"*"');
});

test('external Cognito client and initial owner attributes are validated on create and update', () => {
  const template = synthesizedTemplate;
  const [, clientValidation] = findCustomResource(template, 'describeUserPoolClient');
  const [, ownerAttributes] = findCustomResource(template, 'adminUpdateUserAttributes');
  const clientCreate = serializeAwsSdkCall(clientValidation.Properties.Create);
  const ownerCreate = serializeAwsSdkCall(ownerAttributes.Properties.Create);

  expect(clientCreate).toContain('describeUserPoolClient');
  expect(clientCreate).toContain('CognitoUserPoolId');
  expect(clientCreate).toContain('CognitoUserPoolClientId');
  expect(clientValidation.Properties.Update).toEqual(clientValidation.Properties.Create);

  expect(ownerCreate).toContain('adminUpdateUserAttributes');
  expect(ownerCreate).toContain('InitialOwnerUsername');
  expect(ownerCreate).toContain('custom:directory_id');
  expect(ownerCreate).toContain('custom:workspace_id');
  expect(ownerCreate.match(/WorkspaceDirectoryId/g)).toHaveLength(2);
  expect(ownerAttributes.Properties.Update).toEqual(ownerAttributes.Properties.Create);

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminUpdateUserAttributes',
            'cognito-idp:DescribeUserPoolClient',
          ]),
          Effect: 'Allow',
          Resource: Match.anyValue(),
        }),
      ]),
    },
  });
});

test('workspace metadata owner alias and project manager rows are idempotently bootstrapped', () => {
  const template = synthesizedTemplate;
  const [, bootstrap] = Object.entries(template.findResources('Custom::AWS')).find(([, candidate]) =>
    JSON.stringify(candidate).includes('workspace-bootstrap-v2'),
  ) ?? [];

  if (!bootstrap) {
    throw new Error('Workspace bootstrap custom resource was not found.');
  }

  const createPayload = serializeAwsSdkCall(bootstrap.Properties.Create);

  expect(createPayload).toContain('transactWriteItems');
  expect(createPayload).toContain('WORKSPACE#METADATA');
  expect(createPayload).toContain('workspace-metadata');
  expect(createPayload).toContain('WORKSPACE_MEMBER#');
  expect(createPayload).toContain('workspace-member');
  expect(createPayload).toContain('EMAIL_ALIAS#');
  expect(createPayload).toContain('email-alias');
  expect(createPayload).toContain('InitialOwnerEmail');
  expect(createPayload).toContain('InitialOwnerUsername');
  expect(createPayload).toContain('WorkspaceDirectoryId');
  expect(createPayload).toContain('PROJECT_MEMBER#refero#');
  expect(createPayload).toContain('PROJECT_MEMBER#product-roadmap#');
  expect(createPayload).toContain('PROJECT_MEMBER#shared-launch#');
  expect(createPayload).toContain('PROJECT_MEMBER#brand-refresh#');
  expect(createPayload.match(/":role":\{"S":"manager"\}/g)).toHaveLength(4);
  expect(createPayload.match(/":timestamp":\{"S":"2026-07-11T00:00:00.000Z"\}/g)).toHaveLength(5);
  expect(createPayload.match(/"Update"/g)).toHaveLength(7);
  expect(createPayload).not.toContain('"Item"');
  expect(createPayload).toContain('createdAt = if_not_exists(createdAt, :timestamp)');
  expect(createPayload).toContain('updatedAt = if_not_exists(updatedAt, :timestamp)');
  expect(createPayload.match(/#role = :role/g)).toHaveLength(1);
  expect(createPayload.match(/#role = if_not_exists\(#role, :role\)/g)).toHaveLength(4);
  expect(createPayload).toContain('attribute_not_exists(directoryId) OR');
  expect(bootstrap.Properties.Update).toEqual(bootstrap.Properties.Create);
});

test('bootstrap transactions synthesize enclosed DynamoDB write permissions for create and update', () => {
  const template = synthesizedTemplate;
  const customResources = template.findResources('Custom::AWS');
  const policies = template.findResources('AWS::IAM::Policy');
  const tables = template.findResources('AWS::DynamoDB::Table');
  const outputs = template.toJSON().Outputs;
  const transactionCases = [
    {
      customResourcePrefix: 'SeedProjectDirectory',
      policyPrefix: 'SeedProjectDirectoryCustomResourcePolicy',
      itemAction: 'dynamodb:PutItem',
      tableOutputName: 'ProjectDirectoryTableName',
      physicalResourceId: 'project-directory-seed-v3',
      runsOnUpdate: false,
    },
    {
      customResourcePrefix: 'SeedWorkspaceAccess',
      policyPrefix: 'SeedWorkspaceAccessCustomResourcePolicy',
      itemAction: 'dynamodb:UpdateItem',
      tableOutputName: 'WorkspaceAccessTableName',
      physicalResourceId: 'workspace-access-seed-v2',
      runsOnUpdate: true,
    },
    {
      customResourcePrefix: 'BootstrapWorkspace',
      policyPrefix: 'BootstrapWorkspaceCustomResourcePolicy',
      itemAction: 'dynamodb:UpdateItem',
      tableOutputName: 'ProjectDirectoryTableName',
      physicalResourceId: 'workspace-bootstrap-v2',
      runsOnUpdate: true,
    },
    {
      customResourcePrefix: 'SeedWorkspaceDemoMembers',
      policyPrefix: 'SeedWorkspaceDemoMembersCustomResourcePolicy',
      itemAction: 'dynamodb:UpdateItem',
      tableOutputName: 'WorkspaceAccessTableName',
      physicalResourceId: 'workspace-access-demo-members-seed-v2',
      runsOnUpdate: true,
    },
  ] as const;

  for (const transactionCase of transactionCases) {
    const customResource = Object.entries(customResources).find(([logicalId]) =>
      logicalId.startsWith(transactionCase.customResourcePrefix),
    )?.[1];
    const policy = Object.entries(policies).find(([logicalId]) =>
      logicalId.startsWith(transactionCase.policyPrefix),
    )?.[1] as {
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<Record<string, unknown>>;
        };
      };
    } | undefined;

    expect(customResource).toBeDefined();
    expect(customResource?.Properties.Create).toBeDefined();
    const createPayload = serializeAwsSdkCall(customResource?.Properties.Create);
    const tableLogicalId = outputs[transactionCase.tableOutputName]?.Value?.Ref;

    expect(createPayload).toContain(transactionCase.physicalResourceId);
    if (typeof tableLogicalId !== 'string') {
      throw new Error(
        `DynamoDB table output ${transactionCase.tableOutputName} was not found.`,
      );
    }
    expect(tables[tableLogicalId]).toBeDefined();
    expect(createPayload).toContain(`{{Ref:${tableLogicalId}}}`);
    if (transactionCase.runsOnUpdate) {
      expect(customResource?.Properties.Update).toEqual(customResource?.Properties.Create);
    } else {
      expect(customResource?.Properties.Update).toBeUndefined();
    }

    const statements = policy?.Properties?.PolicyDocument?.Statement ?? [];
    const tableArn = { 'Fn::GetAtt': [tableLogicalId, 'Arn'] };
    const itemActionStatements = statements.filter((statement) =>
      statement.Action === transactionCase.itemAction,
    );

    expect(itemActionStatements).toEqual([
      {
        Action: transactionCase.itemAction,
        Condition: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
        Effect: 'Allow',
        Resource: tableArn,
      },
    ]);
  }
});

test('canonical Work Item seed writes complete schema data and preserves demo data', () => {
  const template = synthesizedTemplate;
  const customResources = template.findResources('Custom::AWS');
  const transactWriteResources = Object.values(customResources).filter((resource) =>
    JSON.stringify(resource).includes('transactWriteItems'),
  );
  const canonicalWorkItemSeedEntry = Object.entries(customResources).find(([logicalId]) =>
    logicalId === 'SeedProjectTasks637E8868'
  );
  const canonicalWorkItemSeed = canonicalWorkItemSeedEntry?.[1];
  const canonicalWorkItemSeedPolicyEntry = Object.entries(
    template.findResources('AWS::IAM::Policy'),
  ).find(([logicalId]) => logicalId === 'SeedProjectTasksCustomResourcePolicy924038FB');
  const projectDirectorySeed = transactWriteResources.find((resource) =>
    JSON.stringify(resource).includes('project-directory-seed-v3'),
  );

  expect(canonicalWorkItemSeedEntry?.[0]).toBe('SeedProjectTasks637E8868');
  expect(canonicalWorkItemSeed).toBeDefined();
  expect(canonicalWorkItemSeedPolicyEntry).toBeDefined();
  expect(projectDirectorySeed).toBeDefined();
  expect(JSON.stringify(customResources)).not.toContain('refero-project-tasks-seed-v3');
  expect(Object.keys(customResources).join(',')).not.toContain('SeedCanonicalWorkItems');

  const workItemPayload = serializeAwsSdkCall(canonicalWorkItemSeed?.Properties.Create);
  const directoryPayload = serializeAwsSdkCall(projectDirectorySeed?.Properties.Create);

  expect(workItemPayload).toContain('WorkspaceDirectoryId');
  expect(workItemPayload).toContain('TeamIssuesTable189D851D');
  expect(workItemPayload).not.toContain('ProjectTasksTableE21F6637');
  expect(workItemPayload).toContain('attribute_not_exists(directoryTeamId)');
  expect(workItemPayload).toContain('attribute_not_exists(issueId)');
  expect(workItemPayload).toContain('core-team');
  expect(workItemPayload).toContain('assignedProjectId');
  expect(workItemPayload).toContain('2026-06-01T00:00:00.000Z');
  expect(workItemPayload.match(/schemaVersion/g)).toHaveLength(10);
  expect(workItemPayload.match(/workflowSchemaVersion/g)).toHaveLength(10);
  expect(workItemPayload.match(/workflowStatusId/g)).toHaveLength(10);
  expect(workItemPayload.match(/statusCategory/g)).toHaveLength(10);
  expect(workItemPayload.match(/customFieldValues/g)).toHaveLength(10);
  expect(workItemPayload.match(/relationIds/g)).toHaveLength(10);
  expect(workItemPayload.match(/creatorMemberKey/g)).toHaveLength(10);
  expect(workItemPayload).toContain('"statusCategory":{"S":"unstarted"}');
  expect(workItemPayload).toContain('"statusCategory":{"S":"started"}');
  expect(workItemPayload).toContain('"statusCategory":{"S":"completed"}');
  expect(workItemPayload).not.toMatch(/"status":\{"S":/);
  expect(workItemPayload).not.toContain('"titleKey"');
  expect(workItemPayload.match(/revision/g)).toHaveLength(10);
  expect(workItemPayload).not.toContain('"workItemId"');
  expect(workItemPayload).not.toContain('migrationSourceKey');
  expect(workItemPayload).not.toMatch(/"source":\{"S":/);
  expect(workItemPayload).not.toMatch(/"migrationSource":\{"S":/);
  const canonicalWorkItemSeedPolicy = canonicalWorkItemSeedPolicyEntry?.[1] as {
    Properties?: {
      PolicyDocument?: {
        Statement?: unknown[];
      };
    };
  } | undefined;
  expect(canonicalWorkItemSeedPolicy?.Properties?.PolicyDocument?.Statement).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Action: 'dynamodb:TransactWriteItems',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      }),
      expect.objectContaining({
        Action: 'dynamodb:PutItem',
        Condition: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      }),
    ]),
  );
  expect(JSON.stringify(canonicalWorkItemSeedPolicy)).not.toContain('ProjectTasksTableE21F6637');
  expect(directoryPayload).toContain('WorkspaceDirectoryId');
  expect(workItemPayload).not.toContain('user#demo@example.com');
  expect(directoryPayload).not.toContain('user#demo@example.com');
  expect(canonicalWorkItemSeed?.Properties.Update).toBeUndefined();
  expect(projectDirectorySeed?.Properties.Update).toBeUndefined();
});
