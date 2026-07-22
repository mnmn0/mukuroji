import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { expect, test } from '@jest/globals';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import {
  createCanonicalWorkItemTransactItems,
  createProjectDirectoryTransactItems,
  createWorkspaceAccessTransactItems,
  createWorkspaceBootstrapTransactItems,
  createWorkspaceDemoMemberTransactItems,
} from '../lib/bootstrap-data';
import { CdkStack } from '../lib/cdk-stack';

/**
 * 各 test で使用する synthesized CloudFormation template を作成します。
 */
function createTemplate() {
  const app = new cdk.App({
    context: {
      '@aws-cdk/aws-iam:minimizePolicies': true,
      '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
      '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
    },
  });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new CdkStack(app, 'Test');
  acknowledgeKnownNagFindings(stack);

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

/**
 * 指定した SQS queue が非 TLS request を resource policy で拒否することを検証します。
 */
function expectQueueRequiresSsl(template: Template, logicalIdPrefix: string) {
  const queueEntry = Object.entries(template.findResources('AWS::SQS::Queue'))
    .find(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(queueEntry).toBeDefined();
  if (!queueEntry) {
    throw new Error(`${logicalIdPrefix} was not synthesized.`);
  }
  const [queueId] = queueEntry;
  const queuePolicy = Object.values(template.findResources('AWS::SQS::QueuePolicy'))
    .find((resource) => JSON.stringify(resource.Properties?.Queues).includes(queueId));

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

const synthesizedTemplate = createTemplate();

test('fresh deployment requires explicit Cognito workspace and runtime secrets parameters', () => {
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
  expect(parameters.CognitoSsoUserPoolClientId).toEqual(expect.objectContaining({
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
  expect(parameters.RequestRateLimitPerHour).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 10,
    MinValue: 1,
    MaxValue: 10000,
  }));
  for (const secretParameterName of [
    'EnterpriseIdentityTokenHashSecret',
    'EnterpriseSsoStateSecret',
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
    'CognitoSsoUserPoolClientId',
    'EnterpriseIdentityTokenHashSecret',
    'EnterpriseSsoStateSecret',
    'WorkspaceDirectoryId',
    'WorkspaceAuditPseudonymKey',
    'InitialOwnerEmail',
    'InitialOwnerUsername',
    'RequestEmailWebhookSecret',
    'RequestTokenHashSecret',
  ]) {
    expect(parameters[parameterName].Default).toBeUndefined();
  }
  expect(template.toJSON().Rules.EnterpriseSecretSeparation).toEqual({
    Assertions: [{
      Assert: {
        'Fn::Not': [{
          'Fn::Equals': [
            { Ref: 'EnterpriseSsoStateSecret' },
            { Ref: 'EnterpriseIdentityTokenHashSecret' },
          ],
        }],
      },
      AssertDescription:
        'EnterpriseSsoStateSecret must differ from EnterpriseIdentityTokenHashSecret.',
    }],
  });
  expect(template.toJSON().Rules.CognitoClientSeparation).toEqual({
    Assertions: [{
      Assert: {
        'Fn::Not': [{
          'Fn::Equals': [
            { Ref: 'CognitoSsoUserPoolClientId' },
            { Ref: 'CognitoUserPoolClientId' },
          ],
        }],
      },
      AssertDescription:
        'CognitoSsoUserPoolClientId must differ from CognitoUserPoolClientId.',
    }],
  });

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
    'DeveloperPlatformTable772E085C',
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

  expect(Object.keys(tables)).toHaveLength(20);

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
  expect(resources.TeamIssuesTable189D851D.Properties)
    .toEqual(expect.objectContaining({
      GlobalSecondaryIndexes: expect.arrayContaining([
        expect.objectContaining({
          IndexName: 'TeamIssueUpdatedAtIndex',
          KeySchema: [
            { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    }));
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

test('enterprise identity CONTROL stream runs bounded asynchronous maintenance', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const tableLogicalId = template.toJSON().Outputs.EnterpriseIdentityTableName?.Value?.Ref;
  const functionEntry = Object.entries(resources).find(([, resource]) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Compacts enterprise identity generations and applies grace-period TTL retirement.'
  );

  expect(functionEntry).toBeDefined();
  const [functionLogicalId, maintenanceFunction] = functionEntry!;
  expect(maintenanceFunction).toEqual(expect.objectContaining({
    Properties: expect.objectContaining({
      Environment: {
        Variables: {
          ENTERPRISE_IDENTITY_TABLE_NAME: { Ref: tableLogicalId },
        },
      },
      MemorySize: 1024,
      Timeout: 900,
    }),
  }));
  expect(JSON.stringify(maintenanceFunction))
    .not.toContain('ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET');

  const eventSource = Object.values(resources).find((resource) =>
    (resource as { Type?: string }).Type === 'AWS::Lambda::EventSourceMapping' &&
    JSON.stringify(resource).includes(functionLogicalId)
  ) as { Properties?: Record<string, unknown> } | undefined;
  expect(eventSource?.Properties).toEqual(expect.objectContaining({
    BatchSize: 1,
    BisectBatchOnFunctionError: true,
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumRetryAttempts: 10,
    StartingPosition: 'TRIM_HORIZON',
  }));
  expect(JSON.stringify(eventSource?.Properties?.FilterCriteria))
    .toContain('enterprise-identity-control');
  expect(JSON.stringify(eventSource?.Properties?.FilterCriteria))
    .toContain('maintenanceRequired');
  expect(JSON.stringify(eventSource?.Properties?.EventSourceArn))
    .toContain(String(tableLogicalId));
  expect(JSON.stringify(eventSource?.Properties?.DestinationConfig))
    .toContain('EnterpriseIdentityMaintenanceDlq');

  const functionRoleLogicalId = (
    (maintenanceFunction as {
      Properties?: { Role?: { 'Fn::GetAtt'?: string[] } }
    }).Properties?.Role?.['Fn::GetAtt'] ?? []
  )[0];
  const rolePolicies = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::IAM::Policy' &&
    JSON.stringify(resource).includes(String(functionRoleLogicalId))
  );
  const serializedPolicies = JSON.stringify(rolePolicies);
  expect(serializedPolicies).toContain('dynamodb:BatchWriteItem');
  expect(serializedPolicies).toContain('dynamodb:GetItem');
  expect(serializedPolicies).toContain('dynamodb:PutItem');
  expect(serializedPolicies).toContain('dynamodb:Query');
  expect(serializedPolicies).toContain('dynamodb:UpdateItem');
  expect(serializedPolicies).not.toContain('dynamodb:DeleteItem');
  expect(serializedPolicies).not.toContain('dynamodb:Scan');
  expect(serializedPolicies).not.toContain('secretsmanager:');
  expect(serializedPolicies).not.toContain('dynamodb:TransactWriteItems');
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects enterprise identity compaction or generation retirement failures.',
  });
  expectQueueRequiresSsl(template, 'EnterpriseIdentityMaintenanceDlq');
  template.hasOutput('EnterpriseIdentityMaintenanceDlqUrl', {});
});

test('enterprise SCIM group jobs run in a dedicated bounded worker', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const tableLogicalId = template.toJSON().Outputs.EnterpriseIdentityTableName?.Value?.Ref;
  const functionEntry = Object.entries(resources).find(([, resource]) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Dedicated bounded worker for asynchronous enterprise SCIM group reconciliation.'
  );

  expect(functionEntry).toBeDefined();
  const [functionLogicalId, workerFunction] = functionEntry!;
  expect(workerFunction).toEqual(expect.objectContaining({
    Properties: expect.objectContaining({
      Handler: 'index.handler',
      MemorySize: 512,
      ReservedConcurrentExecutions: 5,
      Runtime: 'nodejs22.x',
      Timeout: 60,
      Environment: {
        Variables: expect.objectContaining({
          AUDIT_EVENTS_TABLE_NAME: {
            Ref: 'AuditEventsTable0723963E',
          },
          COGNITO_USER_POOL_ID: {
            Ref: 'CognitoUserPoolId',
          },
          ENTERPRISE_IDENTITY_TABLE_NAME: {
            Ref: String(tableLogicalId),
          },
          PLANNING_TABLE_NAME: {
            Ref: 'PlanningTable2A0D4CC5',
          },
          PROJECT_DIRECTORY_TABLE_NAME: {
            Ref: 'ProjectDirectoryTable9ED01C01',
          },
          WORKSPACE_ACCESS_TABLE_NAME: {
            Ref: 'WorkspaceAccessTableD7C8D2C7',
          },
        }),
      },
    }),
  }));
  const eventSource = Object.values(resources).find((resource) =>
    (resource as { Type?: string }).Type === 'AWS::Lambda::EventSourceMapping' &&
    JSON.stringify(resource).includes(functionLogicalId) &&
    JSON.stringify(resource).includes('enterprise-scim-group-job')
  ) as { Properties?: Record<string, unknown> } | undefined;

  expect(eventSource?.Properties).toEqual(expect.objectContaining({
    BatchSize: 1,
    BisectBatchOnFunctionError: true,
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    MaximumRetryAttempts: 10,
    ParallelizationFactor: 1,
    StartingPosition: 'TRIM_HORIZON',
  }));
  expect(JSON.stringify(eventSource?.Properties?.FilterCriteria))
    .toContain('enterprise-scim-group-job');
  expect(JSON.stringify(eventSource?.Properties?.FilterCriteria))
    .toContain('SCIM_GROUP_JOB#');
  expect(JSON.stringify(eventSource?.Properties?.FilterCriteria))
    .toContain('INSERT');
  expect(JSON.stringify(eventSource?.Properties?.FilterCriteria))
    .toContain('MODIFY');
  expect(JSON.stringify(eventSource?.Properties?.EventSourceArn))
    .toContain(String(tableLogicalId));
  expect(JSON.stringify(eventSource?.Properties?.DestinationConfig))
    .toContain('EnterpriseScimGroupJobDlq');

  const functionRoleLogicalId = (
    (workerFunction as {
      Properties?: { Role?: { 'Fn::GetAtt'?: string[] } }
    }).Properties?.Role?.['Fn::GetAtt'] ?? []
  )[0];
  const rolePolicies = Object.values(resources).filter((resource) =>
    ['AWS::IAM::ManagedPolicy', 'AWS::IAM::Policy'].includes(
      (resource as { Type?: string }).Type ?? '',
    ) &&
    JSON.stringify(resource).includes(String(functionRoleLogicalId))
  );
  const roleStatements = rolePolicies.flatMap((resource) =>
    (resource as {
      Properties?: {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> }
      }
    }).Properties?.PolicyDocument?.Statement ?? []
  );
  const actionsForTable = (logicalId: string) => [
    ...new Set(roleStatements
      .filter((statement) =>
        JSON.stringify(statement.Resource).includes(JSON.stringify({
          'Fn::GetAtt': [logicalId, 'Arn'],
        }))
      )
      .flatMap((statement) => {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        return actions.filter((action): action is string =>
          typeof action === 'string'
        );
      })),
  ].sort();
  const serializedPolicies = JSON.stringify(rolePolicies);
  expect(serializedPolicies).toContain('dynamodb:DescribeStream');
  expect(serializedPolicies).toContain('dynamodb:GetRecords');
  expect(serializedPolicies).toContain('dynamodb:GetShardIterator');
  expect(serializedPolicies).toContain('dynamodb:ListStreams');
  expect(serializedPolicies).toContain('sqs:SendMessage');
  expect(serializedPolicies).toContain('dynamodb:BatchWriteItem');
  expect(serializedPolicies).toContain('dynamodb:GetItem');
  expect(serializedPolicies).toContain('dynamodb:Query');
  expect(actionsForTable(String(tableLogicalId))).toEqual([
    'dynamodb:BatchWriteItem',
    'dynamodb:DeleteItem',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
  ]);
  expect(actionsForTable('WorkspaceAccessTableD7C8D2C7')).toEqual([
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
  ]);
  for (const logicalId of [
    'PlanningTable2A0D4CC5',
    'DocumentsTable7E808EE5',
  ]) {
    expect(actionsForTable(logicalId)).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ]);
  }
  expect(actionsForTable('AuditEventsTable0723963E')).toEqual([
    'dynamodb:PutItem',
  ]);
  expect(serializedPolicies).not.toContain('dynamodb:ConditionCheckItem');
  expect(serializedPolicies).not.toContain('dynamodb:TransactWriteItems');
  expect(serializedPolicies).toContain('cognito-idp:AdminDisableUser');
  expect(serializedPolicies).toContain('cognito-idp:AdminEnableUser');
  expect(serializedPolicies).toContain('cognito-idp:AdminUserGlobalSignOut');
  expect(serializedPolicies).toContain('EnterpriseIdentityTable');
  expect(serializedPolicies).toContain('WorkspaceAccessTable');
  expect(serializedPolicies).toContain('PlanningTable');
  expect(serializedPolicies).toContain('AuditEventsTable');
  expect(serializedPolicies).toContain('ProjectDirectoryTable');
  expect(serializedPolicies).toContain('EnterpriseScimGroupJobDlq');
  expect(serializedPolicies).not.toContain('TeamIssuesTable');
  expect(serializedPolicies).not.toContain('dynamodb:Scan');
  expect(serializedPolicies).not.toContain('secretsmanager:');

  const apiFunction = resources.ListProjectTasksFunction2134AF4A;
  expect(apiFunction.Properties.Timeout).toBe(15);
  const apiFunctionRoleLogicalId = (
    (apiFunction as {
      Properties?: { Role?: { 'Fn::GetAtt'?: string[] } }
    }).Properties?.Role?.['Fn::GetAtt'] ?? []
  )[0];
  const apiRolePolicies = Object.values(resources).filter((resource) =>
    ['AWS::IAM::ManagedPolicy', 'AWS::IAM::Policy'].includes(
      (resource as { Type?: string }).Type ?? '',
    ) &&
    JSON.stringify(resource).includes(String(apiFunctionRoleLogicalId))
  );
  const serializedApiPolicies = JSON.stringify(apiRolePolicies);
  expect(serializedApiPolicies).not.toContain('dynamodb:DescribeStream');
  expect(serializedApiPolicies).not.toContain('dynamodb:ListStreams');
  expect(serializedApiPolicies).not.toContain('EnterpriseScimGroupJobDlq');
  const apiEnterpriseStreamStatement = apiRolePolicies
    .flatMap((resource) =>
      (resource as {
        Properties?: {
          PolicyDocument?: { Statement?: Record<string, unknown>[] }
        }
      }).Properties?.PolicyDocument?.Statement ?? []
    )
    .find((statement) =>
      JSON.stringify(statement.Action).includes('dynamodb:GetRecords') &&
      JSON.stringify(statement.Resource).includes('EnterpriseIdentityTable')
    );
  expect(apiEnterpriseStreamStatement).toBeUndefined();
  expect(Object.values(resources).some((resource) =>
    (resource as { Type?: string }).Type === 'AWS::Lambda::EventSourceMapping' &&
    JSON.stringify(resource).includes('ListProjectTasksFunction2134AF4A') &&
    JSON.stringify(resource).includes('enterprise-scim-group-job')
  )).toBe(false);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects failed asynchronous enterprise SCIM group reconciliation jobs.',
  });
  expectQueueRequiresSsl(template, 'EnterpriseScimGroupJobDlq');
  template.hasOutput('EnterpriseScimGroupJobFunctionName', {});
  template.hasOutput('EnterpriseScimGroupJobDlqUrl', {});
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

  const apiFunction = template.toJSON().Resources.ListProjectTasksFunction2134AF4A;
  expect(apiFunction.Properties.Environment.Variables).toEqual(expect.objectContaining({
    ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
    ANALYTICS_TABLE_NAME: { Ref: analyticsTableLogicalId },
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

test('analytics scheduled delivery reauthorizes source data without consuming the audit stream', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const analyticsTableLogicalId = template.toJSON().Outputs.AnalyticsTableName?.Value?.Ref;
  const auditTableLogicalId = template.toJSON().Outputs.AuditEventsTableName?.Value?.Ref;
  const projectDirectoryTableLogicalId =
    template.toJSON().Outputs.ProjectDirectoryTableName?.Value?.Ref;
  const workItemsTableLogicalId = template.toJSON().Outputs.WorkItemsTableName?.Value?.Ref;
  const workspaceAccessTableLogicalId =
    template.toJSON().Outputs.WorkspaceAccessTableName?.Value?.Ref;

  expect(typeof analyticsTableLogicalId).toBe('string');
  expect(typeof auditTableLogicalId).toBe('string');
  expect(typeof projectDirectoryTableLogicalId).toBe('string');
  expect(typeof workItemsTableLogicalId).toBe('string');
  expect(typeof workspaceAccessTableLogicalId).toBe('string');
  if (
    typeof analyticsTableLogicalId !== 'string' ||
    typeof auditTableLogicalId !== 'string' ||
    typeof projectDirectoryTableLogicalId !== 'string' ||
    typeof workItemsTableLogicalId !== 'string' ||
    typeof workspaceAccessTableLogicalId !== 'string'
  ) {
    throw new Error('Analytics schedule data table outputs must reference tables.');
  }

  template.hasResourceProperties('AWS::Lambda::Function', {
    Description:
      'Creates permission-safe in-app analytics snapshot delivery receipts on deterministic schedule occurrences.',
    Environment: {
      Variables: Match.objectLike({
        ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
        ANALYTICS_TABLE_NAME: { Ref: analyticsTableLogicalId },
        AUDIT_EVENTS_TABLE_NAME: { Ref: auditTableLogicalId },
        COGNITO_CLIENT_ID: { Ref: 'CognitoUserPoolClientId' },
        COGNITO_USER_POOL_ID: { Ref: 'CognitoUserPoolId' },
        MUKUROJI_PROJECT_DIRECTORY_TABLE: { Ref: projectDirectoryTableLogicalId },
        MUKUROJI_WORK_ITEMS_TABLE: { Ref: workItemsTableLogicalId },
        SYSTEM_ADMIN_GROUPS: { Ref: 'SystemAdminGroups' },
        WORKSPACE_ACCESS_TABLE_NAME: { Ref: workspaceAccessTableLogicalId },
      }),
    },
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Checks due saved analytics reports every five minutes.',
    ScheduleExpression: 'rate(5 minutes)',
    State: 'ENABLED',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects analytics snapshot delivery failures after asynchronous retries.',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    Threshold: 1,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects failures while Lambda delivers analytics schedule failures to the DLQ.',
    MetricName: 'DestinationDeliveryFailures',
    Namespace: 'AWS/Lambda',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  template.hasOutput('AnalyticsScheduleDlqUrl', {});

  const schedulePolicies = Object.entries(resources)
    .filter(([logicalId, resource]) =>
      logicalId.startsWith('AnalyticsScheduleFunctionServiceRole') &&
      (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
    )
    .map(([, resource]) => resource);
  const serializedSchedulePolicies = JSON.stringify(schedulePolicies);

  expect(serializedSchedulePolicies).toContain(analyticsTableLogicalId);
  expect(serializedSchedulePolicies).toContain(auditTableLogicalId);
  expect(serializedSchedulePolicies).toContain(projectDirectoryTableLogicalId);
  expect(serializedSchedulePolicies).toContain(workItemsTableLogicalId);
  expect(serializedSchedulePolicies).toContain(workspaceAccessTableLogicalId);
  expect(serializedSchedulePolicies).toContain('CognitoUserPoolId');
  expect(serializedSchedulePolicies).toContain('cognito-idp:AdminListGroupsForUser');
  expect(serializedSchedulePolicies).not.toContain('dynamodb:TransactWriteItems');

  const scheduleStatements = schedulePolicies.flatMap((policy) => {
    const statements =
      (policy as {
        Properties?: { PolicyDocument?: { Statement?: unknown } }
      }).Properties?.PolicyDocument?.Statement;
    return Array.isArray(statements) ? statements : [];
  });
  const actionsForResource = (logicalId: string) =>
    scheduleStatements
      .filter((statement) =>
        JSON.stringify(
          (statement as { Resource?: unknown }).Resource,
        ).includes(logicalId)
      )
      .flatMap((statement) => {
        const action = (statement as { Action?: unknown }).Action;
        return Array.isArray(action) ? action : [action];
      })
      .filter((action): action is string => typeof action === 'string');

  expect(new Set(actionsForResource(analyticsTableLogicalId))).toEqual(new Set([
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
  ]));
  expect(new Set(actionsForResource(auditTableLogicalId))).toEqual(
    new Set(['dynamodb:Query']),
  );
  expect(new Set(actionsForResource(projectDirectoryTableLogicalId))).toEqual(
    new Set(['dynamodb:Query']),
  );
  expect(new Set(actionsForResource(workItemsTableLogicalId))).toEqual(
    new Set(['dynamodb:Query']),
  );
  expect(new Set(actionsForResource(workspaceAccessTableLogicalId))).toEqual(
    new Set(['dynamodb:GetItem']),
  );

  const scheduleDynamoActions = scheduleStatements
    .flatMap((statement) => {
      const action = (statement as { Action?: unknown }).Action;
      return Array.isArray(action) ? action : [action];
    })
    .filter((action): action is string =>
      typeof action === 'string' && action.startsWith('dynamodb:')
    );
  for (const forbiddenAction of [
    'dynamodb:BatchGetItem',
    'dynamodb:BatchWriteItem',
    'dynamodb:DeleteItem',
    'dynamodb:Scan',
    'dynamodb:UpdateItem',
  ]) {
    expect(scheduleDynamoActions).not.toContain(forbiddenAction);
  }

  const auditStreamMappings = Object.values(
    template.findResources('AWS::Lambda::EventSourceMapping'),
  ).filter((resource) =>
    JSON.stringify(resource).includes(auditTableLogicalId)
  );

  expect(auditStreamMappings).toHaveLength(2);
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
    Timeout: 15,
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
        COGNITO_SSO_CLIENT_ID: {
          Ref: 'CognitoSsoUserPoolClientId',
        },
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
        ENTERPRISE_IDENTITY_TABLE_NAME: Match.anyValue(),
        ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET: {
          Ref: 'EnterpriseIdentityTokenHashSecret',
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
        WEBHOOK_DELIVERY_QUEUE_URL: {
          Ref: 'WebhookDeliveryQueue2A244492',
        },
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

test('durable Work Item imports use retained versioned sources and an isolated resumable worker', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources as Record<string, {
    Type: string;
    Properties: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  const outputs = template.toJSON().Outputs;
  const enterpriseIdentityTableId = outputs.EnterpriseIdentityTableName?.Value?.Ref;
  const planningTableId = outputs.PlanningTableName?.Value?.Ref;
  const workItemConfigurationTableId =
    outputs.WorkItemConfigurationTableName?.Value?.Ref;
  const workspaceAccessTableId = outputs.WorkspaceAccessTableName?.Value?.Ref;
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
  expect(typeof enterpriseIdentityTableId).toBe('string');
  expect(typeof planningTableId).toBe('string');
  expect(typeof workItemConfigurationTableId).toBe('string');
  expect(typeof workspaceAccessTableId).toBe('string');
  if (!importBucketEntry || !importQueueEntry || !importDlqEntry || !workerEntry) {
    throw new Error('Durable Work Item import resources were not synthesized.');
  }

  const [importBucketId, importBucket] = importBucketEntry;
  const [importQueueId, importQueue] = importQueueEntry;
  const [importDlqId, importDlq] = importDlqEntry;
  const [workerId, worker] = workerEntry;
  const loggingConfiguration = importBucket.Properties.LoggingConfiguration as {
    DestinationBucketName?: { Ref?: string };
    LogFilePrefix?: string;
  };
  const accessLogsBucketId = loggingConfiguration.DestinationBucketName?.Ref;
  expect(accessLogsBucketId).toBeDefined();
  if (!accessLogsBucketId) {
    throw new Error('Work Item import access logs bucket was not synthesized.');
  }
  const accessLogsBucket = resources[accessLogsBucketId];
  const accessLogsBucketPolicy = Object.values(resources).find((resource) =>
    resource.Type === 'AWS::S3::BucketPolicy' &&
    JSON.stringify(resource.Properties?.Bucket).includes(accessLogsBucketId)
  );
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
      LoggingConfiguration: {
        DestinationBucketName: { Ref: accessLogsBucketId },
        LogFilePrefix: 'work-item-import/',
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
  expect(accessLogsBucket).toEqual(expect.objectContaining({
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
            ExpirationInDays: 90,
            Id: 'ExpireImportAccessLogs',
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
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
    }),
  }));
  expect(accessLogsBucketPolicy).toEqual(expect.objectContaining({
    Properties: expect.objectContaining({
      PolicyDocument: expect.objectContaining({
        Statement: expect.arrayContaining([
          expect.objectContaining({
            Action: 's3:*',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: expect.arrayContaining([
              { 'Fn::GetAtt': [accessLogsBucketId, 'Arn'] },
              expect.objectContaining({ 'Fn::Join': expect.any(Array) }),
            ]),
          }),
          expect.objectContaining({
            Action: 's3:PutObject',
            Condition: {
              ArnLike: {
                'aws:SourceArn': { 'Fn::GetAtt': [importBucketId, 'Arn'] },
              },
              StringEquals: {
                'aws:SourceAccount': { Ref: 'AWS::AccountId' },
              },
            },
            Effect: 'Allow',
            Principal: { Service: 'logging.s3.amazonaws.com' },
          }),
        ]),
      }),
    }),
  }));
  expect(importQueue).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
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
  expect(importDlq).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
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
        ENTERPRISE_IDENTITY_TABLE_NAME: { Ref: enterpriseIdentityTableId },
        PLANNING_TABLE_NAME: { Ref: planningTableId },
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
  const workerStatements = (
    workerPolicy as {
      Properties?: {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
      };
    }
  )?.Properties?.PolicyDocument?.Statement ?? [];
  const authorizationConditionStatement = workerStatements.find((statement) =>
    statement.Action === 'dynamodb:ConditionCheckItem'
  );
  const authorizationReadStatement = workerStatements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:GetItem') &&
    JSON.stringify(statement.Resource).includes(String(enterpriseIdentityTableId)) &&
    JSON.stringify(statement.Resource).includes(String(planningTableId))
  );
  expect(authorizationConditionStatement).toEqual({
    Action: 'dynamodb:ConditionCheckItem',
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': [workspaceAccessTableId, 'Arn'] },
      { 'Fn::GetAtt': [planningTableId, 'Arn'] },
      { 'Fn::GetAtt': [enterpriseIdentityTableId, 'Arn'] },
      { 'Fn::GetAtt': [workItemConfigurationTableId, 'Arn'] },
    ]),
  });
  expect(
    (authorizationConditionStatement?.Resource as unknown[] | undefined),
  ).toHaveLength(4);
  expect(authorizationReadStatement).toEqual(expect.objectContaining({
    Action: ['dynamodb:GetItem', 'dynamodb:Query'],
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': [planningTableId, 'Arn'] },
      { 'Fn::GetAtt': [enterpriseIdentityTableId, 'Arn'] },
    ]),
  }));
  expect(
    authorizationReadStatement?.Resource as unknown[] | undefined,
  ).toHaveLength(2);
  const sensitiveAuthorizationActions = workerStatements
    .filter((statement) => {
      const resources = JSON.stringify(statement.Resource);
      return resources.includes(String(enterpriseIdentityTableId)) ||
        resources.includes(String(planningTableId));
    })
    .flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    );
  expect(sensitiveAuthorizationActions).not.toContain('dynamodb:BatchGetItem');
  expect(sensitiveAuthorizationActions).not.toContain('dynamodb:Scan');
  for (const requiredPermission of [
    'cognito-idp:AdminGetUser',
    'cognito-idp:AdminListGroupsForUser',
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

test('public API workers and the migration provider use retained 90-day log groups', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const functionExpectations = [
    {
      description: 'Processes durable Work Item imports with resumable row receipts.',
      handler: 'index.workItemImportHandler',
    },
    {
      description:
        'Starts the API, projection, and delivery drain before Webhook backfill.',
      handler: 'index.handler',
    },
    {
      description:
        'Drains old Webhook runtimes and processes checkpointed migration pages.',
      handler: 'index.isCompleteHandler',
    },
    {
      description: 'Delivers signed Webhooks from the durable SQS queue.',
      handler: 'index.deliveryHandler',
    },
    {
      description:
        'Processes provider-neutral connector synchronization jobs with current Work Item RBAC.',
      handler: 'index.queueHandler',
    },
    {
      description: 'Schedules bounded polling jobs for connected provider installations.',
      handler: 'index.pollHandler',
    },
  ];

  const assertRetainedLogGroup = (logGroupId: unknown) => {
    expect(typeof logGroupId).toBe('string');
    if (typeof logGroupId !== 'string') {
      throw new Error('Lambda does not reference an explicit log group.');
    }
    expect(resources[logGroupId]).toEqual(expect.objectContaining({
      Type: 'AWS::Logs::LogGroup',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        RetentionInDays: 90,
      }),
    }));
  };

  for (const expectation of functionExpectations) {
    const functionEntry = Object.values(resources).find((resource) =>
      (resource as {
        Type?: string;
        Properties?: { Description?: string; Handler?: string };
      }).Type === 'AWS::Lambda::Function' &&
      (resource as {
        Properties?: { Description?: string; Handler?: string };
      }).Properties?.Description === expectation.description &&
      (resource as {
        Properties?: { Description?: string; Handler?: string };
      }).Properties?.Handler === expectation.handler
    ) as {
      Properties?: { LoggingConfig?: { LogGroup?: { Ref?: string } } };
    } | undefined;

    expect(functionEntry).toBeDefined();
    assertRetainedLogGroup(
      functionEntry?.Properties?.LoggingConfig?.LogGroup?.Ref,
    );
  }

  const providerFunctions = Object.values(resources).filter((resource) => {
    const properties = (
      resource as { Type?: string; Properties?: { Description?: string } }
    ).Properties;
    return (resource as { Type?: string }).Type === 'AWS::Lambda::Function' &&
      properties?.Description?.startsWith('AWS CDK resource provider framework -') &&
      properties.Description.includes('WebhookAuthorizationBackfillProvider');
  }) as Array<{
    Properties?: { LoggingConfig?: { LogGroup?: { Ref?: string } } };
  }>;
  expect(providerFunctions).toHaveLength(3);
  const providerLogGroupIds = new Set(providerFunctions.map((resource) =>
    resource.Properties?.LoggingConfig?.LogGroup?.Ref
  ));
  expect(providerLogGroupIds.size).toBe(1);
  assertRetainedLogGroup([...providerLogGroupIds][0]);
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
  const protectedKmsKeys = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::KMS::Key'
  ) as Array<{ DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
  expect(protectedKmsKeys).toHaveLength(4);
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

test('audit stream projects all downstream deliveries with one combined consumer', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description:
      'Projects audit outbox events into collaboration, Webhook, and connector deliveries.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        COLLABORATION_TABLE_NAME: {
          Ref: 'WorkItemCollaborationTableFDECF217',
        },
        CONNECTOR_SYNC_QUEUE_URL: {
          Ref: 'ConnectorSyncQueue4F8E52D0',
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
        MUKUROJI_RUNTIME_ROLE: 'audit-projection',
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
        WEBHOOK_DELIVERY_QUEUE_URL: {
          Ref: 'WebhookDeliveryQueue2A244492',
        },
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
    FunctionName: {
      Ref: 'CollaborationProjectionFunction1AAC5764',
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
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects audit projection records that exhausted collaboration, Webhook, or connector stream retries.',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    DatapointsToAlarm: 1,
    Dimensions: [{
      Name: 'QueueName',
      Value: {
        'Fn::GetAtt': ['CollaborationProjectionDlqAF6DB4E6', 'QueueName'],
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
  const actionsForProjectionTable = (logicalId: string) => projectionStatements
    .filter((statement) => JSON.stringify(statement.Resource).includes(logicalId))
    .flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    );

  expect(serializedProjectionPolicy).toContain('production/*/@connections/*');
  expect(serializedProjectionPolicy).toContain('WorkItemCollaborationTableFDECF217');
  expect(serializedProjectionPolicy).toContain('cognito-idp:AdminListGroupsForUser');
  expect(serializedProjectionPolicy).toContain('CognitoUserPoolId');
  expect(serializedProjectionPolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedProjectionPolicy).not.toContain('DeveloperPlatformTable772E085C');
  expect(serializedProjectionPolicy).not.toContain('LookupKeyIndex');
  expect(serializedProjectionPolicy).toContain('WebhookDeliveryQueue2A244492');
  expect(serializedProjectionPolicy).toContain('ConnectorSyncQueue4F8E52D0');
  expect(serializedProjectionPolicy).not.toContain('dynamodb:TransactWriteItems');
  expect(actionsForProjectionTable('NotificationsTable76DCFC6C'))
    .toContain('dynamodb:PutItem');
  expect(actionsForProjectionTable('ProcessedAuditEventsTableFF485133'))
    .toContain('dynamodb:PutItem');
  expect(serializedProjectionPolicy).toContain('sqs:SendMessage');
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

  const auditStreamMappings = Object.values(resources).filter((resource) => {
    if ((resource as { Type?: string }).Type !== 'AWS::Lambda::EventSourceMapping') return false;
    const eventSourceArn = (
      resource as { Properties?: { EventSourceArn?: unknown } }
    ).Properties?.EventSourceArn;
    return JSON.stringify(eventSourceArn).includes('AuditEventsTable0723963E');
  }) as Array<{ Properties: { FunctionName: { Ref: string } } }>;
  expect(auditStreamMappings).toHaveLength(2);
  expect(auditStreamMappings.map(({ Properties }) => Properties.FunctionName.Ref).sort())
    .toEqual([
      'AutomationEventFunction5E8CB543',
      'CollaborationProjectionFunction1AAC5764',
    ]);
});

test('audit Webhook projection and SQS delivery are durable encrypted and observable', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const auditEventsTableId =
    template.toJSON().Outputs.AuditEventsTableName?.Value?.Ref;
  const developerPlatformTableId =
    template.toJSON().Outputs.DeveloperPlatformTableName?.Value?.Ref;
  const enterpriseIdentityTableId =
    template.toJSON().Outputs.EnterpriseIdentityTableName?.Value?.Ref;
  const projectDirectoryTableId =
    template.toJSON().Outputs.ProjectDirectoryTableName?.Value?.Ref;
  const workspaceAccessTableId =
    template.toJSON().Outputs.WorkspaceAccessTableName?.Value?.Ref;
  const webhookKeyId = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('DeveloperPlatformWebhookKey') &&
    (resource as { Type?: string }).Type === 'AWS::KMS::Key'
  )?.[0];
  expect(typeof auditEventsTableId).toBe('string');
  expect(typeof developerPlatformTableId).toBe('string');
  expect(typeof enterpriseIdentityTableId).toBe('string');
  expect(typeof projectDirectoryTableId).toBe('string');
  expect(typeof workspaceAccessTableId).toBe('string');
  expect(webhookKeyId).toBeDefined();
  if (
    typeof auditEventsTableId !== 'string' ||
    typeof developerPlatformTableId !== 'string' ||
    typeof enterpriseIdentityTableId !== 'string' ||
    typeof projectDirectoryTableId !== 'string' ||
    typeof workspaceAccessTableId !== 'string' ||
    !webhookKeyId
  ) {
    throw new Error('Webhook delivery data resources were not synthesized.');
  }
  const deliveryEnvironment = {
    Variables: Match.objectLike({
      COGNITO_USER_POOL_ID: { Ref: 'CognitoUserPoolId' },
      DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
      DEVELOPER_PLATFORM_TABLE_NAME: {
        Ref: 'DeveloperPlatformTable772E085C',
      },
      DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID: Match.anyValue(),
      ENTERPRISE_IDENTITY_TABLE_NAME: {
        Ref: enterpriseIdentityTableId,
      },
      PROJECT_DIRECTORY_TABLE_NAME: {
        Ref: 'ProjectDirectoryTable9ED01C01',
      },
      PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
        'WebhookAuthorizationIndex',
      SYSTEM_ADMIN_GROUPS: { Ref: 'SystemAdminGroups' },
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
    Description: 'Delivers signed Webhooks from the durable SQS queue.',
    Handler: 'index.deliveryHandler',
    Runtime: 'nodejs22.x',
    Timeout: 30,
    Environment: deliveryEnvironment,
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description:
      'Starts the API, projection, and delivery drain before Webhook backfill.',
    Environment: {
      Variables: {
        DEVELOPER_PLATFORM_TABLE_NAME: {
          Ref: 'DeveloperPlatformTable772E085C',
        },
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: 'ProjectDirectoryTable9ED01C01',
        },
        PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
          'WebhookAuthorizationIndex',
      },
    },
    Handler: 'index.handler',
    MemorySize: 512,
    Runtime: 'nodejs22.x',
    Timeout: 30,
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description:
      'Drains old Webhook runtimes and processes checkpointed migration pages.',
    Environment: {
      Variables: {
        DEVELOPER_PLATFORM_TABLE_NAME: {
          Ref: 'DeveloperPlatformTable772E085C',
        },
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: 'ProjectDirectoryTable9ED01C01',
        },
        PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
          'WebhookAuthorizationIndex',
      },
    },
    Handler: 'index.isCompleteHandler',
    MemorySize: 1024,
    Runtime: 'nodejs22.x',
    Timeout: 300,
  });
  const backfillEntry = Object.entries(resources).find(([, resource]) =>
    (resource as { Properties?: { MigrationVersion?: string } })
      .Properties?.MigrationVersion === 'v3'
  );
  expect(backfillEntry?.[0]).toBe('WebhookAuthorizationBackfill');
  expect(backfillEntry?.[1]).toEqual(expect.objectContaining({
    Type: 'AWS::CloudFormation::CustomResource',
    DependsOn: expect.arrayContaining([
      'CollaborationProjectionFunction1AAC5764',
      'ListProjectTasksFunction2134AF4A',
      'WebhookDeliveryFunctionEA305509',
    ]),
  }));
  expect(
    resources.WebhookDeliveryFunctionEA305509.DependsOn ?? [],
  ).not.toContain('WebhookAuthorizationBackfill');
  for (const rolePrefix of [
    'WebhookAuthorizationBackfillFunctionServiceRole',
    'WebhookAuthorizationBackfillProgressFunctionServiceRole',
  ]) {
    const roleId = Object.entries(resources).find(([logicalId, resource]) =>
      logicalId.startsWith(rolePrefix) &&
      (resource as { Type?: string }).Type === 'AWS::IAM::Role'
    )?.[0];
    const policies = Object.values(resources).filter((resource) => {
      if (!roleId || (resource as { Type?: string }).Type !== 'AWS::IAM::Policy') {
        return false;
      }
      const roles =
        (resource as { Properties?: { Roles?: Array<{ Ref?: string }> } })
          .Properties?.Roles ?? [];
      return roles.some((role) => role.Ref === roleId);
    });
    const statements = policies.flatMap((policy) =>
      (policy as {
        Properties?: {
          PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
        };
      }).Properties?.PolicyDocument?.Statement ?? []
    );
    expect(statements).toContainEqual(expect.objectContaining({
      Action: expect.arrayContaining([
        'dynamodb:ConditionCheckItem',
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ]),
      Effect: 'Allow',
      Resource: expect.arrayContaining([
        {
          'Fn::GetAtt': ['DeveloperPlatformTable772E085C', 'Arn'],
        },
        {
          'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'],
        },
      ]),
    }));
    expect(JSON.stringify(statements)).not.toContain('dynamodb:TransactWriteItems');
  }
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

  expect(Object.keys(resources).some((logicalId) =>
    logicalId.startsWith('WebhookProjectionFunction') ||
    logicalId.startsWith('WebhookProjectionDlq')
  )).toBe(false);
  expect(resources.WebhookDeliveryDlq163DBE73).toEqual({
    Type: 'AWS::SQS::Queue',
    Properties: {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    },
    UpdateReplacePolicy: 'Retain',
    DeletionPolicy: 'Retain',
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
      VisibilityTimeout: 180,
    },
    UpdateReplacePolicy: 'Retain',
    DeletionPolicy: 'Retain',
  });
  expect(resources.WebhookDeliveryQueue2A244492.Properties.FifoQueue).toBeUndefined();

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Detects signed Webhook deliveries that exhausted queue redrive attempts.',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    DatapointsToAlarm: 1,
    Dimensions: [{
      Name: 'QueueName',
      Value: {
        'Fn::GetAtt': ['WebhookDeliveryDlq163DBE73', 'QueueName'],
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

  const projectionRoleId = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('CollaborationProjectionFunctionServiceRole') &&
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
  expect(projectionPolicies).not.toContain('DeveloperPlatformTable772E085C');
  expect(projectionPolicies).toContain('ProjectDirectoryTable9ED01C01');
  expect(projectionPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(projectionPolicies).toContain('WebhookDeliveryQueue2A244492');
  expect(projectionPolicies).toContain('ConnectorSyncQueue4F8E52D0');
  expect(projectionPolicies).toContain('CollaborationProjectionDlqAF6DB4E6');
  expect(projectionPolicies).toContain('dynamodb:GetRecords');
  expect(projectionPolicies).not.toContain('dynamodb:TransactWriteItems');
  expect(projectionPolicies).not.toContain('kms:');
  expect(projectionPolicies).toContain('sqs:SendMessage');
  expect(deliveryPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(deliveryPolicies).toContain(enterpriseIdentityTableId);
  expect(deliveryPolicies).toContain('ProjectDirectoryTable9ED01C01');
  expect(deliveryPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(deliveryPolicies).toContain('WebhookDeliveryQueue2A244492');
  expect(deliveryPolicies).toContain('dynamodb:PutItem');
  expect(deliveryPolicies).toContain('dynamodb:UpdateItem');
  expect(deliveryPolicies).toContain('dynamodb:DeleteItem');
  expect(deliveryPolicies).toContain('WebhookAuthorizationIndex');
  expect(deliveryPolicies).toContain('cognito-idp:AdminListGroupsForUser');
  const deliveryStatements = policiesForRole(deliveryRoleId).flatMap((policy) =>
    (policy as {
      Properties?: {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
      };
    }).Properties?.PolicyDocument?.Statement ?? []
  );
  const getItemStatement = deliveryStatements.find((statement) =>
    statement.Action === 'dynamodb:GetItem' &&
    JSON.stringify(statement.Resource).includes(developerPlatformTableId)
  );
  const queryStatement = deliveryStatements.find((statement) =>
    statement.Action === 'dynamodb:Query' &&
    JSON.stringify(statement.Resource).includes('/index/LookupKeyIndex')
  );
  const getItemResources = getItemStatement?.Resource as unknown[] | undefined;
  const queryResources = queryStatement?.Resource as unknown[] | undefined;
  expect(getItemResources).toEqual(expect.arrayContaining([
    { 'Fn::GetAtt': [auditEventsTableId, 'Arn'] },
    { 'Fn::GetAtt': [developerPlatformTableId, 'Arn'] },
    { 'Fn::GetAtt': [enterpriseIdentityTableId, 'Arn'] },
    { 'Fn::GetAtt': [projectDirectoryTableId, 'Arn'] },
    { 'Fn::GetAtt': [workspaceAccessTableId, 'Arn'] },
  ]));
  expect(getItemResources).toHaveLength(5);
  expect(queryResources).toEqual(expect.arrayContaining([
    {
      'Fn::Join': [
        '',
        [
          { 'Fn::GetAtt': [developerPlatformTableId, 'Arn'] },
          '/index/LookupKeyIndex',
        ],
      ],
    },
    { 'Fn::GetAtt': [enterpriseIdentityTableId, 'Arn'] },
    { 'Fn::GetAtt': [projectDirectoryTableId, 'Arn'] },
    {
      'Fn::Join': [
        '',
        [
          { 'Fn::GetAtt': [projectDirectoryTableId, 'Arn'] },
          '/index/WebhookAuthorizationIndex',
        ],
      ],
    },
  ]));
  expect(queryResources).toHaveLength(4);
  expect(deliveryStatements).toContainEqual({
    Action: 'dynamodb:DeleteItem',
    Effect: 'Allow',
    Resource: {
      'Fn::GetAtt': [projectDirectoryTableId, 'Arn'],
    },
  });
  const webhookKmsStatements = deliveryStatements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(webhookKeyId)
  );
  expect(webhookKmsStatements).toEqual([{
    Action: 'kms:Decrypt',
    Condition: {
      StringEquals: {
        'kms:EncryptionContext:mukuroji:purpose': 'webhook',
        'kms:EncryptionContext:mukuroji:service': 'developer-platform',
      },
    },
    Effect: 'Allow',
    Resource: {
      'Fn::GetAtt': [webhookKeyId, 'Arn'],
    },
  }]);
  expect(deliveryPolicies).toContain('kms:Decrypt');
  expect(deliveryPolicies).not.toContain('"kms:Encrypt"');
  expect(deliveryPolicies).not.toContain('kms:GenerateDataKey');
  expect(deliveryPolicies).toContain('sqs:ReceiveMessage');
  expect(deliveryPolicies).toContain('sqs:DeleteMessage');
  expect(deliveryPolicies).toContain('sqs:SendMessage');
  const projectionFunction = Object.values(resources).find((resource) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Projects audit outbox events into collaboration, Webhook, and connector deliveries.'
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

  expect(template.toJSON().Outputs).not.toHaveProperty('WebhookProjectionDlqUrl');
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
  const developerPlatformTableId =
    template.toJSON().Outputs.DeveloperPlatformTableName?.Value?.Ref;
  const enterpriseIdentityTableId =
    template.toJSON().Outputs.EnterpriseIdentityTableName?.Value?.Ref;
  const planningTableId =
    template.toJSON().Outputs.PlanningTableName?.Value?.Ref;
  const workItemConfigurationTableId =
    template.toJSON().Outputs.WorkItemConfigurationTableName?.Value?.Ref;
  const workspaceAccessTableId =
    template.toJSON().Outputs.WorkspaceAccessTableName?.Value?.Ref;
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
  const pollDlqId = findResourceId('ConnectorPollDlq', 'AWS::SQS::Queue');
  const projectionFunctionId = findResourceId(
    'CollaborationProjectionFunction',
    'AWS::Lambda::Function',
  );
  const workerFunctionId = findResourceId('ConnectorSyncFunction', 'AWS::Lambda::Function');
  const pollFunctionId = findResourceId('ConnectorPollFunction', 'AWS::Lambda::Function');
  const connectorKeyId = findResourceId(
    'DeveloperPlatformConnectorKey',
    'AWS::KMS::Key',
  );
  const stateKeyId = findResourceId(
    'DeveloperPlatformStateKey',
    'AWS::KMS::Key',
  );

  expect(secretId).toBeDefined();
  expect(configurationKeyId).toBeDefined();
  expect(queueId).toBeDefined();
  expect(dlqId).toBeDefined();
  expect(pollDlqId).toBeDefined();
  expect(projectionFunctionId).toBeDefined();
  expect(workerFunctionId).toBeDefined();
  expect(pollFunctionId).toBeDefined();
  expect(connectorKeyId).toBeDefined();
  expect(stateKeyId).toBeDefined();
  expect(typeof developerPlatformTableId).toBe('string');
  expect(typeof enterpriseIdentityTableId).toBe('string');
  expect(typeof planningTableId).toBe('string');
  expect(typeof workItemConfigurationTableId).toBe('string');
  expect(typeof workspaceAccessTableId).toBe('string');
  expect(Object.keys(resources).some((logicalId) =>
    logicalId.startsWith('ConnectorAuditProjectionFunction')
  )).toBe(false);
  if (
    !secretId ||
    !configurationKeyId ||
    !queueId ||
    !dlqId ||
    !pollDlqId ||
    !projectionFunctionId ||
    !workerFunctionId ||
    !pollFunctionId ||
    !connectorKeyId ||
    !stateKeyId ||
    typeof developerPlatformTableId !== 'string' ||
    typeof enterpriseIdentityTableId !== 'string' ||
    typeof planningTableId !== 'string' ||
    typeof workItemConfigurationTableId !== 'string' ||
    typeof workspaceAccessTableId !== 'string'
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
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1209600,
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
        maxReceiveCount: 5,
      },
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 30 * 60,
    }),
  }));
  expect(resources[dlqId]).toEqual(expect.objectContaining({
    Type: 'AWS::SQS::Queue',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    }),
  }));
  expect(resources[pollDlqId]).toEqual(expect.objectContaining({
    Type: 'AWS::SQS::Queue',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    }),
  }));

  for (const [description, handler, timeout, runtimeRole] of [
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
      'Projects audit outbox events into collaboration, Webhook, and connector deliveries.',
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        CONNECTOR_SYNC_QUEUE_URL: { Ref: queueId },
        MUKUROJI_RUNTIME_ROLE: 'audit-projection',
      }),
    },
  });
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
        ENTERPRISE_IDENTITY_TABLE_NAME: {
          Ref: enterpriseIdentityTableId,
        },
        PLANNING_TABLE_NAME: {
          Ref: planningTableId,
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
  template.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Schedules bounded connector polling for providers without push events.',
    ScheduleExpression: 'rate(5 minutes)',
    State: 'ENABLED',
    Targets: Match.arrayWith([
      Match.objectLike({
        Arn: { 'Fn::GetAtt': [pollFunctionId, 'Arn'] },
        DeadLetterConfig: {
          Arn: { 'Fn::GetAtt': [pollDlqId, 'Arn'] },
        },
        RetryPolicy: {
          MaximumEventAgeInSeconds: 3600,
          MaximumRetryAttempts: 2,
        },
      }),
    ]),
  });
  expect(Object.values(resources)).toContainEqual(expect.objectContaining({
    Type: 'AWS::Lambda::EventInvokeConfig',
    Properties: expect.objectContaining({
      DestinationConfig: {
        OnFailure: {
          Destination: { 'Fn::GetAtt': [pollDlqId, 'Arn'] },
        },
      },
      FunctionName: { Ref: pollFunctionId },
      MaximumRetryAttempts: 2,
    }),
  }));

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
  const projectionPolicyResources = policiesForFunction(projectionFunctionId);
  const workerPolicyResources = policiesForFunction(workerFunctionId);
  const pollPolicyResources = policiesForFunction(pollFunctionId);
  const projectionPolicies = JSON.stringify(projectionPolicyResources);
  const workerPolicies = JSON.stringify(workerPolicyResources);
  const pollPolicies = JSON.stringify(pollPolicyResources);
  const workerStatements = workerPolicyResources.flatMap((policy) =>
    (policy as {
      Properties?: {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
      };
    }).Properties?.PolicyDocument?.Statement ?? []
  );
  const pollStatements = pollPolicyResources.flatMap((policy) =>
    (policy as {
      Properties?: {
        PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
      };
    }).Properties?.PolicyDocument?.Statement ?? []
  );
  const workerAuthorizationConditionStatement = workerStatements.find((statement) =>
    statement.Action === 'dynamodb:ConditionCheckItem'
  );
  const workerAuthorizationReadStatement = workerStatements.find((statement) =>
    Array.isArray(statement.Action) &&
    statement.Action.includes('dynamodb:GetItem') &&
    JSON.stringify(statement.Resource).includes(enterpriseIdentityTableId) &&
    JSON.stringify(statement.Resource).includes(planningTableId)
  );

  expect(projectionPolicies).toContain('AuditEventsTable0723963E');
  expect(projectionPolicies).toContain(queueId);
  expect(projectionPolicies).toContain('CollaborationProjectionDlqAF6DB4E6');
  expect(projectionPolicies).not.toContain('ConnectorRuntimeSecret');
  expect(projectionPolicies).not.toContain('DeveloperPlatformTable772E085C');
  expect(projectionPolicies).toContain('WebhookDeliveryQueue2A244492');
  expect(workerPolicies).toContain(secretId);
  expect(workerPolicies).toContain(queueId);
  expect(workerPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(workerPolicies).toContain('TeamIssuesTable189D851D');
  expect(workerPolicies).toContain('AuditEventsTable0723963E');
  expect(workerPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(workerAuthorizationConditionStatement).toEqual({
    Action: 'dynamodb:ConditionCheckItem',
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': [workspaceAccessTableId, 'Arn'] },
      { 'Fn::GetAtt': [planningTableId, 'Arn'] },
      { 'Fn::GetAtt': [enterpriseIdentityTableId, 'Arn'] },
      { 'Fn::GetAtt': [workItemConfigurationTableId, 'Arn'] },
    ]),
  });
  expect(
    workerAuthorizationConditionStatement?.Resource as unknown[] | undefined,
  ).toHaveLength(4);
  expect(workerAuthorizationReadStatement).toEqual(expect.objectContaining({
    Action: ['dynamodb:GetItem', 'dynamodb:Query'],
    Effect: 'Allow',
    Resource: expect.arrayContaining([
      { 'Fn::GetAtt': [planningTableId, 'Arn'] },
      { 'Fn::GetAtt': [enterpriseIdentityTableId, 'Arn'] },
    ]),
  }));
  expect(
    workerAuthorizationReadStatement?.Resource as unknown[] | undefined,
  ).toHaveLength(2);
  const workerSensitiveAuthorizationActions = workerStatements
    .filter((statement) => {
      const resources = JSON.stringify(statement.Resource);
      return resources.includes(enterpriseIdentityTableId) ||
        resources.includes(planningTableId);
    })
    .flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    );
  expect(workerSensitiveAuthorizationActions).not.toContain('dynamodb:BatchGetItem');
  expect(workerSensitiveAuthorizationActions).not.toContain('dynamodb:Scan');
  expect(workerPolicies).not.toContain('dynamodb:TransactWriteItems');
  expect(workerPolicies).toContain('kms:Decrypt');
  expect(workerPolicies).toContain('kms:GenerateDataKey');
  expect(workerPolicies).toContain('secretsmanager:GetSecretValue');
  for (const [keyId, purpose] of [
    [connectorKeyId, 'connector'],
    [stateKeyId, 'platform-state'],
  ]) {
    expect(workerStatements).toContainEqual({
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
  expect(pollPolicies).toContain(queueId);
  expect(pollPolicies).toContain(developerPlatformTableId);
  expect(pollPolicies).toContain('dynamodb:DeleteItem');
  expect(pollPolicies).toContain('dynamodb:GetItem');
  expect(pollPolicies).toContain('dynamodb:Query');
  const pollDeveloperPlatformStatements = pollStatements.filter((statement) =>
    JSON.stringify(statement.Resource).includes(developerPlatformTableId)
  );
  expect(pollDeveloperPlatformStatements).toEqual(expect.arrayContaining([
    {
      Action: ['dynamodb:DeleteItem', 'dynamodb:GetItem'],
      Effect: 'Allow',
      Resource: {
        'Fn::GetAtt': [developerPlatformTableId, 'Arn'],
      },
    },
    {
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
    },
  ]));
  expect(pollDeveloperPlatformStatements).toHaveLength(2);
  expect(pollPolicies).not.toContain('/index/*');
  expect(pollPolicies).not.toContain('"Resource":"*"');
  expect(pollPolicies).not.toContain('dynamodb:Scan');
  expect(pollPolicies).not.toContain(secretId);
  expect(pollPolicies).not.toContain('secretsmanager:GetSecretValue');
  expect(pollPolicies).not.toContain('TeamIssuesTable189D851D');
  expect(pollPolicies).not.toContain('AuditEventsTable0723963E');
  expect(pollPolicies).not.toContain('DeveloperPlatformConnectorKey');

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects connector projection or sync jobs that exhausted queue redrive retries.',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Threshold: 1,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects scheduled connector polling invocations that exhausted EventBridge retries.',
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
  template.hasOutput('ConnectorPollDlqUrl', {
    Value: { Ref: pollDlqId },
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
  template.resourceCountIs('AWS::SQS::Queue', 15);
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
        MUKUROJI_RUNTIME_ROLE: 'automation-event-worker',
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
        MUKUROJI_RUNTIME_ROLE: 'automation-schedule-worker',
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
  const eventConditionCheckPolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('AutomationEventTransactWritePolicy')
  )?.[1];
  const scheduleConditionCheckPolicy = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith('AutomationScheduleTransactWritePolicy')
  )?.[1];
  for (const [policy, conditionCheckPolicy] of [
    [eventPolicy, eventConditionCheckPolicy],
    [schedulePolicy, scheduleConditionCheckPolicy],
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
    const conditionCheckStatements = (conditionCheckPolicy as {
      Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
    } | undefined)?.Properties?.PolicyDocument?.Statement ?? [];
    const conditionCheckStatement = conditionCheckStatements.find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('dynamodb:ConditionCheckItem');
    });
    expect(conditionCheckStatement).toEqual(expect.objectContaining({
      Action: 'dynamodb:ConditionCheckItem',
      Condition: {
        'ForAnyValue:StringEquals': {
          'dynamodb:EnclosingOperation': ['TransactWriteItems'],
        },
      },
      Effect: 'Allow',
      Resource: expect.arrayContaining([
        { 'Fn::GetAtt': ['AutomationTableE3D67F0D', 'Arn'] },
        { 'Fn::GetAtt': ['FileProofingTable81DA272F', 'Arn'] },
        { 'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'] },
        { 'Fn::GetAtt': ['TeamIssuesTable189D851D', 'Arn'] },
        { 'Fn::GetAtt': ['WorkspaceSearchTable2575AD6B', 'Arn'] },
      ]),
    }));
    expect(JSON.stringify(conditionCheckStatement)).not.toContain(
      'AuditEventsTable0723963E',
    );
    expect(JSON.stringify(conditionCheckStatement)).not.toContain(
      'TeamIssueEventsTable',
    );
    expect(JSON.stringify([policy, conditionCheckPolicy]))
      .not.toContain('dynamodb:TransactWriteItems');
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
      { 'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceAccessTableD7C8D2C7', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemCollaborationTableFDECF217', 'Arn'] },
      { 'Fn::GetAtt': ['DocumentsTable7E808EE5', 'Arn'] },
      { 'Fn::GetAtt': ['FileProofingTable81DA272F', 'Arn'] },
      { 'Fn::GetAtt': ['WorkItemConfigurationTable35E94558', 'Arn'] },
      { 'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'] },
      { 'Fn::GetAtt': [enterpriseIdentityTableLogicalId, 'Arn'] },
      { 'Fn::GetAtt': ['WorkspaceSearchTable2575AD6B', 'Arn'] },
    ]),
  }));
  expect(JSON.stringify(transactionConditionCheckStatement))
    .not.toContain('AutomationTableE3D67F0D');
  expect(JSON.stringify(transactionConditionCheckStatement)).not.toContain(
    developerPlatformTableId,
  );
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
  expect(JSON.stringify(transactionConditionCheckStatement))
    .not.toContain('ProjectTasksTableE21F6637');
  expect(JSON.stringify(transactionConditionCheckStatement)).toContain('FileProofingTable');
  expect(serializedApiPolicies).not.toContain('dynamodb:TransactWriteItems');
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
    'dynamodb:DescribeTable',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
  ]));
  const enterpriseIdentityActions = enterpriseIdentityStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  );
  expect(enterpriseIdentityActions).toEqual(expect.arrayContaining([
    'dynamodb:BatchWriteItem',
    'dynamodb:ConditionCheckItem',
    'dynamodb:DeleteItem',
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
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:ListUsers');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:DescribeIdentityProvider');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:DescribeUserPoolClient');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminDeleteUserAttributes');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminDisableUser');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminEnableUser');
  expect(JSON.stringify(cognitoStatement)).toContain('cognito-idp:AdminUserGlobalSignOut');
  expect(JSON.stringify(cognitoStatement)).toContain('CognitoUserPoolId');
  const wildcardStatements = statements.filter((statement) => statement.Resource === '*');
  expect(wildcardStatements).toEqual([]);
  expect(serializedApiPolicies).not.toContain('"Action":"s3:*"');
  expect(JSON.stringify(cognitoStatement)).not.toContain('"Resource":"*"');
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
  expect(createPayload).toContain('WEBHOOK_TEAM_GRANT#');
  expect(createPayload).toContain('WEBHOOK_ACL#TEAM_MEMBER#');
  expect(createPayload.match(/":role":\{"S":"manager"\}/g)).toHaveLength(4);
  expect(createPayload.match(/":timestamp":\{"S":"2026-07-11T00:00:00.000Z"\}/g)).toHaveLength(5);
  expect(createPayload.match(/"Update"/g)).toHaveLength(7);
  expect(createPayload.match(/"Put"/g)).toHaveLength(10);
  expect(createPayload.match(/"entryType":\{"S":"webhook-team-grant"\}/g))
    .toHaveLength(5);
  expect(createPayload.match(
    /"entryType":\{"S":"webhook-team-grant-cleanup"\}/g,
  )).toHaveLength(5);
  expect(createPayload.match(/"teamSourceEntryKey"/g)).toHaveLength(5);
  expect(createPayload.match(/"projectSourceEntryKey"/g)).toHaveLength(5);
  expect(createPayload).toContain(
    '"teamSourceEntryKey":{"S":"000010#000000#TEAM#core-team"}',
  );
  expect(createPayload).toContain(
    '"projectSourceEntryKey":{"S":"000010#000030#PROJECT#shared-launch"}',
  );
  expect(createPayload).toContain(
    '"teamSourceEntryKey":{"S":"000020#000000#TEAM#design-team"}',
  );
  expect(createPayload).toContain(
    '"projectSourceEntryKey":{"S":"000020#000010#PROJECT#shared-launch"}',
  );
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
      itemActions: ['dynamodb:PutItem'],
      tableOutputName: 'ProjectDirectoryTableName',
      physicalResourceId: 'project-directory-seed-v3',
      runsOnUpdate: false,
    },
    {
      customResourcePrefix: 'SeedWorkspaceAccess',
      policyPrefix: 'SeedWorkspaceAccessCustomResourcePolicy',
      itemActions: ['dynamodb:UpdateItem'],
      tableOutputName: 'WorkspaceAccessTableName',
      physicalResourceId: 'workspace-access-seed-v2',
      runsOnUpdate: true,
    },
    {
      customResourcePrefix: 'BootstrapWorkspace',
      policyPrefix: 'BootstrapWorkspaceCustomResourcePolicy',
      itemActions: ['dynamodb:UpdateItem', 'dynamodb:PutItem'],
      tableOutputName: 'ProjectDirectoryTableName',
      physicalResourceId: 'workspace-bootstrap-v2',
      runsOnUpdate: true,
    },
    {
      customResourcePrefix: 'SeedWorkspaceDemoMembers',
      policyPrefix: 'SeedWorkspaceDemoMembersCustomResourcePolicy',
      itemActions: ['dynamodb:UpdateItem'],
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
      (Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action]
      ).some((action) =>
        transactionCase.itemActions.some((expected) => expected === action)
      ),
    );

    expect(itemActionStatements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    )).toEqual(expect.arrayContaining([...transactionCase.itemActions]));
    expect(JSON.stringify(statements)).not.toContain('dynamodb:TransactWriteItems');
    for (const statement of itemActionStatements) {
      expect(statement).toEqual(expect.objectContaining({
        Condition: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
        Effect: 'Allow',
        Resource: tableArn,
      }));
    }
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
  expect(JSON.stringify(canonicalWorkItemSeedPolicy))
    .not.toContain('dynamodb:TransactWriteItems');
  expect(JSON.stringify(canonicalWorkItemSeedPolicy)).not.toContain('ProjectTasksTableE21F6637');
  expect(directoryPayload).toContain('WorkspaceDirectoryId');
  expect(directoryPayload.match(/"teamSourceEntryKey"/g)).toHaveLength(2);
  expect(directoryPayload.match(/"projectSourceEntryKey"/g)).toHaveLength(2);
  expect(directoryPayload).toContain(
    '"teamSourceEntryKey":{"S":"000010#000000#TEAM#core-team"}',
  );
  expect(directoryPayload).toContain(
    '"projectSourceEntryKey":{"S":"000010#000010#PROJECT#refero"}',
  );
  expect(workItemPayload).not.toContain('user#demo@example.com');
  expect(directoryPayload).not.toContain('user#demo@example.com');
  expect(canonicalWorkItemSeed?.Properties.Update).toBeUndefined();
  expect(projectDirectorySeed?.Properties.Update).toBeUndefined();
});

