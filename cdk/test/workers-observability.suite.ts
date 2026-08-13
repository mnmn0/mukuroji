/** Registers asynchronous worker and observability tests. */
import { Match } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import {
  API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  expectQueueRequiresSsl,
  findApiRuntimeConfigurationSource,
  synthesizedTemplate,
} from './test-support';

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
      Environment: expect.objectContaining({
        Variables: expect.objectContaining({
          ENTERPRISE_IDENTITY_TABLE_NAME: { Ref: tableLogicalId },
        }),
      }),
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
          TENANT_ADMINISTRATION_TABLE_NAME: {
            Ref: 'TenantAdministrationTable621D59EB',
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
  expect(actionsForTable('PlanningTable2A0D4CC5')).toEqual([
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
  ]);
  expect(actionsForTable('DocumentsTable7E808EE5')).toEqual([
    'dynamodb:DescribeTable',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
  ]);
  expect(actionsForTable('AuditEventsTable0723963E')).toEqual([
    'dynamodb:PutItem',
  ]);
  expect(actionsForTable('TenantAdministrationTable621D59EB')).toEqual([
    'dynamodb:ConditionCheckItem',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
  ]);
  const tenantTransactionStatement = roleStatements.find((statement) => {
    const actions = Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action];
    return actions.includes('dynamodb:ConditionCheckItem') &&
      actions.includes('dynamodb:PutItem') &&
      JSON.stringify(statement.Resource).includes(
        'TenantAdministrationTable621D59EB',
      );
  });
  expect(tenantTransactionStatement).toEqual({
    Action: ['dynamodb:ConditionCheckItem', 'dynamodb:PutItem'],
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
    Resource: {
      'Fn::GetAtt': ['TenantAdministrationTable621D59EB', 'Arn'],
    },
  });
  expect(actionsForTable('TeamIssuesTable189D851D')).toEqual([
    'dynamodb:DescribeTable',
  ]);
  expect(serializedPolicies).toContain('dynamodb:ConditionCheckItem');
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

test('analytics scheduled delivery reauthorizes source data without consuming the audit stream', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const analyticsTableLogicalId = template.toJSON().Outputs.AnalyticsTableName?.Value?.Ref;
  const auditTableLogicalId = template.toJSON().Outputs.AuditEventsTableName?.Value?.Ref;
  const projectDirectoryTableLogicalId =
    template.toJSON().Outputs.ProjectDirectoryTableName?.Value?.Ref;
  const workItemsTableLogicalId = template.toJSON().Outputs.WorkItemsTableName?.Value?.Ref;
  const tenantAdministrationTableLogicalId =
    template.toJSON().Outputs.TenantAdministrationTableName?.Value?.Ref;
  const workspaceAccessTableLogicalId =
    template.toJSON().Outputs.WorkspaceAccessTableName?.Value?.Ref;

  expect(typeof analyticsTableLogicalId).toBe('string');
  expect(typeof auditTableLogicalId).toBe('string');
  expect(typeof projectDirectoryTableLogicalId).toBe('string');
  expect(typeof workItemsTableLogicalId).toBe('string');
  expect(typeof tenantAdministrationTableLogicalId).toBe('string');
  expect(typeof workspaceAccessTableLogicalId).toBe('string');
  if (
    typeof analyticsTableLogicalId !== 'string' ||
    typeof auditTableLogicalId !== 'string' ||
    typeof projectDirectoryTableLogicalId !== 'string' ||
    typeof workItemsTableLogicalId !== 'string' ||
    typeof tenantAdministrationTableLogicalId !== 'string' ||
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
        TENANT_ADMINISTRATION_TABLE_NAME: { Ref: tenantAdministrationTableLogicalId },
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
  expect(serializedSchedulePolicies).toContain(tenantAdministrationTableLogicalId);
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
  expect(new Set(actionsForResource(tenantAdministrationTableLogicalId))).toEqual(
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

  expect(auditStreamMappings.some((resource) =>
    JSON.stringify(resource).includes('AnalyticsScheduleFunction')
  )).toBe(false);
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
  const tenantAdministrationTableId =
    outputs.TenantAdministrationTableName?.Value?.Ref;
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
  expect(typeof tenantAdministrationTableId).toBe('string');
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
        TENANT_ADMINISTRATION_TABLE_NAME: { Ref: tenantAdministrationTableId },
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
  expect(serializedWorkerPolicy).toContain(String(tenantAdministrationTableId));
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
      {
        'Fn::GetAtt': [
          'WorkspaceSearchMigrationStateTable34132530',
          'Arn',
        ],
      },
    ]),
  });
  expect(
    (authorizationConditionStatement?.Resource as unknown[] | undefined),
  ).toHaveLength(5);
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

