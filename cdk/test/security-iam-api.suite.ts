/** Registers security, IAM, and public API tests. */
import { Match } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import {
  API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  findApiRuntimeConfigurationSource,
  findCustomResource,
  serializeAwsSdkCall,
  synthesizedTemplate,
} from './test-support';

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
    Timeout: 20,
    Environment: {
      Variables: Match.objectLike({
        MUKUROJI_API_CORE_CONFIG_SECRET_ARN: {
          Ref: API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
        },
        MUKUROJI_API_DATA_CONFIG_SECRET_ARN: {
          Ref: API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
        },
        MUKUROJI_API_IDENTITY_CONFIG_SECRET_ARN: {
          Ref: 'ApiIdentityRuntimeConfigurationSecret9BDC16DA',
        },
        MUKUROJI_API_WORKFLOW_CONFIG_SECRET_ARN: {
          Ref: 'ApiWorkflowRuntimeConfigurationSecret225372D1',
        },
      }),
    },
    FunctionName: 'Test-api-v2',
  });

  const lambdaResource = template.toJSON().Resources.ListProjectTasksFunction2134AF4A;
  const variables = lambdaResource.Properties.Environment.Variables;

  expect(lambdaResource.Properties.Code.ZipFile).toBeUndefined();
  expect(Object.keys(variables).sort()).toEqual([
    'AI_ASSISTANCE_ALLOWED_MODEL_IDS',
    'AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD',
    'AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD',
    'AI_ASSISTANCE_BEDROCK_REGION',
    'AI_ASSISTANCE_DEFAULT_MODEL_ID',
    'AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE',
    'AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE',
    'AI_ASSISTANCE_TABLE_NAME',
    'AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE',
    'AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE',
    'AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION',
    'MUKUROJI_API_CORE_CONFIG_SECRET_ARN',
    'MUKUROJI_API_DATA_CONFIG_SECRET_ARN',
    'MUKUROJI_API_IDENTITY_CONFIG_SECRET_ARN',
    'MUKUROJI_API_WORKFLOW_CONFIG_SECRET_ARN',
    'TENANT_EXPORT_BUCKET_NAME',
  ]);
  expect(variables)
    .not.toHaveProperty('MUKUROJI_WORK_ITEM_CONFIGURATION_TABLE');
  expect(variables).not.toHaveProperty('TASKS_TABLE_NAME');
  for (const removedAlias of [
    'MUKUROJI_DOCUMENTS_TABLE',
    'MUKUROJI_PROJECT_DIRECTORY_ID',
    'MUKUROJI_PROJECT_DIRECTORY_TABLE',
    'WORK_ITEMS_TABLE_NAME',
    'SYSTEM_ADMIN_GROUPS',
    'TEAM_ISSUE_EVENTS_TABLE_NAME',
  ]) {
    expect(variables).not.toHaveProperty(removedAlias);
  }
});