test('bootstrap payload builders preserve deterministic keys, conditions, and idempotency', () => {
  const workspaceAccess = createWorkspaceAccessTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
    'owner@example.com',
  );
  const workspaceMembers = createWorkspaceDemoMemberTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
  );
  const canonicalWorkItems = createCanonicalWorkItemTransactItems('WorkItemsTable', 'directory-1');
  const directoryItems = createProjectDirectoryTransactItems('DirectoryTable', 'directory-1');
  const workspaceBootstrap = createWorkspaceBootstrapTransactItems(
    'DirectoryTable',
    'directory-1',
    'owner@example.com',
    'owner',
  );

  expect(workspaceAccess).toHaveLength(2);
  expect(workspaceAccess[0].Update.Key).toEqual({
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: 'WORKSPACE' },
  });
  expect(workspaceAccess[1].Update.Key).toEqual({
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: 'MEMBER#owner@example.com' },
  });
  expect(workspaceAccess.every(({ Update }) =>
    Update.ConditionExpression?.includes('attribute_not_exists(workspaceId)') &&
    Update.UpdateExpression.includes('if_not_exists') &&
    Update.ExpressionAttributeValues?.[':createdAt']?.S === '2026-07-11T00:00:00.000Z' &&
    Update.ExpressionAttributeValues?.[':updatedAt']?.S === '2026-07-11T00:00:00.000Z',
  )).toBe(true);
  expect(workspaceAccess).toEqual(createWorkspaceAccessTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
    'owner@example.com',
  ));

  expect(workspaceMembers).toHaveLength(5);
  expect(workspaceMembers.map(({ Update }) => Update.Key.recordKey)).toEqual([
    { S: 'MEMBER#sato@example.com' },
    { S: 'MEMBER#suzuki@example.com' },
    { S: 'MEMBER#tanaka@example.com' },
    { S: 'MEMBER#yamamoto@example.com' },
    { S: 'MEMBER#viewer@example.com' },
  ]);
  expect(workspaceMembers.every(({ Update }) =>
    Update.ConditionExpression?.includes('memberKey = :memberKey') &&
    Update.UpdateExpression.includes('if_not_exists') &&
    Update.ExpressionAttributeValues?.[':createdAt']?.S === '2026-07-11T00:00:00.000Z' &&
    Update.ExpressionAttributeValues?.[':updatedAt']?.S === '2026-07-11T00:00:00.000Z',
  )).toBe(true);
  expect(workspaceMembers).toEqual(createWorkspaceDemoMemberTransactItems(
    'WorkspaceAccessTable',
    'workspace-1',
  ));

  expect(canonicalWorkItems).toHaveLength(10);
  expect(canonicalWorkItems.every(({ Put }) =>
    Put.ConditionExpression === 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)' &&
    Put.Item.directoryId.S === 'directory-1' &&
    Put.Item.createdAt.S === '2026-06-01T00:00:00.000Z' &&
    Put.Item.updatedAt.S === '2026-06-01T00:00:00.000Z',
  )).toBe(true);
  expect(canonicalWorkItems).toEqual(createCanonicalWorkItemTransactItems('WorkItemsTable', 'directory-1'));

  expect(directoryItems).toHaveLength(9);
  expect(directoryItems.every(({ Put }) =>
    Put.ConditionExpression === 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)' &&
    Put.Item.directoryId.S === 'directory-1',
  )).toBe(true);
  expect(directoryItems.filter(({ Put }) => Put.Item.entryType.S === 'project-member').every(({ Put }) => {
    const item = Put.Item as Record<string, { S?: string }>;

    return item.createdAt?.S === '2026-06-08T00:00:00.000Z' &&
      item.updatedAt?.S === '2026-06-08T00:00:00.000Z';
  })).toBe(true);
  expect(directoryItems).toEqual(createProjectDirectoryTransactItems('DirectoryTable', 'directory-1'));

  expect(workspaceBootstrap).toHaveLength(7);
  expect(workspaceBootstrap.every(({ Update }) =>
    Update.ConditionExpression?.includes('attribute_not_exists(directoryId)') &&
    !('Item' in Update),
  )).toBe(true);
  expect(workspaceBootstrap.filter(({ Update }) => {
    const values = Update.ExpressionAttributeValues as Record<string, { S?: string }>;

    return values[':timestamp'] !== undefined;
  }).every(({ Update }) => {
    const values = Update.ExpressionAttributeValues as Record<string, { S?: string }>;

    return Update.UpdateExpression.includes('if_not_exists') &&
      values[':timestamp']?.S === '2026-07-11T00:00:00.000Z';
  })).toBe(true);
  expect(workspaceBootstrap).toEqual(createWorkspaceBootstrapTransactItems(
    'DirectoryTable',
    'directory-1',
    'owner@example.com',
    'owner',
  ));
});