test('audit stream isolates downstream delivery and retention consumers', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const enterpriseIdentityTableId = template.toJSON().Outputs
    .EnterpriseIdentityTableName?.Value?.Ref;

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
        ENTERPRISE_IDENTITY_TABLE_NAME: {
          Ref: enterpriseIdentityTableId,
        },
        FILE_BUCKET_NAME: Match.anyValue(),
        FILE_PROOFING_TABLE_NAME: Match.anyValue(),
        NOTIFICATIONS_TABLE_NAME: {
          Ref: 'NotificationsTable76DCFC6C',
        },
        PLANNING_TABLE_NAME: {
          Ref: 'PlanningTable2A0D4CC5',
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
        TENANT_ADMINISTRATION_TABLE_NAME: {
          Ref: 'TenantAdministrationTable621D59EB',
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
  expect(serializedProjectionPolicy).toContain(String(enterpriseIdentityTableId));
  expect(serializedProjectionPolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedProjectionPolicy).toContain('PlanningTable2A0D4CC5');
  expect(serializedProjectionPolicy).toContain('TenantAdministrationTable621D59EB');
  expect(serializedProjectionPolicy).not.toContain('DeveloperPlatformTable772E085C');
  expect(serializedProjectionPolicy).not.toContain('LookupKeyIndex');
  expect(serializedProjectionPolicy).toContain('WebhookDeliveryQueue2A244492');
  expect(serializedProjectionPolicy).toContain('ConnectorSyncQueue4F8E52D0');
  expect(serializedProjectionPolicy).not.toContain('dynamodb:TransactWriteItems');
  expect(actionsForProjectionTable('NotificationsTable76DCFC6C'))
    .toContain('dynamodb:PutItem');
  expect(actionsForProjectionTable('ProcessedAuditEventsTableFF485133'))
    .toContain('dynamodb:PutItem');
  expect(actionsForProjectionTable('PlanningTable2A0D4CC5'))
    .toContain('dynamodb:GetItem');
  expect(actionsForProjectionTable(String(enterpriseIdentityTableId)))
    .toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query']));
  expect(actionsForProjectionTable('TeamIssuesTable189D851D'))
    .toContain('dynamodb:ConditionCheckItem');
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
  expect(auditStreamMappings).toHaveLength(3);
  expect(auditStreamMappings.map(({ Properties }) => Properties.FunctionName.Ref).sort())
    .toEqual([
      'AutomationEventFunction5E8CB543',
      'CollaborationProjectionFunction1AAC5764',
      'TenantOperationFunction9BEB780E',
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
      TENANT_ADMINISTRATION_TABLE_NAME: {
        Ref: 'TenantAdministrationTable621D59EB',
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
      'ApiLiveAlias3A796568',
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
  expect(deliveryPolicies).toContain('TenantAdministrationTable621D59EB');
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
    {
      'Fn::GetAtt': ['TenantAdministrationTable621D59EB', 'Arn'],
    },
    { 'Fn::GetAtt': [workspaceAccessTableId, 'Arn'] },
    {
      'Fn::GetAtt': [
        'WorkspaceSearchMigrationStateTable34132530',
        'Arn',
      ],
    },
  ]));
  expect(getItemResources).toHaveLength(7);
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
    Action: [
      'dynamodb:ListStreams',
      'xray:PutTelemetryRecords',
      'xray:PutTraceSegments',
    ],
    Effect: 'Allow',
    Resource: '*',
  }]);
  const deliveryWildcardStatements = policiesForRole(deliveryRoleId).flatMap((resource) =>
    (
      resource as {
        Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
      }
    ).Properties.PolicyDocument.Statement.filter((statement) => statement.Resource === '*')
  );
  expect(deliveryWildcardStatements).toEqual([{
    Action: ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'],
    Effect: 'Allow',
    Resource: '*',
  }]);

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
          TENANT_ADMINISTRATION_TABLE_NAME: {
            Ref: 'TenantAdministrationTable621D59EB',
          },
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
  const dataConfigurationSecretId =
    API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID;
  const dataConfiguration = resources[dataConfigurationSecretId]
    .Properties.SecretString;
  expect(findApiRuntimeConfigurationSource(
    dataConfiguration,
    'CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN',
  )).toEqual({
      'Fn::Base64': { Ref: secretId },
    });
  const apiFunction = Object.values(resources).find((resource) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.'
  ) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
  expect(apiFunction.Properties.Environment.Variables).toEqual(
    expect.objectContaining({
      MUKUROJI_API_DATA_CONFIG_SECRET_ARN: {
        Ref: dataConfigurationSecretId,
      },
    }),
  );
  expect(apiFunction.Properties.Environment.Variables)
    .not.toHaveProperty('CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN');
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
  expect(projectionPolicies).toContain('TenantAdministrationTable621D59EB');
  expect(workerPolicies).toContain(secretId);
  expect(workerPolicies).toContain(queueId);
  expect(workerPolicies).toContain('DeveloperPlatformTable772E085C');
  expect(workerPolicies).toContain('TeamIssuesTable189D851D');
  expect(workerPolicies).toContain('AuditEventsTable0723963E');
  expect(workerPolicies).toContain('WorkspaceAccessTableD7C8D2C7');
  expect(workerPolicies).toContain('TenantAdministrationTable621D59EB');
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
      {
        'Fn::GetAtt': [
          'WorkspaceSearchMigrationStateTable34132530',
          'Arn',
        ],
      },
    ]),
  });
  expect(
    workerAuthorizationConditionStatement?.Resource as unknown[] | undefined,
  ).toHaveLength(5);
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
  expect(pollPolicies).toContain('TenantAdministrationTable621D59EB');
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
  expect(
    pollStatements.filter((statement) => statement.Resource === '*'),
  ).toEqual([{
    Action: ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'],
    Effect: 'Allow',
    Resource: '*',
  }]);
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
    Description:
      'Emits deterministic Work Item and Planning health update notification events.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 300,
    Environment: {
      Variables: Match.objectLike({
        AUDIT_EVENTS_TABLE_NAME: { Ref: 'AuditEventsTable0723963E' },
        AUDIT_RETENTION_DAYS: { Ref: 'AuditRetentionDays' },
        NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
        NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
        PLANNING_TABLE_NAME: { Ref: 'PlanningTable2A0D4CC5' },
        PLANNING_UPDATE_SCHEDULE_INDEX_NAME: 'UpdateScheduleDueIndex',
        PROJECT_DIRECTORY_TABLE_NAME: { Ref: 'ProjectDirectoryTable9ED01C01' },
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
  template.resourceCountIs('AWS::SQS::Queue', 26);
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
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects failures while Lambda delivers notification schedule failures to the DLQ.',
    MetricName: 'DestinationDeliveryFailures',
    Namespace: 'AWS/Lambda',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Description:
      'Checks canonical Work Items and Planning update targets for scheduled notifications.',
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
  const scheduleStatements = (
    schedulePolicy as {
      Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
    } | undefined
  )?.Properties?.PolicyDocument?.Statement ?? [];
  const planningUpdateStatement = scheduleStatements.find((statement) =>
    JSON.stringify(statement.Resource).includes('PlanningTable2A0D4CC5') &&
    JSON.stringify(statement.Action).includes('dynamodb:UpdateItem')
  );

  expect(serializedSchedulePolicy).toContain('TeamIssuesTable189D851D');
  expect(serializedSchedulePolicy).toContain('PlanningTable2A0D4CC5');
  expect(serializedSchedulePolicy).toContain('UpdateScheduleDueIndex');
  expect(serializedSchedulePolicy).toContain('ProjectDirectoryTable9ED01C01');
  expect(serializedSchedulePolicy).toContain('AuditEventsTable0723963E');
  expect(serializedSchedulePolicy).toContain('dynamodb:Scan');
  expect(serializedSchedulePolicy).toContain('dynamodb:GetItem');
  expect(serializedSchedulePolicy).toContain('dynamodb:Query');
  expect(serializedSchedulePolicy).toContain('dynamodb:UpdateItem');
  expect(serializedSchedulePolicy).toContain('dynamodb:PutItem');
  expect(serializedSchedulePolicy).toContain('sqs:SendMessage');
  expect(planningUpdateStatement?.Condition).toEqual({
    'ForAllValues:StringEquals': {
      'dynamodb:Attributes': [
        'workspaceId',
        'recordKey',
        'nextNotificationAtRecordKey',
        'updateScheduleShard',
        'updatedAt',
      ],
    },
  });
  template.hasOutput('NotificationScheduleDlqUrl', {});
});

test('application Lambdas emit active X-Ray traces and critical DLQs survive replacement', () => {
  const template = synthesizedTemplate;
  const queues = template.findResources('AWS::SQS::Queue');

  template.resourcePropertiesCountIs('AWS::Lambda::Function', {
    TracingConfig: { Mode: 'Active' },
  }, 29);

  for (const logicalIdPrefix of [
    'CollaborationProjectionDlq',
    'AutomationEventDlq',
    'AutomationScheduleDlq',
    'AnalyticsScheduleDlq',
    'NotificationScheduleDlq',
    'TriageScheduleDlq',
    'EnterpriseScimGroupJobDlq',
    'EnterpriseIdentityMaintenanceDlq',
    'TenantOperationDlq',
  ]) {
    const queueEntry = Object.entries(queues).find(([logicalId]) =>
      logicalId.startsWith(logicalIdPrefix)
    );
    expect(queueEntry).toBeDefined();
    if (!queueEntry) {
      throw new Error(`${logicalIdPrefix} was not synthesized.`);
    }
    expect(queueEntry[1]).toEqual(expect.objectContaining({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
        SqsManagedSseEnabled: true,
      }),
    }));
  }
});