test('public API delivery queues are retained with TLS-only access and worker-safe visibility', () => {
  const template = synthesizedTemplate;
  const queues = template.findResources('AWS::SQS::Queue');
  const queuePolicies = template.findResources('AWS::SQS::QueuePolicy');
  const queueExpectations = [
    { prefix: 'WebhookDeliveryDlq' },
    { prefix: 'WebhookDeliveryQueue', visibilityTimeout: 180 },
    { prefix: 'WorkItemImportDlq' },
    { prefix: 'WorkItemImportQueue', visibilityTimeout: 90 * 60 },
    { prefix: 'ConnectorSyncDlq' },
    { prefix: 'ConnectorPollDlq' },
    { prefix: 'ConnectorSyncQueue', visibilityTimeout: 30 * 60 },
  ];

  for (const expectation of queueExpectations) {
    const queueEntry = Object.entries(queues).find(([logicalId]) =>
      logicalId.startsWith(expectation.prefix)
    );
    expect(queueEntry).toBeDefined();
    if (!queueEntry) {
      throw new Error(`${expectation.prefix} was not synthesized.`);
    }
    const [queueId, queue] = queueEntry;

    expect(queue).toEqual(expect.objectContaining({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
        SqsManagedSseEnabled: true,
      }),
    }));
    if (expectation.visibilityTimeout !== undefined) {
      expect(queue.Properties.VisibilityTimeout)
        .toBe(expectation.visibilityTimeout);
    }

    const queuePolicy = Object.values(queuePolicies).find((resource) =>
      JSON.stringify(resource.Properties?.Queues).includes(queueId)
    );
    expect(queuePolicy).toEqual(expect.objectContaining({
      Properties: expect.objectContaining({
        PolicyDocument: expect.objectContaining({
          Statement: expect.arrayContaining([
            expect.objectContaining({
              Action: 'sqs:*',
              Condition: {
                Bool: {
                  'aws:SecureTransport': 'false',
                },
              },
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Resource: { 'Fn::GetAtt': [queueId, 'Arn'] },
            }),
          ]),
        }),
        Queues: expect.arrayContaining([{ Ref: queueId }]),
      }),
    }));
  }
});

test('inbound automation webhook lifecycle uses a distinct public base URL and secret namespace', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const coreConfiguration =
    resources[API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID]
      .Properties.SecretString;
  const dataConfiguration =
    resources[API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID]
      .Properties.SecretString;

  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'AUTOMATION_INBOUND_WEBHOOK_BASE_URL',
  )).toEqual({
    'Fn::Base64': {
      'Fn::GetAtt': ['ProjectTasksHttpApi4BD7BB44', 'ApiEndpoint'],
    },
  });
  const inboundSecretPrefix = findApiRuntimeConfigurationSource(
    dataConfiguration,
    'AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX',
  );
  const outboundSecretPrefix = findApiRuntimeConfigurationSource(
    dataConfiguration,
    'AUTOMATION_WEBHOOK_SECRET_PREFIX',
  );
  expect(inboundSecretPrefix).toEqual({
    'Fn::Base64': 'mukuroji/automation-inbound-webhooks',
  });
  expect(outboundSecretPrefix).toEqual({
    'Fn::Base64': 'mukuroji/automation-webhooks',
  });
  expect(inboundSecretPrefix).not.toEqual(outboundSecretPrefix);

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

test('Function URL and API Gateway invoke the same live Lambda alias', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const functionLogicalId = 'ListProjectTasksFunction2134AF4A';
  const versionLogicalId = Object.keys(
    template.findResources('AWS::Lambda::Version'),
  ).find((logicalId) =>
    logicalId.startsWith('ListProjectTasksFunctionCurrentVersion')
  );
  expect(versionLogicalId).toBeDefined();
  if (!versionLogicalId) {
    throw new Error('The API Lambda version was not synthesized.');
  }
  const aliasLogicalId = 'ApiLiveAlias3A796568';

  expect(resources[versionLogicalId].Properties).toEqual({
    Description: {
      'Fn::Join': [
        ' ',
        [
          'API runtime configuration revision',
          { Ref: 'ApiRuntimeConfigurationRevision' },
        ],
      ],
    },
    FunctionName: { Ref: functionLogicalId },
  });
  expect(resources[aliasLogicalId].Properties).toEqual({
    FunctionName: { Ref: functionLogicalId },
    FunctionVersion: {
      'Fn::GetAtt': [versionLogicalId, 'Version'],
    },
    Name: 'live',
  });

  template.hasResourceProperties('AWS::Lambda::Url', {
    AuthType: 'NONE',
    Qualifier: 'live',
    TargetFunctionArn: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
  });
  const functionUrl = Object.values(
    template.findResources('AWS::Lambda::Url'),
  )[0];
  expect(functionUrl.DependsOn).toEqual([aliasLogicalId]);
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: { Ref: aliasLogicalId },
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
    FunctionName: { Ref: aliasLogicalId },
    Principal: 'apigateway.amazonaws.com',
    SourceArn: Match.anyValue(),
  });
  template.hasOutput('ApiFunctionUrl', {});
  template.hasOutput('ApiGatewayUrl', {});
  template.hasOutput('WorkspaceDirectoryId', {
    Value: {
      Ref: 'WorkspaceDirectoryId',
    },
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
  template.hasOutput('FocusTableName', {});
  template.hasOutput('RequestIntakeTableName', {});
  template.hasOutput('DocumentsTableName', {
    Value: { Ref: 'DocumentsTable7E808EE5' },
  });
});

