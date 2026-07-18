import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import { CdkStack } from '../lib/cdk-stack';

/**
 * 各 test で使用する synthesized CloudFormation template を作成します。
 */
function createTemplate() {
  const app = new cdk.App();
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

test('fresh deployment requires explicit Cognito workspace and request secrets parameters', () => {
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
  expect(parameters.RequestRateLimitPerHour).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 10,
    MinValue: 1,
    MaxValue: 10000,
  }));
  for (const secretParameterName of [
    'RequestEmailWebhookSecret',
    'RequestTokenHashSecret',
  ]) {
    expect(parameters[secretParameterName]).toEqual(expect.objectContaining({
      Type: 'String',
      MinLength: 32,
      MaxLength: 256,
      NoEcho: true,
    }));
  }

  for (const parameterName of [
    'CognitoUserPoolId',
    'CognitoUserPoolClientId',
    'WorkspaceDirectoryId',
    'WorkspaceAuditPseudonymKey',
    'InitialOwnerEmail',
    'InitialOwnerUsername',
    'RequestEmailWebhookSecret',
    'RequestTokenHashSecret',
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
    'AutomationTableE3D67F0D',
    'PlanningTable2A0D4CC5',
    'TeamIssueEventsTableDD2B0F96',
    'ProjectDirectoryTable9ED01C01',
    'ListProjectTasksFunction2134AF4A',
    'DocumentsTable7E808EE5',
    'WorkItemCollaborationTableFDECF217',
    'WorkspaceSearchTable2575AD6B',
    'NotificationsTable76DCFC6C',
    'RealtimeSessionsTable607096EB',
  ];

  for (const logicalId of stableResourceIds) {
    expect(resources[logicalId]).toBeDefined();
  }

  const tables = template.findResources('AWS::DynamoDB::Table');

  expect(Object.keys(tables)).toHaveLength(17);

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
        AUTOMATION_INBOUND_WEBHOOK_BASE_URL: Match.anyValue(),
        AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: 'mukuroji/automation-inbound-webhooks',
        AUTOMATION_TABLE_NAME: {
          Ref: 'AutomationTableE3D67F0D',
        },
        AUTOMATION_WEBHOOK_SECRET_PREFIX: 'mukuroji/automation-webhooks',
        COGNITO_CLIENT_ID: {
          Ref: 'CognitoUserPoolClientId',
        },
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
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
        DOCUMENTS_TABLE_NAME: {
          Ref: 'DocumentsTable7E808EE5',
        },
        DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET: Match.anyValue(),
        MUKUROJI_DOCUMENTS_TABLE: {
          Ref: 'DocumentsTable7E808EE5',
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
        REQUEST_INTAKE_TABLE_NAME: Match.anyValue(),
        REQUEST_QUEUE_INDEX_NAME: 'RequestQueueIndex',
        REQUEST_RATE_LIMIT_PER_HOUR: {
          Ref: 'RequestRateLimitPerHour',
        },
        REQUEST_TOKEN_HASH_SECRET: {
          Ref: 'RequestTokenHashSecret',
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

test('inbound automation webhook lifecycle uses a distinct public base URL and secret namespace', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const lambdaResource = resources.ListProjectTasksFunction2134AF4A;
  const variables = lambdaResource.Properties.Environment.Variables;

  expect(variables.AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX)
    .toBe('mukuroji/automation-inbound-webhooks');
  expect(variables.AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX)
    .not.toBe(variables.AUTOMATION_WEBHOOK_SECRET_PREFIX);
  const serializedBaseUrl = JSON.stringify(variables.AUTOMATION_INBOUND_WEBHOOK_BASE_URL);
  expect(serializedBaseUrl).toContain('ProjectTasksHttpApi');
  expect(serializedBaseUrl).toContain('ApiEndpoint');
  expect(serializedBaseUrl).not.toContain('FunctionUrl');

  const inboundPolicy = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('ApiAutomationInboundWebhookSecretPolicy') &&
    (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
  )?.[1] as {
    Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
  } | undefined;
  const inboundStatement = inboundPolicy?.Properties?.PolicyDocument?.Statement?.[0];
  const inboundActions = Array.isArray(inboundStatement?.Action)
    ? inboundStatement.Action
    : [inboundStatement?.Action];

  expect(inboundActions).toHaveLength(5);
  expect(inboundActions).toEqual(expect.arrayContaining([
    'secretsmanager:CreateSecret',
    'secretsmanager:DeleteSecret',
    'secretsmanager:DescribeSecret',
    'secretsmanager:GetSecretValue',
    'secretsmanager:PutSecretValue',
  ]));
  expect(JSON.stringify(inboundStatement?.Resource))
    .toContain('mukuroji/automation-inbound-webhooks/');
  expect(JSON.stringify(inboundStatement?.Resource))
    .not.toContain('mukuroji/automation-webhooks/');
  expect(inboundStatement?.Resource).not.toBe('*');
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
  template.hasOutput('RequestIntakeTableName', {});
  template.hasOutput('DocumentsTableName', {
    Value: { Ref: 'DocumentsTable7E808EE5' },
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

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
      AllowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      AllowOrigins: allowedOrigins,
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    CorsConfiguration: {
      AllowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
      AllowOrigins: allowedOrigins,
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
  template.resourceCountIs('AWS::SQS::Queue', 5);
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

test('request email ingestion is an asynchronous narrow-IAM Lambda with a monitored DLQ', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const functionLogicalId = template.toJSON().Outputs.RequestEmailIngestionFunctionName?.Value?.Ref;

  expect(typeof functionLogicalId).toBe('string');
  if (typeof functionLogicalId !== 'string') {
    throw new Error('Request email ingestion function output was not found.');
  }

  const lambdaResource = resources[functionLogicalId];
  expect(lambdaResource).toEqual(expect.objectContaining({
    Type: 'AWS::Lambda::Function',
    Properties: expect.objectContaining({
      Description: 'Validates signed email envelopes and appends them to request intake threads.',
      Handler: 'index.handler',
      MemorySize: 512,
      Runtime: 'nodejs22.x',
      Timeout: 30,
      Environment: {
        Variables: {
          REQUEST_EMAIL_WEBHOOK_SECRET: { Ref: 'RequestEmailWebhookSecret' },
          REQUEST_INTAKE_TABLE_NAME: expect.anything(),
          REQUEST_TOKEN_HASH_SECRET: { Ref: 'RequestTokenHashSecret' },
        },
      },
    }),
  }));

  const roleLogicalId = lambdaResource.Properties.Role?.['Fn::GetAtt']?.[0];
  expect(typeof roleLogicalId).toBe('string');
  if (typeof roleLogicalId !== 'string') {
    throw new Error('Request email ingestion execution role was not found.');
  }

  const policies = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::IAM::Policy' &&
    ((resource as { Properties?: { Roles?: unknown[] } }).Properties?.Roles ?? []).some((role) =>
      (role as { Ref?: string }).Ref === roleLogicalId
    )
  );
  const serializedPolicies = JSON.stringify(policies);
  const requestTableLogicalId = template.toJSON().Outputs.RequestIntakeTableName?.Value?.Ref;

  expect(policies).not.toHaveLength(0);
  expect(serializedPolicies).toContain(String(requestTableLogicalId));
  expect(serializedPolicies).toContain('dynamodb:GetItem');
  expect(serializedPolicies).toContain('dynamodb:PutItem');
  expect(serializedPolicies).not.toContain('dynamodb:TransactWriteItems');
  expect(serializedPolicies).toContain('dynamodb:EnclosingOperation');
  expect(serializedPolicies).toContain('ForAnyValue:StringEquals');
  expect(serializedPolicies).toContain('sqs:SendMessage');
  for (const forbiddenResource of [
    'TeamIssuesTable189D851D',
    'AuditEventsTable0723963E',
    'ProjectDirectoryTable9ED01C01',
    'FileProofingTable81DA272F',
    'CognitoUserPoolId',
  ]) {
    expect(serializedPolicies).not.toContain(forbiddenResource);
  }
  expect(serializedPolicies).not.toContain('s3:');

  const eventInvokeConfig = Object.values(resources).find((resource) =>
    (resource as { Type?: string }).Type === 'AWS::Lambda::EventInvokeConfig' &&
    (resource as { Properties?: { FunctionName?: { Ref?: string } } }).Properties
      ?.FunctionName?.Ref === functionLogicalId
  ) as {
    Properties?: {
      DestinationConfig?: { OnFailure?: { Destination?: { 'Fn::GetAtt'?: string[] } } }
      MaximumRetryAttempts?: number
    }
  } | undefined;
  expect(eventInvokeConfig?.Properties?.MaximumRetryAttempts).toBe(2);
  const queueLogicalId = eventInvokeConfig?.Properties?.DestinationConfig?.OnFailure
    ?.Destination?.['Fn::GetAtt']?.[0];
  expect(typeof queueLogicalId).toBe('string');
  if (typeof queueLogicalId !== 'string') {
    throw new Error('Request email ingestion DLQ destination was not found.');
  }
  expect(resources[queueLogicalId]).toEqual(expect.objectContaining({
    Type: 'AWS::SQS::Queue',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    }),
  }));
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects request intake email envelopes that exhausted asynchronous retries.',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects failures while Lambda delivers request intake email failures to the DLQ.',
    MetricName: 'DestinationDeliveryFailures',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  expect(JSON.stringify(template.findResources('AWS::ApiGatewayV2::Integration')))
    .not.toContain(functionLogicalId);
  expect(JSON.stringify(template.findResources('AWS::Lambda::Url')))
    .not.toContain(functionLogicalId);
  template.hasOutput('RequestEmailIngestionDlqUrl', {});
});

test('automation workers consume the audit outbox and run recurring schedules with DLQs', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: 'Executes versioned automation rules from durable audit outbox events.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 120,
    Environment: {
      Variables: Match.objectLike({
        AUTOMATION_TABLE_NAME: { Ref: 'AutomationTableE3D67F0D' },
        AUTOMATION_WEBHOOK_SECRET_PREFIX: 'mukuroji/automation-webhooks',
        AUDIT_EVENTS_TABLE_NAME: { Ref: 'AuditEventsTable0723963E' },
        COGNITO_CLIENT_ID: { Ref: 'CognitoUserPoolClientId' },
        COGNITO_USER_POOL_ID: { Ref: 'CognitoUserPoolId' },
        FILE_PROOFING_TABLE_NAME: { Ref: 'FileProofingTable81DA272F' },
        MUKUROJI_PROJECT_DIRECTORY_TABLE: { Ref: 'ProjectDirectoryTable9ED01C01' },
        MUKUROJI_SYSTEM_ADMIN_GROUPS: { Ref: 'SystemAdminGroups' },
        PROJECT_DIRECTORY_TABLE_NAME: { Ref: 'ProjectDirectoryTable9ED01C01' },
        SYSTEM_ADMIN_GROUPS: { Ref: 'SystemAdminGroups' },
        WORK_ITEM_CONFIGURATION_TABLE_NAME: { Ref: 'WorkItemConfigurationTable35E94558' },
        WORK_ITEMS_TABLE_NAME: { Ref: 'TeamIssuesTable189D851D' },
        WORKSPACE_SEARCH_TABLE_NAME: { Ref: 'WorkspaceSearchTable2575AD6B' },
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: 'Materializes timezone-aware recurring Work Items with durable receipts.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 300,
    Environment: {
      Variables: Match.objectLike({
        AUTOMATION_TABLE_NAME: { Ref: 'AutomationTableE3D67F0D' },
        AUTOMATION_WEBHOOK_SECRET_PREFIX: 'mukuroji/automation-webhooks',
        AUDIT_EVENTS_TABLE_NAME: { Ref: 'AuditEventsTable0723963E' },
        COGNITO_CLIENT_ID: { Ref: 'CognitoUserPoolClientId' },
        COGNITO_USER_POOL_ID: { Ref: 'CognitoUserPoolId' },
        FILE_PROOFING_TABLE_NAME: { Ref: 'FileProofingTable81DA272F' },
        MUKUROJI_PROJECT_DIRECTORY_TABLE: { Ref: 'ProjectDirectoryTable9ED01C01' },
        MUKUROJI_SYSTEM_ADMIN_GROUPS: { Ref: 'SystemAdminGroups' },
        PROJECT_DIRECTORY_TABLE_NAME: { Ref: 'ProjectDirectoryTable9ED01C01' },
        SYSTEM_ADMIN_GROUPS: { Ref: 'SystemAdminGroups' },
        WORK_ITEM_CONFIGURATION_TABLE_NAME: { Ref: 'WorkItemConfigurationTable35E94558' },
        WORK_ITEMS_TABLE_NAME: { Ref: 'TeamIssuesTable189D851D' },
        WORKSPACE_SEARCH_TABLE_NAME: { Ref: 'WorkspaceSearchTable2575AD6B' },
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 10,
    BisectBatchOnFunctionError: true,
    EventSourceArn: {
      'Fn::GetAtt': ['AuditEventsTable0723963E', 'StreamArn'],
    },
    FunctionName: {
      Ref: 'AutomationEventFunction5E8CB543',
    },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumRetryAttempts: 3,
    StartingPosition: 'TRIM_HORIZON',
    DestinationConfig: {
      OnFailure: { Destination: Match.anyValue() },
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Checks timezone-aware recurring Work definitions every minute.',
    ScheduleExpression: 'rate(1 minute)',
    State: 'ENABLED',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects automation outbox records that exhausted stream retries.',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    Threshold: 1,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects recurring Work materialization failures after asynchronous retries.',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    Threshold: 1,
  });
  template.hasOutput('AutomationEventDlqUrl', {});
  template.hasOutput('AutomationScheduleDlqUrl', {});

  const resources = template.toJSON().Resources;
  const eventPolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('AutomationEventFunctionServiceRoleDefaultPolicy')
  )?.[1];
  const schedulePolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('AutomationScheduleFunctionServiceRoleDefaultPolicy')
  )?.[1];
  const eventTransactPolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('AutomationEventTransactWritePolicy')
  )?.[1];
  const scheduleTransactPolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('AutomationScheduleTransactWritePolicy')
  )?.[1];
  for (const [policy, transactPolicy] of [
    [eventPolicy, eventTransactPolicy],
    [schedulePolicy, scheduleTransactPolicy],
  ]) {
    const serialized = JSON.stringify(policy);
    expect(serialized).toContain('AutomationTableE3D67F0D');
    expect(serialized).toContain('AuditEventsTable0723963E');
    expect(serialized).toContain('FileProofingTable81DA272F');
    expect(serialized).toContain('ProjectDirectoryTable9ED01C01');
    expect(serialized).toContain('TeamIssuesTable189D851D');
    expect(serialized).toContain('WorkspaceSearchTable2575AD6B');
    const statements = (policy as {
      Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
    } | undefined)?.Properties?.PolicyDocument?.Statement ?? [];
    const transactStatements = (transactPolicy as {
      Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
    } | undefined)?.Properties?.PolicyDocument?.Statement ?? [];
    const transactStatement = transactStatements.find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('dynamodb:TransactWriteItems');
    });
    expect(transactStatement).toEqual(expect.objectContaining({
      Effect: 'Allow',
      Resource: expect.arrayContaining([
        { 'Fn::GetAtt': ['AutomationTableE3D67F0D', 'Arn'] },
        { 'Fn::GetAtt': ['FileProofingTable81DA272F', 'Arn'] },
      ]),
    }));
    const cognitoStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('cognito-idp:AdminGetUser');
    });
    expect(cognitoStatement).toEqual(expect.objectContaining({ Effect: 'Allow' }));
    expect(cognitoStatement?.Action).toEqual(expect.arrayContaining([
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
    ]));
    expect(JSON.stringify(cognitoStatement?.Resource)).toContain('CognitoUserPoolId');
    const workspaceSearchStatement = statements.find((statement) =>
      JSON.stringify(statement.Resource).includes('WorkspaceSearchTable2575AD6B')
    );
    expect(workspaceSearchStatement).toEqual(expect.objectContaining({
      Effect: 'Allow',
      Action: expect.arrayContaining([
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
      ]),
    }));
    const projectDirectoryStatement = statements.find((statement) =>
      JSON.stringify(statement.Resource).includes('ProjectDirectoryTable9ED01C01')
    );
    expect(projectDirectoryStatement).toEqual(expect.objectContaining({
      Effect: 'Allow',
      Action: expect.arrayContaining([
        'dynamodb:GetItem',
        'dynamodb:Query',
      ]),
    }));
  }
  for (const policyPrefix of [
    'AutomationEventWebhookSecretPolicy',
    'AutomationScheduleWebhookSecretPolicy',
  ]) {
    const webhookSecretPolicy = Object.entries(resources).find(([logicalId, resource]) =>
      logicalId.startsWith(policyPrefix) &&
      (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
    )?.[1];
    const serialized = JSON.stringify(webhookSecretPolicy);
    expect(serialized).toContain('secretsmanager:GetSecretValue');
    expect(serialized).toContain(':secret:');
    expect(serialized).toContain('mukuroji/automation-webhooks/');
  }
  const scheduleFunction = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('AutomationScheduleFunction') &&
    (resource as { Type?: string }).Type === 'AWS::Lambda::Function'
  )?.[1] as {
    Properties?: { Environment?: { Variables?: Record<string, unknown> } };
  } | undefined;
  expect(scheduleFunction?.Properties?.Environment?.Variables)
    .toMatchObject({
      AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: 'mukuroji/automation-inbound-webhooks',
    });
  const inboundCleanupPolicy = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('AutomationScheduleInboundWebhookSecretCleanupPolicy') &&
    (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
  )?.[1] as {
    Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
  } | undefined;
  const inboundCleanupStatement = inboundCleanupPolicy?.Properties?.PolicyDocument?.Statement?.[0];
  expect(inboundCleanupStatement?.Action).toBe('secretsmanager:DeleteSecret');
  expect(JSON.stringify(inboundCleanupStatement?.Resource))
    .toContain('mukuroji/automation-inbound-webhooks/');
  expect(JSON.stringify(inboundCleanupStatement?.Resource))
    .not.toContain('mukuroji/automation-webhooks/');
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
  const fileObjectStatement = statements.find((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes('s3:PutObject');
  });
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
  const automationDataStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource).includes('AutomationTableE3D67F0D') &&
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:Query')
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
  const requestTableLogicalId = template.toJSON().Outputs.RequestIntakeTableName?.Value?.Ref;
  expect(typeof requestTableLogicalId).toBe('string');
  const requestIntakeStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(String(requestTableLogicalId))
  );
  const cognitoPolicy = Object.values(template.toJSON().Resources).find((resource) =>
    JSON.stringify(resource).includes('cognito-idp:AdminGetUser')
  );

  expect(transactStatement).toEqual(expect.objectContaining({
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': ['AutomationTableE3D67F0D', 'Arn'] },
      { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'] },
      { 'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'] },
      { 'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'] },
      { 'Fn::GetAtt': ['DocumentsTable7E808EE5', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemCollaborationTableFDECF217', 'Arn'] },
      { 'Fn::GetAtt': ['FileProofingTable81DA272F', 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceSearchTable2575AD6B', 'Arn'] },
    ]),
  }));
  expect(serializedApiPolicies).toContain('DocumentsTable7E808EE5');
  expect(serializedApiPolicies).toContain('WorkspaceSearchTable2575AD6B');
  expect(serializedApiPolicies).toContain('secretsmanager:GetSecretValue');
  expect(serializedApiPolicies).toContain(':secret:');
  expect(serializedApiPolicies).toContain('mukuroji/automation-webhooks/');
  expect(JSON.stringify(transactStatement)).not.toContain('ProjectTasksTableE21F6637');
  expect(JSON.stringify(transactStatement)).toContain('FileProofingTable');
  expect(fileObjectStatement).toEqual(expect.objectContaining({ Effect: 'Allow' }));
  const fileObjectActions = Array.isArray(fileObjectStatement?.Action)
    ? fileObjectStatement.Action
    : [fileObjectStatement?.Action];
  expect(fileObjectActions).toEqual(expect.arrayContaining([
    's3:DeleteObject',
    's3:GetObject',
    's3:GetObjectAttributes',
    's3:GetObjectVersion',
    's3:GetObjectVersionTagging',
    's3:PutObject',
    's3:PutObjectVersionTagging',
  ]));
  expect(JSON.stringify(fileObjectStatement)).toContain('workspaces/*');
  expect(JSON.stringify(fileObjectStatement)).not.toContain('s3:ListBucket');
  expect(JSON.stringify(fileObjectStatement)).not.toContain('s3:DeleteObjectVersion');
  expect(JSON.stringify(fileObjectStatement)).not.toContain('s3:DeleteObjectTagging');
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
  expect(automationDataStatement).toEqual(expect.objectContaining({
    Action: expect.arrayContaining([
      'dynamodb:ConditionCheckItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ]),
    Effect: 'Allow',
  }));
  expect(configurationStatements).toHaveLength(2);
  expect(configurationStatements).toEqual(expect.arrayContaining([
    configurationDataStatement,
    transactStatement,
  ]));

  const requestIntakeActions = requestIntakeStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  expect(requestIntakeActions).toEqual(expect.arrayContaining([
    'dynamodb:DescribeTable',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
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
  for (const forbiddenAction of [
    'dynamodb:BatchGetItem',
    'dynamodb:BatchWriteItem',
    'dynamodb:DeleteItem',
    'dynamodb:Scan',
    'dynamodb:TransactWriteItems',
  ]) {
    expect(requestIntakeActions).not.toContain(forbiddenAction);
  }

  const documentsStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('DocumentsTable7E808EE5')
  );
  const documentsActions = documentsStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );

  expect(documentsActions).toEqual(expect.arrayContaining([
    'dynamodb:DeleteItem',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:TransactWriteItems',
    'dynamodb:UpdateItem',
  ]));

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