test('tenant retention worker can query and reconcile only tenant and audit stores', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const policy = Object.entries(resources).find(([logicalId, resource]) =>
    logicalId.startsWith('TenantOperationFunctionServiceRoleDefaultPolicy') &&
    (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
  )?.[1] as {
    Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
  } | undefined;
  const statements = policy?.Properties?.PolicyDocument?.Statement ?? [];
  const auditStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource).includes('AuditEventsTable0723963E')
  );
  const tenantStatement = statements.find((statement) =>
    JSON.stringify(statement.Resource).includes('TenantAdministrationTable621D59EB')
  );

  expect(auditStatement).toEqual(expect.objectContaining({
    Effect: 'Allow',
    Action: expect.arrayContaining([
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
      'dynamodb:PutItem',
    ]),
  }));
  expect(tenantStatement).toEqual(expect.objectContaining({
    Effect: 'Allow',
    Action: expect.arrayContaining([
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
    ]),
  }));
  expect(JSON.stringify(policy)).not.toContain('secretsmanager:');
  expect(JSON.stringify(policy)).not.toContain('s3:');

  const mappings = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::Lambda::EventSourceMapping' &&
    JSON.stringify(resource).includes('TenantOperationFunction9BEB780E')
  ) as Array<{
    Properties?: {
      EventSourceArn?: unknown;
      FilterCriteria?: { Filters?: Array<{ Pattern?: string }> };
    };
  }>;
  expect(mappings).toHaveLength(2);
  const tenantMapping = mappings.find((mapping) =>
    JSON.stringify(mapping.Properties?.EventSourceArn)
      .includes('TenantAdministrationTable621D59EB')
  );
  const auditMapping = mappings.find((mapping) =>
    JSON.stringify(mapping.Properties?.EventSourceArn)
      .includes('AuditEventsTable0723963E')
  );
  expect(tenantMapping).toBeDefined();
  expect(auditMapping).toBeDefined();
  expect(JSON.stringify(tenantMapping?.Properties?.FilterCriteria))
    .toContain('\\\"eventName\\\":[\\\"INSERT\\\",\\\"MODIFY\\\"]');
  expect(JSON.stringify(auditMapping?.Properties?.FilterCriteria))
    .toContain('\\\"eventName\\\":[\\\"INSERT\\\"]');
  const operationPattern = tenantMapping?.Properties?.FilterCriteria?.Filters
    ?.map(({ Pattern }) => Pattern ?? '')
    .find((pattern) => pattern.includes('operation'));
  expect(operationPattern).toContain('"eventName":["INSERT","MODIFY"]');
});

