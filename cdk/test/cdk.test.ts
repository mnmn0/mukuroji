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

  for (const parameterName of [
    'CognitoUserPoolId',
    'CognitoUserPoolClientId',
    'WorkspaceDirectoryId',
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
    'TeamIssueEventsTableDD2B0F96',
    'ProjectDirectoryTable9ED01C01',
    'ListProjectTasksFunction2134AF4A',
    'WorkItemCollaborationTableFDECF217',
    'NotificationsTable76DCFC6C',
    'RealtimeSessionsTable607096EB',
  ];

  for (const logicalId of stableResourceIds) {
    expect(resources[logicalId]).toBeDefined();
  }

  const tables = template.findResources('AWS::DynamoDB::Table');

  expect(Object.keys(tables)).toHaveLength(10);

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
        MUKUROJI_PROJECT_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
        },
        MUKUROJI_WORKSPACE_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
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
        COLLABORATION_TABLE_NAME: {
          Ref: 'WorkItemCollaborationTableFDECF217',
        },
        NOTIFICATIONS_TABLE_NAME: {
          Ref: 'NotificationsTable76DCFC6C',
        },
        NOTIFICATIONS_STATUS_INDEX_NAME: 'RecipientStatusIndex',
        REALTIME_SESSIONS_TABLE_NAME: {
          Ref: 'RealtimeSessionsTable607096EB',
        },
        REALTIME_WEBSOCKET_URL: Match.anyValue(),
      }),
    },
  });

  const lambdaResource = template.toJSON().Resources.ListProjectTasksFunction2134AF4A;

  expect(lambdaResource.Properties.Code.ZipFile).toBeUndefined();
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

  expect(serializedProjectionPolicy).toContain('production/*/@connections/*');
  expect(serializedProjectionPolicy).toContain('WorkItemCollaborationTableFDECF217');
  expect(serializedProjectionPolicy).toContain('cognito-idp:AdminListGroupsForUser');
  expect(serializedProjectionPolicy).toContain('CognitoUserPoolId');
  expect(serializedProjectionPolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedProjectionPolicy).not.toContain('/*/*/@connections/*');
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
  template.resourceCountIs('AWS::SQS::Queue', 2);
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
  const policy = template.toJSON().Resources.ListProjectTasksFunctionServiceRoleDefaultPolicy5F0F81CE;
  const statements = policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>;
  const transactStatement = statements.find((statement) =>
    statement.Action === 'dynamodb:TransactWriteItems'
  );
  const cognitoPolicy = Object.values(template.toJSON().Resources).find((resource) =>
    JSON.stringify(resource).includes('cognito-idp:AdminGetUser')
  );

  expect(transactStatement).toEqual(expect.objectContaining({
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
      { 'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemCollaborationTableFDECF217', 'Arn'] },
    ]),
  }));
  expect(JSON.stringify(transactStatement)).not.toContain('ProjectTasksTableE21F6637');
  expect(JSON.stringify(policy)).toContain('NotificationsTable76DCFC6C');
  expect(JSON.stringify(policy)).toContain('dynamodb:Query');
  expect(JSON.stringify(policy)).toContain('dynamodb:PutItem');

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
  expect(JSON.stringify(cognitoPolicy)).toContain('CognitoUserPoolId');
  expect(JSON.stringify(policy)).not.toContain('"Resource":"*"');
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
    JSON.stringify(candidate).includes('workspace-bootstrap-v1'),
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
  expect(createPayload).toContain('#role = :role');
  expect(createPayload).toContain('attribute_not_exists(directoryId) OR');
  expect(bootstrap.Properties.Update).toEqual(bootstrap.Properties.Create);
});

test('canonical Work Item seed replaces legacy task writes and preserves demo data', () => {
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
  expect(workItemPayload).toContain('dynamodb');
  expect(workItemPayload).toContain('legacy-project-task');
  expect(workItemPayload).toContain(
    '{{Ref:WorkspaceDirectoryId}}#project#refero#task#wireframe',
  );
  expect(workItemPayload.match(/schemaVersion/g)).toHaveLength(10);
  expect(workItemPayload.match(/revision/g)).toHaveLength(10);
  expect(workItemPayload.match(/workItemId/g)).toHaveLength(10);
  expect(workItemPayload.match(/migrationSourceKey/g)).toHaveLength(10);
  expect(workItemPayload.match(/migrationSource/g)).toHaveLength(20);
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