test('developer platform and connector runtime secrets use rotated purpose-specific KMS keys', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;

  template.resourceCountIs('AWS::KMS::Key', 6);
  for (const description of [
    'Envelope key for developer platform Webhook signing secrets.',
    'Envelope key for developer platform connector credentials.',
    'Envelope key for developer platform cursors and idempotency state.',
    'Encryption key for connector provider runtime configuration.',
    'Encrypts isolated restore-drill exports and exact-version file copies.',
    'Encrypts immutable secret-free restore-drill evidence.',
  ]) {
    template.hasResourceProperties('AWS::KMS::Key', {
      Description: description,
      EnableKeyRotation: true,
    });
  }
  const protectedKmsKeys = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::KMS::Key'
  ) as Array<{ DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
  expect(protectedKmsKeys).toHaveLength(6);
  expect(protectedKmsKeys.every((resource) =>
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
    'x-correlation-id',
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

test('GuardDuty scanning and bucket policy quarantine files until a clean result', () => {
  const template = synthesizedTemplate;
  const bucketPolicy = Object.values(
    template.findResources('AWS::S3::BucketPolicy'),
  ).find((resource) =>
    JSON.stringify(resource).includes('ListProjectTasksFunctionServiceRole')
  );
  const serializedBucketPolicy = JSON.stringify(bucketPolicy);

  expect(bucketPolicy).toBeDefined();
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
        ENTERPRISE_IDENTITY_TABLE_NAME: Match.anyValue(),
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
  const enterpriseIdentityTableLogicalId =
    template.toJSON().Outputs.EnterpriseIdentityTableName.Value.Ref;
  const enterpriseIdentityStatements =
    realtimePolicy.Properties.PolicyDocument.Statement.filter((statement: {
      Resource?: unknown
    }) => JSON.stringify(statement.Resource).includes(enterpriseIdentityTableLogicalId));
  const realtimeSessionStatements =
    realtimePolicy.Properties.PolicyDocument.Statement.filter((statement: {
      Resource?: unknown
    }) => JSON.stringify(statement.Resource).includes('RealtimeSessionsTable607096EB'));
  const realtimeSessionActions = realtimeSessionStatements.flatMap((statement: {
    Action?: unknown
  }) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);

  expect(serializedRealtimePolicy).toContain(enterpriseIdentityTableLogicalId);
  expect(enterpriseIdentityStatements).toEqual([
    expect.objectContaining({
      Action: ['dynamodb:GetItem', 'dynamodb:Query'],
      Effect: 'Allow',
    }),
  ]);
  expect(serializedRealtimePolicy).toContain('ProjectDirectoryTable9ED01C01');
  expect(serializedRealtimePolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedRealtimePolicy).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(serializedRealtimePolicy).toContain('cognito-idp:AdminListGroupsForUser');
  expect(serializedRealtimePolicy).toContain('cognito-idp:DescribeIdentityProvider');
  expect(serializedRealtimePolicy).toContain('CognitoUserPoolId');
  expect(realtimeSessionActions).toEqual(expect.arrayContaining([
    'dynamodb:DeleteItem',
    'dynamodb:PutItem',
  ]));
  expect(serializedRealtimePolicy).not.toContain('dynamodb:TransactWriteItems');
  const realtimeFunctions = template.findResources('AWS::Lambda::Function', {
    Description: 'Consumes one-time tickets and handles mukuroji WebSocket presence events.',
    Environment: {
      Variables: Match.objectLike({
        COGNITO_ENTERPRISE_IDP_NAME: { Ref: 'CognitoEnterpriseIdpName' },
      }),
    },
  });
  expect(JSON.stringify(realtimeFunctions))
    .not.toContain('ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET');
  expect(serializedRealtimePolicy).toContain('production/*/@connections/*');
  expect(serializedRealtimePolicy).not.toContain('/*/*/@connections/*');
});

test('API IAM is limited to the data tables and configured Cognito user pool', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const developerPlatformTableId =
    template.toJSON().Outputs.DeveloperPlatformTableName?.Value?.Ref;
  const developerPlatformKeyExpectations = [
    { prefix: 'DeveloperPlatformWebhookKey', purpose: 'webhook' },
    { prefix: 'DeveloperPlatformConnectorKey', purpose: 'connector' },
    { prefix: 'DeveloperPlatformStateKey', purpose: 'platform-state' },
  ].map(({ prefix, purpose }) => ({
    keyId: Object.entries(resources).find(([logicalId, resource]) =>
      logicalId.startsWith(prefix) &&
      (resource as { Type?: string }).Type === 'AWS::KMS::Key'
    )?.[0],
    purpose,
  }));
  expect(typeof developerPlatformTableId).toBe('string');
  expect(developerPlatformKeyExpectations.every(({ keyId }) => keyId !== undefined))
    .toBe(true);
  if (
    typeof developerPlatformTableId !== 'string' ||
    developerPlatformKeyExpectations.some(({ keyId }) => !keyId)
  ) {
    throw new Error('Developer platform IAM resources were not synthesized.');
  }
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
      if (
        !['AWS::IAM::ManagedPolicy', 'AWS::IAM::Policy'].includes(
          (resource as { Type?: string }).Type ?? '',
        )
      ) {
        return false;
      }
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
  const transactionConditionCheckStatement = statements.find((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes('dynamodb:ConditionCheckItem') &&
      JSON.stringify(statement.Condition)?.includes('dynamodb:EnclosingOperation') === true &&
      JSON.stringify(statement.Resource).includes('WorkspaceSearchTable2575AD6B');
  });
  const auditTransactionStatements = statements.filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return (actions.includes('dynamodb:PutItem') || actions.includes('dynamodb:ConditionCheckItem')) &&
      JSON.stringify(statement.Resource).includes('AuditEventsTable') &&
      JSON.stringify(statement.Condition)?.includes('dynamodb:EnclosingOperation') === true;
  });
  const configurationDataStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource) === JSON.stringify({
      'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'],
    }) &&
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:DescribeTable')
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
    statement.Action.includes('dynamodb:DescribeTable')
  );
  const planningStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('PlanningTable2A0D4CC5')
  );
  const developerPlatformStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(developerPlatformTableId)
  );
  const developerPlatformDataStatement = developerPlatformStatements.find((statement) =>
    JSON.stringify(statement.Resource) === JSON.stringify({
      'Fn::GetAtt': [developerPlatformTableId, 'Arn'],
    }) &&
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:ConditionCheckItem')
  );
  const developerPlatformIndexStatement = developerPlatformStatements.find((statement) =>
    statement.Action === 'dynamodb:Query' &&
    JSON.stringify(statement.Resource).includes('/index/LookupKeyIndex')
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
  const requestTableLogicalId = template.toJSON().Outputs.RequestIntakeTableName?.Value?.Ref;
  expect(typeof requestTableLogicalId).toBe('string');
  const requestIntakeStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(String(requestTableLogicalId))
  );
  const enterpriseIdentityTableLogicalId =
    template.toJSON().Outputs.EnterpriseIdentityTableName?.Value?.Ref;
  expect(typeof enterpriseIdentityTableLogicalId).toBe('string');
  const enterpriseIdentityStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(String(enterpriseIdentityTableLogicalId))
  );
  const realtimeSessionStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('RealtimeSessionsTable607096EB')
  );
  const focusTableLogicalId =
    template.toJSON().Outputs.FocusTableName?.Value?.Ref;
  expect(typeof focusTableLogicalId).toBe('string');
  if (typeof focusTableLogicalId !== 'string') {
    throw new Error('Focus table output was not synthesized.');
  }
  const focusStatements = statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(focusTableLogicalId)
  );
  const focusDataStatement = focusStatements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:GetItem') &&
    statement.Action.includes('dynamodb:PutItem')
  );
  const cognitoStatement = statements.find((statement) =>
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action])
      .includes('cognito-idp:AdminGetUser')
  );

  expect(transactionConditionCheckStatement).toEqual(expect.objectContaining({
    Action: 'dynamodb:ConditionCheckItem',
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      { 'Fn::GetAtt': [requestTableLogicalId, 'Arn'] },
      { 'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceAccessTableD7C8D2C7', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemCollaborationTableFDECF217', 'Arn'] },
      { 'Fn::GetAtt': ['DocumentsTable7E808EE5', 'Arn'] },
      { 'Fn::GetAtt': ['FileProofingTable81DA272F', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'] },
      { 'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'] },
      { 'Fn::GetAtt': [enterpriseIdentityTableLogicalId, 'Arn'] },
      { 'Fn::GetAtt': [focusTableLogicalId, 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceSearchTable2575AD6B', 'Arn'] },
    ]),
  }));
  expect(JSON.stringify(transactionConditionCheckStatement))
    .not.toContain('AutomationTableE3D67F0D');
  expect(JSON.stringify(transactionConditionCheckStatement)).not.toContain(
    developerPlatformTableId,
  );
  expect(JSON.stringify(transactionConditionCheckStatement)).not.toContain(
    'ProjectTasksTableE21F6637',
  );
  expect(serializedApiPolicies).not.toContain('ProjectTasksTableE21F6637');
  expect(serializedApiPolicies).toContain('DocumentsTable7E808EE5');
  expect(serializedApiPolicies).toContain('WorkspaceSearchTable2575AD6B');
  expect(serializedApiPolicies).toContain('kms:Decrypt');
  expect(serializedApiPolicies).toContain('kms:GenerateDataKey');
  expect(serializedApiPolicies).toContain('DeveloperPlatformWebhookKey');
  expect(serializedApiPolicies).toContain('DeveloperPlatformConnectorKey');
  expect(serializedApiPolicies).toContain('DeveloperPlatformStateKey');
  expect(serializedApiPolicies).toContain('secretsmanager:GetSecretValue');
  expect(serializedApiPolicies).toContain(':secret:');
  expect(serializedApiPolicies).toContain('mukuroji/automation-webhooks/');
  expect(JSON.stringify(transactionConditionCheckStatement)).toContain('FileProofingTable');
  expect(serializedApiPolicies).not.toContain('dynamodb:TransactWriteItems');
  expect(auditTransactionStatements).toEqual(expect.arrayContaining([
    expect.objectContaining({
      Action: expect.arrayContaining(['dynamodb:PutItem']),
      Resource: { 'Fn::GetAtt': ['AuditEventsTable0723963E', 'Arn'] },
    }),
    expect.objectContaining({
      Action: expect.arrayContaining(['dynamodb:ConditionCheckItem']),
      Resource: { 'Fn::GetAtt': ['AuditEventsTable0723963E', 'Arn'] },
    }),
  ]));
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
    'dynamodb:BatchGetItem',
    'dynamodb:DeleteItem',
    'dynamodb:DescribeTable',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:Scan',
    'dynamodb:ConditionCheckItem',
    'dynamodb:UpdateItem',
  ]));
  expect(configurationDataStatement).toEqual({
    Action: [
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
  expect(configurationStatements).toContain(configurationDataStatement);
  expect(configurationStatements).toContain(transactionConditionCheckStatement);

  const requestIntakeActions = requestIntakeStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  expect(requestIntakeActions).toEqual(expect.arrayContaining([
    'dynamodb:ConditionCheckItem',
    'dynamodb:DescribeTable',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
  ]));
  expect(requestIntakeStatements).toHaveLength(2);
  expect(requestIntakeStatements).toContain(transactionConditionCheckStatement);
  const enterpriseIdentityActions = enterpriseIdentityStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  expect(enterpriseIdentityActions).toEqual(expect.arrayContaining([
    'dynamodb:BatchWriteItem',
    'dynamodb:ConditionCheckItem',
    'dynamodb:DescribeTable',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
  ]));
  expect(enterpriseIdentityActions).not.toContain('dynamodb:Scan');
  expect(JSON.stringify(enterpriseIdentityStatements))
    .toContain(String(enterpriseIdentityTableLogicalId));
  const realtimeSessionActions = realtimeSessionStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  expect(realtimeSessionActions).toEqual(expect.arrayContaining([
    'dynamodb:GetItem',
    'dynamodb:PutItem',
  ]));
  expect(focusDataStatement).toEqual({
    Action: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ],
    Effect: 'Allow',
    Resource: { 'Fn::GetAtt': [focusTableLogicalId, 'Arn'] },
  });
  expect(focusStatements).toHaveLength(2);
  expect(planningDataStatement).toEqual(expect.objectContaining({
    Action: [
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
  expect(planningStatements).toContain(planningDataStatement);
  expect(planningStatements).toContain(transactionConditionCheckStatement);
  expect(developerPlatformDataStatement).toEqual({
    Action: [
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    Effect: 'Allow',
    Resource: { 'Fn::GetAtt': [developerPlatformTableId, 'Arn'] },
  });
  expect(developerPlatformIndexStatement).toEqual({
    Action: 'dynamodb:Query',
    Effect: 'Allow',
    Resource: {
      'Fn::Join': [
        '',
        [
          { 'Fn::GetAtt': [developerPlatformTableId, 'Arn'] },
          '/index/LookupKeyIndex',
        ],
      ],
    },
  });
  expect(developerPlatformStatements).toHaveLength(2);
  expect(JSON.stringify(developerPlatformStatements)).not.toContain('/index/*');
  const kmsStatements = statements.filter((statement) => {
    const actions = Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action];
    return actions.some((action) =>
      typeof action === 'string' && action.startsWith('kms:')
    );
  });
  for (const { keyId, purpose } of developerPlatformKeyExpectations) {
    expect(kmsStatements).toContainEqual({
      Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
      Condition: {
        StringEquals: {
          'kms:EncryptionContext:mukuroji:purpose': purpose,
          'kms:EncryptionContext:mukuroji:service': 'developer-platform',
        },
      },
      Effect: 'Allow',
      Resource: {
        'Fn::GetAtt': [keyId, 'Arn'],
      },
    });
  }
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
    'dynamodb:ConditionCheckItem',
    'dynamodb:UpdateItem',
  ]));

  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:ListUsers');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:DescribeIdentityProvider');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:DescribeUserPoolClient');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminDeleteUserAttributes');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminDisableUser');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminEnableUser');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminUserGlobalSignOut');
  expect(JSON.stringify(cognitoStatement)).toContain('CognitoUserPoolId');
  const wildcardStatements = statements.filter((statement) => statement.Resource === '*');
  expect(wildcardStatements).toEqual([{
    Action: ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'],
    Effect: 'Allow',
    Resource: '*',
  }]);
  const readinessStatement = statements.find((statement) => {
    const actions = Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action];
    return actions.length === 1 &&
      actions.includes('dynamodb:DescribeTable') &&
      JSON.stringify(statement.Resource).includes('AuditEventsTable0723963E') &&
      JSON.stringify(statement.Resource).includes('TeamIssuesTable189D851D') &&
      JSON.stringify(statement.Resource).includes('WorkspaceAccessTableD7C8D2C7');
  });
  expect(readinessStatement).toEqual({
    Action: 'dynamodb:DescribeTable',
    Effect: 'Allow',
    Resource: [
      { 'Fn::GetAtt': ['AuditEventsTable0723963E', 'Arn'] },
      { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceAccessTableD7C8D2C7', 'Arn'] },
    ],
  });
  expect(serializedApiPolicies).not.toContain('"Action":"s3:*"');
  expect(JSON.stringify(cognitoStatement)).not.toContain('"Resource":"*"');
});