test('tenant lifecycle execution is split into queued environment-bound resource owners', () => {
  const document = synthesizedTemplate.toJSON();
  const resources = document.Resources;
  const capacityPlanningTableId =
    document.Outputs.CapacityPlanningTableName?.Value?.Ref;
  const focusTableId = document.Outputs.FocusTableName?.Value?.Ref;
  expect(typeof capacityPlanningTableId).toBe('string');
  expect(typeof focusTableId).toBe('string');
  if (typeof focusTableId !== 'string') {
    throw new Error('Focus table output was not synthesized.');
  }
  const specifications = [
    {
      functionId: 'TenantExportCapabilityFunction9B1A8023',
      outputId: 'TenantExportCapabilityFunctionName',
      executorId: 'executor:tenant-export',
      allowedSteps: 'snapshot,prepare-artifact,verify-artifact,export',
      owner: 'export',
      queuePrefix: 'TenantExportExecutionQueue',
    },
    {
      functionId: 'TenantAccessCapabilityFunction394667B9',
      outputId: 'TenantAccessCapabilityFunctionName',
      executorId: 'executor:tenant-access-revocation',
      allowedSteps: 'revoke-access',
      owner: 'access',
      queuePrefix: 'TenantAccessExecutionQueue',
    },
    {
      functionId: 'TenantIdentityCapabilityFunctionD1DC9097',
      outputId: 'TenantIdentityCapabilityFunctionName',
      executorId: 'executor:tenant-member-anonymization',
      allowedSteps: 'anonymize-members',
      owner: 'identity',
      queuePrefix: 'TenantIdentityExecutionQueue',
    },
    {
      functionId: 'TenantDataCapabilityFunction8F76A72C',
      outputId: 'TenantDataCapabilityFunctionName',
      executorId: 'executor:tenant-data-deletion',
      allowedSteps: 'delete-data',
      owner: 'data',
      queuePrefix: 'TenantDataExecutionQueue',
    },
    {
      functionId: 'TenantSecretsCapabilityFunctionAA395B2E',
      outputId: 'TenantSecretsCapabilityFunctionName',
      executorId: 'executor:tenant-secret-deletion',
      allowedSteps: 'delete-secrets',
      owner: 'secrets',
      queuePrefix: 'TenantSecretsExecutionQueue',
    },
    {
      functionId: 'TenantVerificationCapabilityFunctionFBC78F82',
      outputId: 'TenantVerificationCapabilityFunctionName',
      executorId: 'executor:tenant-closure-verification',
      allowedSteps: 'verify',
      owner: 'verification',
      queuePrefix: 'TenantVerificationExecutionQueue',
    },
  ];

  for (const specification of specifications) {
    const resource = resources[specification.functionId];
    expect(resource).toEqual(expect.objectContaining({
      Type: 'AWS::Lambda::Function',
      Properties: expect.objectContaining({
        Handler: 'index.resourceOwnerHandler',
        MemorySize: 512,
        ReservedConcurrentExecutions: 1,
        Runtime: 'nodejs22.x',
        Timeout: 300,
        Environment: expect.objectContaining({
          Variables: expect.objectContaining({
            TENANT_OPERATION_ALLOWED_STEPS: specification.allowedSteps,
            TENANT_OPERATION_EXECUTOR_ID: specification.executorId,
            TENANT_OPERATION_RESOURCE_OWNER: specification.owner,
            TENANT_OPERATION_RESOURCE_OWNER_QUEUE_URL: expect.anything(),
            CAPACITY_PLANNING_TABLE_NAME: { Ref: capacityPlanningTableId },
            FOCUS_TABLE_NAME: { Ref: focusTableId },
            AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX:
              'mukuroji/automation-inbound-webhooks',
            AUTOMATION_WEBHOOK_SECRET_PREFIX:
              'mukuroji/automation-webhooks',
            TENANT_OPERATION_PSEUDONYM_SECRET_ARN: {
              Ref: 'ApiWorkspaceAuditPseudonymValueSecretC16FD0F8',
            },
            WORK_ITEM_IMPORT_BUCKET_NAME: {
              Ref: 'WorkItemImportBucket14068778',
            },
          }),
        }),
      }),
    }));
    expect(document.Outputs[specification.outputId]?.Value).toEqual({
      Ref: specification.functionId,
    });
    expect(
      resource.Properties.Environment.Variables,
    ).not.toHaveProperty('MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY');

    const policy = Object.entries(resources).find(([logicalId]) =>
      logicalId.startsWith(
        `${specification.functionId.slice(0, -8)}ServiceRoleDefaultPolicy`,
      )
    )?.[1];
    const serializedPolicy = JSON.stringify(policy);
    const policyProperties = typeof policy === 'object' && policy !== null
      ? Reflect.get(policy, 'Properties')
      : undefined;
    const policyDocument = typeof policyProperties === 'object' && policyProperties !== null
      ? Reflect.get(policyProperties, 'PolicyDocument')
      : undefined;
    const policyStatements = typeof policyDocument === 'object' && policyDocument !== null
      ? Reflect.get(policyDocument, 'Statement')
      : undefined;
    const focusStatements = (Array.isArray(policyStatements)
      ? policyStatements.filter(
        (statement): statement is Record<string, unknown> =>
          typeof statement === 'object' && statement !== null && !Array.isArray(statement),
      )
      : [])
      .filter((statement) =>
        JSON.stringify(statement.Resource).includes(focusTableId)
      );
    const focusActions = focusStatements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    );
    expect(policy).toBeDefined();
    expect(serializedPolicy).toContain('TenantAdministrationTable621D59EB');
    expect(serializedPolicy).toContain('AuditEventsTable0723963E');
    expect(serializedPolicy).toContain('secretsmanager:GetSecretValue');
    if (specification.owner === 'secrets') {
      expect(serializedPolicy).toContain('secretsmanager:ListSecrets');
      expect(serializedPolicy).toContain('secretsmanager:DeleteSecret');
      expect(serializedPolicy).toContain('mukuroji/automation-webhooks/');
      expect(serializedPolicy).toContain('mukuroji/automation-inbound-webhooks/');
    } else if (specification.owner === 'verification') {
      expect(serializedPolicy).toContain('secretsmanager:ListSecrets');
      expect(serializedPolicy).not.toContain('secretsmanager:DeleteSecret');
    } else {
      expect(serializedPolicy).not.toContain('secretsmanager:ListSecrets');
      expect(serializedPolicy).not.toContain('secretsmanager:DeleteSecret');
    }
    if (specification.owner === 'export' || specification.owner === 'data') {
      expect(serializedPolicy).toContain('s3:');
      expect(serializedPolicy).toContain(String(capacityPlanningTableId));
      expect(serializedPolicy).toContain('WorkItemImportBucket14068778');
      if (specification.owner === 'export') {
        expect(serializedPolicy).toContain('s3:GetObjectVersion');
      } else {
        expect(serializedPolicy).toContain('s3:DeleteObjectVersion');
      }
    } else if (specification.owner === 'verification') {
      expect(serializedPolicy).toContain('s3:ListBucketVersions');
      expect(serializedPolicy).not.toContain('s3:DeleteObject');
      expect(serializedPolicy).toContain(String(capacityPlanningTableId));
      expect(serializedPolicy).toContain('WorkItemImportBucket14068778');
    } else {
      expect(serializedPolicy).not.toContain('s3:');
      expect(serializedPolicy).not.toContain('WorkItemImportBucket14068778');
    }
    if (
      specification.owner === 'export' ||
      specification.owner === 'data' ||
      specification.owner === 'verification'
    ) {
      expect(focusStatements).toHaveLength(1);
      expect(focusActions).toEqual(expect.arrayContaining([
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ]));
      if (specification.owner === 'data') {
        expect(focusActions).toEqual(expect.arrayContaining([
          'dynamodb:BatchWriteItem',
          'dynamodb:DeleteItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
        ]));
      } else {
        for (const writeAction of [
          'dynamodb:BatchWriteItem',
          'dynamodb:DeleteItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
        ]) {
          expect(focusActions).not.toContain(writeAction);
        }
      }
    } else {
      expect(focusStatements).toEqual([]);
    }
    const queueId = Object.keys(resources).find((logicalId) =>
      logicalId.startsWith(specification.queuePrefix) &&
      resources[logicalId]?.Type === 'AWS::SQS::Queue'
    );
    expect(queueId).toBeDefined();
    expect(Object.values(resources)).toContainEqual(expect.objectContaining({
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: expect.objectContaining({
        BatchSize: 1,
        EventSourceArn: { 'Fn::GetAtt': [queueId, 'Arn'] },
        FunctionName: { Ref: specification.functionId },
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      }),
    }));
  }

  expect(resources.TenantOperationFunction9BEB780E.Properties.Handler)
    .toBe('index.handler');
  expect(
    resources.TenantOperationFunction9BEB780E.Properties.Environment.Variables
      .TENANT_OPERATION_ALLOWED_STEPS,
  ).toBeUndefined();
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
      Environment: expect.objectContaining({
        Variables: expect.objectContaining({
          REQUEST_EMAIL_WEBHOOK_SECRET: { Ref: 'RequestEmailWebhookSecret' },
          REQUEST_INTAKE_TABLE_NAME: expect.anything(),
          REQUEST_TOKEN_HASH_SECRET: { Ref: 'RequestTokenHashSecret' },
          TENANT_ADMINISTRATION_TABLE_NAME: {
            Ref: 'TenantAdministrationTable621D59EB',
          },
        }),
      }),
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
  expect(serializedPolicies).toContain('TenantAdministrationTable621D59EB');
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

test('triage schedule wakes due entries through a narrow indexed worker', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const requestTableLogicalId =
    template.toJSON().Outputs.RequestIntakeTableName?.Value?.Ref;
  const functionEntry = Object.entries(resources).find(([, resource]) =>
    (resource as { Properties?: { Description?: string } }).Properties?.Description ===
      'Processes due Triage snooze and SLA wake-ups with revision-fenced receipts.'
  );

  expect(typeof requestTableLogicalId).toBe('string');
  expect(functionEntry).toBeDefined();
  if (typeof requestTableLogicalId !== 'string' || !functionEntry) {
    throw new Error('Triage schedule infrastructure was not synthesized.');
  }
  const [functionLogicalId, scheduleFunction] = functionEntry;
  expect(scheduleFunction).toEqual(expect.objectContaining({
    Type: 'AWS::Lambda::Function',
    Properties: expect.objectContaining({
      Handler: 'index.handler',
      MemorySize: 512,
      Runtime: 'nodejs22.x',
      Timeout: 300,
      Environment: expect.objectContaining({
        Variables: expect.objectContaining({
          AUDIT_EVENTS_TABLE_NAME: { Ref: 'AuditEventsTable0723963E' },
          AUDIT_RETENTION_DAYS: { Ref: 'AuditRetentionDays' },
          MUKUROJI_RUNTIME_ROLE: 'triage-schedule-worker',
          REQUEST_INTAKE_TABLE_NAME: { Ref: requestTableLogicalId },
          TRIAGE_SCHEDULE_BATCH_SIZE: '100',
          TRIAGE_WAKE_INDEX_NAME: 'triage-wake-index',
          TRIAGE_WAKE_SHARD_COUNT: '8',
        }),
      }),
    }),
  }));

  const roleLogicalId = (
    scheduleFunction as {
      Properties?: { Role?: { 'Fn::GetAtt'?: string[] } };
    }
  ).Properties?.Role?.['Fn::GetAtt']?.[0];
  expect(typeof roleLogicalId).toBe('string');
  if (typeof roleLogicalId !== 'string') {
    throw new Error('Triage schedule execution role was not synthesized.');
  }
  const policies = Object.values(resources).filter((resource) =>
    (resource as { Type?: string }).Type === 'AWS::IAM::Policy' &&
    ((resource as { Properties?: { Roles?: unknown[] } }).Properties?.Roles ?? [])
      .some((role) => (role as { Ref?: string }).Ref === roleLogicalId)
  );
  const statements = policies.flatMap((policy) => {
    const value = (policy as {
      Properties?: { PolicyDocument?: { Statement?: unknown } };
    }).Properties?.PolicyDocument?.Statement;
    return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  });
  const serializedPolicies = JSON.stringify(policies);
  const queryStatement = statements.find((statement) =>
    statement.Action === 'dynamodb:Query'
  );
  const getStatement = statements.find((statement) =>
    statement.Action === 'dynamodb:GetItem'
  );
  const transactionStatement = statements.find((statement) => {
    const actions = Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action];
    return actions.includes('dynamodb:ConditionCheckItem');
  });
  const auditPutStatement = statements.find((statement) =>
    statement.Action === 'dynamodb:PutItem' &&
    JSON.stringify(statement.Resource).includes('AuditEventsTable0723963E')
  );

  expect(JSON.stringify(queryStatement?.Resource)).toContain(requestTableLogicalId);
  expect(JSON.stringify(queryStatement?.Resource)).toContain(
    'index/triage-wake-index',
  );
  expect(JSON.stringify(getStatement?.Resource)).toContain(requestTableLogicalId);
  expect(transactionStatement).toEqual(expect.objectContaining({
    Action: expect.arrayContaining([
      'dynamodb:ConditionCheckItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]),
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
  }));
  expect(JSON.stringify(transactionStatement?.Resource))
    .toContain(requestTableLogicalId);
  expect(auditPutStatement).toEqual(expect.objectContaining({
    Action: 'dynamodb:PutItem',
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
  }));
  for (const forbiddenAction of [
    'dynamodb:BatchGetItem',
    'dynamodb:BatchWriteItem',
    'dynamodb:DeleteItem',
    'dynamodb:Scan',
    'dynamodb:TransactWriteItems',
  ]) {
    expect(serializedPolicies).not.toContain(forbiddenAction);
  }
  for (const forbiddenResource of [
    'DeveloperPlatformTable',
    'TeamIssuesTable189D851D',
  ]) {
    expect(serializedPolicies).not.toContain(forbiddenResource);
  }

  const eventInvokeConfig = Object.values(resources).find((resource) =>
    (resource as { Type?: string }).Type === 'AWS::Lambda::EventInvokeConfig' &&
    (resource as { Properties?: { FunctionName?: { Ref?: string } } })
      .Properties?.FunctionName?.Ref === functionLogicalId
  ) as {
    Properties?: {
      DestinationConfig?: { OnFailure?: { Destination?: { 'Fn::GetAtt'?: string[] } } };
      MaximumRetryAttempts?: number;
    };
  } | undefined;
  expect(eventInvokeConfig?.Properties?.MaximumRetryAttempts).toBe(2);
  const queueLogicalId = eventInvokeConfig?.Properties?.DestinationConfig
    ?.OnFailure?.Destination?.['Fn::GetAtt']?.[0];
  expect(typeof queueLogicalId).toBe('string');
  if (typeof queueLogicalId !== 'string') {
    throw new Error('Triage schedule DLQ destination was not synthesized.');
  }
  expect(resources[queueLogicalId]).toEqual(expect.objectContaining({
    Type: 'AWS::SQS::Queue',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      SqsManagedSseEnabled: true,
    }),
  }));
  expectQueueRequiresSsl(template, 'TriageScheduleDlq');

  template.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Checks due Triage snooze and SLA wake-ups every minute.',
    ScheduleExpression: 'rate(1 minute)',
    State: 'ENABLED',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects Triage wake processing failures after asynchronous retries.',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription:
      'Detects failures while Lambda delivers Triage schedule failures to the DLQ.',
    MetricName: 'DestinationDeliveryFailures',
    Namespace: 'AWS/Lambda',
    Threshold: 1,
    TreatMissingData: 'notBreaching',
  });
  template.hasOutput('TriageScheduleFunctionName', {});
  template.hasOutput('TriageScheduleDlqUrl', {});
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
        TENANT_ADMINISTRATION_TABLE_NAME: { Ref: 'TenantAdministrationTable621D59EB' },
        WORK_ITEM_CONFIGURATION_TABLE_NAME: { Ref: 'WorkItemConfigurationTable35E94558' },
        WORK_ITEMS_TABLE_NAME: { Ref: 'TeamIssuesTable189D851D' },
        PLANNING_TABLE_NAME: { Ref: 'PlanningTable2A0D4CC5' },
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
        TENANT_ADMINISTRATION_TABLE_NAME: { Ref: 'TenantAdministrationTable621D59EB' },
        WORK_ITEM_CONFIGURATION_TABLE_NAME: { Ref: 'WorkItemConfigurationTable35E94558' },
        WORK_ITEMS_TABLE_NAME: { Ref: 'TeamIssuesTable189D851D' },
        PLANNING_TABLE_NAME: { Ref: 'PlanningTable2A0D4CC5' },
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
    expect(serialized).toContain('TenantAdministrationTable621D59EB');
    expect(serialized).toContain('WorkspaceSearchTable2575AD6B');
    const statements = (policy as {
      Properties?: { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } };
    } | undefined)?.Properties?.PolicyDocument?.Statement ?? [];
    const planningRevisionFenceStatement = statements.find((statement) =>
      (statement.Action === 'dynamodb:UpdateItem' ||
        Array.isArray(statement.Action) && statement.Action.includes('dynamodb:UpdateItem')) &&
      JSON.stringify(statement.Resource).includes('PlanningTable2A0D4CC5') &&
      JSON.stringify(statement.Condition).includes('TransactWriteItems')
    );
    expect(planningRevisionFenceStatement).toEqual({
      Action: 'dynamodb:UpdateItem',
      Condition: {
        'ForAllValues:StringEquals': {
          'dynamodb:Attributes': [
            'workspaceId',
            'recordKey',
            'entryType',
            'schemaVersion',
            'revision',
            'updatedAt',
          ],
        },
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['FENCE#*'],
        },
        StringEquals: {
          'dynamodb:EnclosingOperation': 'TransactWriteItems',
        },
      },
      Effect: 'Allow',
      Resource: {
        'Fn::GetAtt': ['PlanningTable2A0D4CC5', 'Arn'],
      },
    });
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
    const workspaceSearchWriteStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.some((action) =>
        action === 'dynamodb:PutItem' || action === 'dynamodb:UpdateItem' ||
        action === 'dynamodb:DeleteItem'
      ) &&
        JSON.stringify(statement.Resource)
          .includes('WorkspaceSearchTable2575AD6B');
    });
    expect(workspaceSearchWriteStatement).toBeUndefined();
    const projectDirectoryStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('dynamodb:GetItem') &&
        JSON.stringify(statement.Resource)
          .includes('ProjectDirectoryTable9ED01C01');
    });
    expect(projectDirectoryStatement).toEqual(expect.objectContaining({
      Effect: 'Allow',
      Action: expect.arrayContaining([
        'dynamodb:GetItem',
        'dynamodb:Query',
      ]),
    }));
    const tenantEntitlementStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('dynamodb:GetItem') &&
        JSON.stringify(statement.Resource)
          .includes('TenantAdministrationTable621D59EB');
    });
    expect(tenantEntitlementStatement).toEqual(expect.objectContaining({
      Effect: 'Allow',
      Action: 'dynamodb:GetItem',
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