test('API runtime emits traces and alarms for errors throttles latency and gateway failures', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Description:
      'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
    TracingConfig: { Mode: 'Active' },
  });
  for (const alarm of [
    {
      description:
        'Detects unhandled or infrastructure errors returned by the shared API Lambda.',
      metricName: 'Errors',
      threshold: 1,
    },
    {
      description:
        'Detects shared API Lambda requests rejected by concurrency throttling.',
      metricName: 'Throttles',
      threshold: 1,
    },
    {
      description:
        'Detects sustained p95 shared API Lambda latency above the operational budget.',
      metricName: 'Duration',
      threshold: 12000,
    },
    {
      description:
        'Detects HTTP API responses that fail before or within the shared API integration.',
      metricName: '5xx',
      threshold: 1,
    },
  ]) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmDescription: alarm.description,
      MetricName: alarm.metricName,
      Threshold: alarm.threshold,
      TreatMissingData: 'notBreaching',
    });
  }
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects sustained p95 shared API Lambda latency above the operational budget.',
    ExtendedStatistic: 'p95',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects API requests that the application completed with a server-error response.',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    DatapointsToAlarm: 1,
    Dimensions: [{
      Name: 'Service',
      Value: 'mukuroji-api',
    }],
    EvaluationPeriods: 1,
    MetricName: 'ServerErrorCount',
    Namespace: 'Mukuroji/API',
    Period: 300,
    Statistic: 'Sum',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  for (const burnWindow of [
    {
      description:
        'Detects a 14.4x API availability error-budget burn over five minutes.',
      period: 300,
    },
    {
      description:
        'Detects a 14.4x API availability error-budget burn over one hour.',
      period: 3600,
    },
  ]) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ActionsEnabled: false,
      AlarmDescription: burnWindow.description,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      DatapointsToAlarm: 1,
      EvaluationPeriods: 1,
      Metrics: Match.arrayWith([
        Match.objectLike({
          Expression:
            'eligibleErrors / eligibleRequests',
          ReturnData: true,
        }),
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: {
              Dimensions: [{
                Name: 'Service',
                Value: 'mukuroji-api',
              }],
              MetricName: 'EligibleServerErrorCount',
              Namespace: 'Mukuroji/API',
            },
            Period: burnWindow.period,
            Stat: 'Sum',
          }),
          ReturnData: false,
        }),
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: {
              Dimensions: [{
                Name: 'Service',
                Value: 'mukuroji-api',
              }],
              MetricName: 'EligibleRequestCount',
              Namespace: 'Mukuroji/API',
            },
            Period: burnWindow.period,
            Stat: 'Sum',
          }),
          ReturnData: false,
        }),
      ]),
      Threshold: 0.0144,
      TreatMissingData: 'missing',
    });
  }
  template.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
    AlarmDescription:
      'Pages when both API availability fast-burn windows exceed 14.4x.',
    AlarmRule: Match.anyValue(),
  });
  const serializedCompositeAlarms = JSON.stringify(
    template.findResources('AWS::CloudWatch::CompositeAlarm'),
  );
  expect(serializedCompositeAlarms).toContain(
    'ApiAvailabilityFastBurnFiveMinuteAlarm',
  );
  expect(serializedCompositeAlarms).toContain(
    'ApiAvailabilityFastBurnOneHourAlarm',
  );
  expect(serializedCompositeAlarms).toContain(' AND ALARM');
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
