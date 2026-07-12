import * as vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { expect, jest, test } from '@jest/globals';
import { CdkStack } from '../lib/cdk-stack';

test('project task data store and lambda API are created', () => {
  const app = new cdk.App();
  const stack = new CdkStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'directoryProjectId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'taskId',
        KeyType: 'RANGE',
      },
    ],
  });

  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        {
          AttributeName: 'directoryId',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'eventId',
          KeyType: 'RANGE',
        },
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
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'WorkspaceOccurredAtIndex',
          KeySchema: [
            {
              AttributeName: 'workspaceKey',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'workspaceEventKey',
              KeyType: 'RANGE',
            },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
        }),
        Match.objectLike({
          IndexName: 'EntityOccurredAtIndex',
          KeySchema: [
            {
              AttributeName: 'entityKey',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'entityEventKey',
              KeyType: 'RANGE',
            },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
        }),
        Match.objectLike({
          IndexName: 'ActorOccurredAtIndex',
          KeySchema: [
            {
              AttributeName: 'actorKey',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'actorEventKey',
              KeyType: 'RANGE',
            },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
        }),
        Match.objectLike({
          IndexName: 'TargetOccurredAtIndex',
          KeySchema: [
            {
              AttributeName: 'targetKey',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'targetEventKey',
              KeyType: 'RANGE',
            },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
        }),
      ]),
    }),
  });
  const auditEventsTableResource = Object.values(
    template.findResources('AWS::DynamoDB::Table'),
  ).find((resource) => resource.Properties?.StreamSpecification?.StreamViewType === 'NEW_IMAGE');

  expect(auditEventsTableResource?.Properties?.GlobalSecondaryIndexes).toHaveLength(4);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'consumerName',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'eventId',
        KeyType: 'RANGE',
      },
    ],
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
    },
    TimeToLiveSpecification: {
      AttributeName: 'expiresAt',
      Enabled: true,
    },
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'workspaceId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'recordKey',
        KeyType: 'RANGE',
      },
    ],
  });

  template.hasParameter('WorkspaceDirectoryId', {
    Type: 'String',
    Default: 'user#demo@example.com',
  });

  template.hasParameter('InitialWorkspaceOwnerEmail', {
    Type: 'String',
    Default: 'demo@example.com',
    AllowedPattern: '^[^A-Z\\s@]+@[^A-Z\\s@]+$',
    ConstraintDescription: 'Must be a trimmed lowercase email address.',
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'directoryId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'entryKey',
        KeyType: 'RANGE',
      },
    ],
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'directoryTeamId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'issueId',
        KeyType: 'RANGE',
      },
    ],
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'TeamIssueSortOrderIndex',
        KeySchema: [
          {
            AttributeName: 'directoryTeamId',
            KeyType: 'HASH',
          },
          {
            AttributeName: 'sortOrder',
            KeyType: 'RANGE',
          },
        ],
      }),
      Match.objectLike({
        IndexName: 'AssignedProjectIssueIndex',
        KeySchema: [
          {
            AttributeName: 'directoryProjectId',
            KeyType: 'HASH',
          },
          {
            AttributeName: 'sortOrder',
            KeyType: 'RANGE',
          },
        ],
      }),
    ]),
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'directoryTeamIssueId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'eventId',
        KeyType: 'RANGE',
      },
    ],
  });

  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: {
        ALLOWED_ORIGINS: {
          Ref: 'TaskApiAllowedOrigins',
        },
        AUDIT_EVENTS_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('AuditEventsTable'),
        },
        AUDIT_RETENTION_DAYS: {
          Ref: 'AuditRetentionDays',
        },
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('ProjectDirectoryTable'),
        },
        SYSTEM_ADMIN_GROUPS: {
          Ref: 'SystemAdminGroups',
        },
        TEAM_ISSUE_EVENTS_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('TeamIssueEventsTable'),
        },
        TEAM_ISSUES_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('TeamIssuesTable'),
        },
        WORKSPACE_ACCESS_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('WorkspaceAccessTable'),
        },
        WORKSPACE_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
        },
      },
    },
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
  });

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
      AllowHeaders: Match.arrayWith([
        'authorization',
        'content-type',
        'idempotency-key',
        'x-correlation-id',
      ]),
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH', 'DELETE']),
      AllowOrigins: {
        'Fn::Split': [
          ',',
          {
            Ref: 'TaskApiAllowedOrigins',
          },
        ],
      },
    },
  });

  template.hasOutput('TeamIssuesTableName', {
    Value: {
      Ref: Match.stringLikeRegexp('TeamIssuesTable'),
    },
  });

  template.hasOutput('TeamIssueEventsTableName', {
    Value: {
      Ref: Match.stringLikeRegexp('TeamIssueEventsTable'),
    },
  });

  template.hasOutput('AuditEventsTableName', {
    Value: {
      Ref: Match.stringLikeRegexp('AuditEventsTable'),
    },
  });

  template.hasOutput('AuditEventsStreamArn', {
    Value: {
      'Fn::GetAtt': [Match.stringLikeRegexp('AuditEventsTable'), 'StreamArn'],
    },
  });

  template.hasOutput('ProcessedAuditEventsTableName', {
    Value: {
      Ref: Match.stringLikeRegexp('ProcessedAuditEventsTable'),
    },
  });

  template.hasOutput('WorkspaceAccessTableName', {
    Value: {
      Ref: Match.stringLikeRegexp('WorkspaceAccessTable'),
    },
  });

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminCreateUser',
            'cognito-idp:AdminDeleteUser',
            'cognito-idp:AdminGetUser',
            'cognito-idp:AdminUpdateUserAttributes',
            'cognito-idp:GetUser',
            'cognito-idp:ListUsers',
          ]),
          Effect: 'Allow',
          Resource: {
            'Fn::Join': [
              '',
              Match.arrayWith([
                ':userpool/',
                {
                  Ref: 'CognitoUserPoolId',
                },
              ]),
            ],
          },
        }),
      ]),
    },
  });

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'dynamodb:TransactWriteItems',
          Effect: 'Allow',
          Resource: Match.arrayWith([
            {
              'Fn::GetAtt': [Match.stringLikeRegexp('ProjectTasksTable'), 'Arn'],
            },
            {
              'Fn::GetAtt': [Match.stringLikeRegexp('AuditEventsTable'), 'Arn'],
            },
          ]),
        }),
      ]),
    },
  });
  const auditEventsPutItemStatements = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ).flatMap((resource) => resource.Properties?.PolicyDocument?.Statement ?? [])
    .filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];

      return actions.includes('dynamodb:PutItem') &&
        JSON.stringify(statement.Resource).includes('AuditEventsTable');
    });

  expect(auditEventsPutItemStatements).toHaveLength(0);

  const serializedIamPolicies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(serializedIamPolicies).toContain('WorkspaceAccessTable');
  expect(serializedIamPolicies).toContain('dynamodb:GetItem');
  expect(serializedIamPolicies).toContain('dynamodb:PutItem');
  expect(serializedIamPolicies).toContain('dynamodb:UpdateItem');
  expect(serializedIamPolicies).toContain('dynamodb:TransactWriteItems');

  const customResources = template.findResources('Custom::AWS');
  const seedResource = Object.values(customResources).find((resource) =>
    JSON.stringify(resource).includes('transactWriteItems'),
  );
  const createJoinParts = seedResource?.Properties?.Create?.['Fn::Join']?.[1] ?? [];
  const seedPayload = createJoinParts
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');

  expect(seedPayload).toContain('"service":"DynamoDB"');
  expect(seedPayload).toContain('"action":"transactWriteItems"');
  expect(seedPayload.match(/"Put"/g)).toHaveLength(10);
  expect(JSON.stringify(seedResource)).toContain('WorkspaceDirectoryId');
  expect(seedPayload).toContain('"directoryProjectId":{"S":"#project#refero"}');
  expect(seedPayload).toContain('"taskId":{"S":"wireframe"}');
  expect(seedPayload).toContain('"taskId":{"S":"landing-release"}');
  expect(seedPayload).toContain('"assigneeUserId":{"S":"sato@example.com"}');
  expect(seedPayload).toContain('"dueDate":{"S":"2026/06/03"}');
  expect(seedPayload).toContain(
    '"ConditionExpression":"attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)"',
  );
  expect(seedResource?.Properties?.Update).toBeUndefined();

  const directorySeedResource = Object.values(customResources).find((resource) =>
    JSON.stringify(resource).includes('shared-launch'),
  );
  const directoryCreateJoinParts = directorySeedResource?.Properties?.Create?.['Fn::Join']?.[1] ?? [];
  const directorySeedPayload = directoryCreateJoinParts
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');

  expect(JSON.stringify(directorySeedResource)).toContain('WorkspaceDirectoryId');
  expect(directorySeedPayload).toContain('"entryKey":{"S":"000010#000000#TEAM#core-team"}');
  expect(directorySeedPayload).toContain('"entryKey":{"S":"000010#000010#PROJECT#refero"}');
  expect(directorySeedPayload).toContain('"teamId":{"S":"core-team"}');
  expect(directorySeedPayload).toContain('"teamId":{"S":"design-team"}');
  expect(directorySeedPayload.match(/"projectId":{"S":"shared-launch"}/g)).toHaveLength(3);
  expect(directorySeedPayload).toContain('"entryKey":{"S":"PROJECT_MEMBER#refero#demo@example.com"}');
  expect(directorySeedPayload).toContain('"role":{"S":"manager"}');
  expect(directorySeedPayload).toContain(
    '"ConditionExpression":"attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)"',
  );
  expect(directorySeedResource?.Properties?.Update).toBeUndefined();

  const workspaceSeedResource = Object.values(customResources).find((resource) =>
    JSON.stringify(resource).includes('workspace-access-seed-v1'),
  );
  const workspaceCreateJoinParts = workspaceSeedResource?.Properties?.Create?.['Fn::Join']?.[1] ?? [];
  const workspaceSeedPayload = workspaceCreateJoinParts
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');

  expect(workspaceSeedPayload).toContain('"action":"transactWriteItems"');
  expect(JSON.stringify(workspaceSeedResource)).toContain('WorkspaceDirectoryId');
  expect(JSON.stringify(workspaceSeedResource)).toContain('InitialWorkspaceOwnerEmail');
  expect(workspaceSeedPayload).toContain('"recordKey":{"S":"WORKSPACE"}');
  expect(workspaceSeedPayload).toContain('if_not_exists');
  expect(workspaceSeedPayload).toContain('":entryType":{"S":"workspace-meta"}');
  expect(workspaceSeedPayload).toContain('":activeOwnerCount":{"N":"1"}');
  expect(workspaceSeedPayload).toContain('MEMBER#');
  expect(workspaceSeedPayload).toContain('":role":{"S":"owner"}');
  expect(workspaceSeedPayload).toContain('":status":{"S":"active"}');
  expect(workspaceSeedResource?.Properties?.Update).toBeUndefined();

  const workspaceDemoMembersSeedResource = Object.values(customResources).find((resource) =>
    JSON.stringify(resource).includes('workspace-access-demo-members-seed-v1'),
  );
  const workspaceDemoMembersJoinParts =
    workspaceDemoMembersSeedResource?.Properties?.Create?.['Fn::Join']?.[1] ?? [];
  const workspaceDemoMembersPayload = workspaceDemoMembersJoinParts
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');

  expect(workspaceDemoMembersPayload.match(/"recordKey":\{"S":"MEMBER#/g)).toHaveLength(5);
  expect(workspaceDemoMembersPayload).toContain('MEMBER#sato@example.com');
  expect(workspaceDemoMembersPayload).toContain('MEMBER#suzuki@example.com');
  expect(workspaceDemoMembersPayload).toContain('MEMBER#tanaka@example.com');
  expect(workspaceDemoMembersPayload).toContain('MEMBER#yamamoto@example.com');
  expect(workspaceDemoMembersPayload).toContain('MEMBER#viewer@example.com');
  expect(workspaceDemoMembersPayload).toContain('guest');
  expect(workspaceDemoMembersPayload).toContain('if_not_exists');
  expect(workspaceDemoMembersSeedResource?.DependsOn).toBeDefined();

  const lambdaResource = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) =>
    JSON.stringify(resource).includes('isProjectDirectoryRequest'),
  );
  const lambdaCode = lambdaResource?.Properties?.Code?.ZipFile ?? '';

  expect(lambdaCode).toContain('(?:api\\/)?projects\\/([^/]+)\\/tasks');
  expect(lambdaCode).toContain('(?:api\\/)?projects\\/([^/]+)\\/issues');
  expect(lambdaCode).toContain('(?:api\\/)?teams\\/([^/]+)\\/issues');
  expect(lambdaCode).toContain('toProjectPrincipal');
  expect(lambdaCode).toContain('getActiveWorkspaceMember');
  expect(lambdaCode).toContain('isWorkspaceAccessRequest');
  expect(lambdaCode).toContain('readWorkspaceInvitationAction');
  expect(lambdaCode).toContain('createWorkspaceActorConditionCheck');
  expect(lambdaCode).toContain('reserveWorkspaceInvitation');
  expect(lambdaCode).toContain('putWorkspaceInvitationForActor');
  expect(lambdaCode).toContain('updateWorkspaceMember');
  expect(lambdaCode).toContain("identityOwnership: { S: 'ambiguous' }");
  expect(lambdaCode).toContain("MessageAction: 'RESEND'");
  expect(lambdaCode).toContain("activeOwnerCount > :minimumOwnerCount");
  expect(lambdaCode).toContain('createDirectoryProjectId');
  expect(lambdaCode).toContain('createDirectoryTeamId');
  expect(lambdaCode).toContain('createProjectMemberEntryKey');
  expect(lambdaCode).toContain('decodePathSegment');
  expect(lambdaCode).toContain('createUniqueResourceId');
  expect(lambdaCode).toContain('const taskId = createUniqueResourceId(title');
  expect(lambdaCode).toContain('toProjectDataError');
  expect(lambdaCode).toContain('directoryProjectId = :directoryProjectId');
  expect(lambdaCode).toContain('getProjectAccess');
  expect(lambdaCode).toContain('async function queryAll');
  expect(lambdaCode).toContain('const projectItems = [];');
  expect(lambdaCode).toContain('UpdateItemCommand');
  expect(lambdaCode).toContain('TransactWriteItemsCommand');
  expect(lambdaCode).toContain('DeleteItemCommand');
  expect(lambdaCode).toContain('readArchiveTeamId');
  expect(lambdaCode).toContain('readArchiveProjectParams');
  expect(lambdaCode).toContain('readProjectMemberParams');
  expect(lambdaCode).toContain('readProjectUsersProjectId');
  expect(lambdaCode).toContain('readProjectTaskStatusParams');
  expect(lambdaCode).toContain('readTeamIssueListParams');
  expect(lambdaCode).toContain('readTeamIssueCommentParams');
  expect(lambdaCode).toContain('enforceTeamPermission');
  expect(lambdaCode).toContain('isExpectedCognitoIssuer');
  expect(lambdaCode).toContain('isCognitoUserInDirectory');
  expect(lambdaCode).toContain('AdminGetUserCommand');
  expect(lambdaCode).toContain('ListUsersCommand');
  expect(lambdaCode).toContain('hydrateProjectTasks');
  expect(lambdaCode).toContain('hydrateTeamIssues');
  expect(lambdaCode).toContain('getUserProfile');
  expect(lambdaCode).toContain('async function updateProjectTaskStatus');
  expect(lambdaCode).toContain('async function createTeamIssue');
  expect(lambdaCode).toContain('async function updateTeamIssue');
  expect(lambdaCode).toContain('async function createTeamIssueComment');
  expect(lambdaCode).toContain('async function updateProjectMember');
  expect(lambdaCode).toContain('async function removeProjectMember');
  expect(lambdaCode).toContain('SET #status = :status');
  expect(lambdaCode).toContain('SET archivedAt = :archivedAt');
  expect(lambdaCode).toContain('isActiveDirectoryItem');
  expect(lambdaCode).toContain("'GET,POST,PATCH,DELETE,OPTIONS'");
  expect(lambdaCode).toContain(
    "'access-control-expose-headers': 'x-audit-truncated,x-audit-next-cursor'",
  );
  expect(lambdaCode).toContain("exportHeaders['x-audit-truncated'] = 'true'");
  expect(lambdaCode).toContain("exportHeaders['x-audit-next-cursor'] = cursor");
});

test('inline lambda marks a capped workspace audit export as truncated', async () => {
  let pageNumber = 0;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name !== 'QueryCommand' || command.input.TableName !== 'AuditEventsTable') {
      return {};
    }

    pageNumber += 1;
    expect(command.input.Limit).toBe(100);
    const eventId = `event-${pageNumber}`;
    const occurredAt = `2026-07-11T00:00:${String(pageNumber).padStart(2, '0')}.000Z`;
    const lastEvaluatedKey = {
      directoryId: { S: 'user#demo@example.com' },
      eventId: { S: eventId },
      workspaceKey: { S: 'user#demo@example.com' },
      workspaceEventKey: { S: `${occurredAt}#${eventId}` },
    };

    return {
      Items: Array.from({ length: 100 }, () => ({
        ...lastEvaluatedKey,
        occurredAt: { S: occurredAt },
      })),
      LastEvaluatedKey: lastEvaluatedKey,
    };
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler(createLambdaEvent(
    'GET',
    '/api/audit/events/export',
    ['mukuroji-system-admins'],
  ));
  const nextCursor = response.headers['x-audit-next-cursor'];
  const cursorPayload = JSON.parse(Buffer.from(nextCursor, 'base64url').toString('utf8')) as {
    lastEvaluatedKey: Record<string, { S: string }>;
  };

  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-expose-headers']).toBe(
    'x-audit-truncated,x-audit-next-cursor',
  );
  expect(response.headers['x-audit-truncated']).toBe('true');
  expect(cursorPayload.lastEvaluatedKey.eventId).toEqual({ S: 'event-10' });
  expect(response.body.trimEnd().split('\n')).toHaveLength(1_000);
  expect(pageNumber).toBe(10);
});

test('inline lambda returns Workspace access with owner capabilities', async () => {
  const lambda = createInlineLambda(async () => ({}), { workspaceRole: 'owner' });
  const response = await lambda.handler(createLambdaEvent('GET', '/api/workspace/access'));

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    currentMember: {
      email: 'demo@example.com',
      memberKey: 'demo@example.com',
      role: 'owner',
      status: 'active',
      version: 1,
    },
    capabilities: {
      canInvite: true,
      canManageAdmins: true,
      canManageMembers: true,
    },
  });
});

test.each([
  { name: 'deactivated', options: { workspaceStatus: 'deactivated' as const } },
  { name: 'missing', options: { omitCurrentWorkspaceMember: true } },
])('inline lambda denies every business route for a $name Workspace member', async ({ options }) => {
  const businessCommands: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    businessCommands.push(command.constructor.name);
    return {};
  }, options);
  const response = await lambda.handler(createLambdaEvent('GET', '/api/teams/projects'));

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace access is denied.' });
  expect(businessCommands).toEqual([]);
});

test.each([
  'provisioning',
  'pending',
  'delivery-failed',
] as const)('inline lambda atomically accepts a %s invitation before serving business APIs', async (status) => {
  const commands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const invitation = createWorkspaceInvitationFixture({
    email: 'demo@example.com',
    identityOwnership: 'workspace-created',
    status,
  });
  const lambda = createInlineLambda(async (command) => {
    commands.push({ commandName: command.constructor.name, input: command.input });
    return command.constructor.name === 'QueryCommand' ? { Items: [] } : {};
  }, {
    omitCurrentWorkspaceMember: true,
    workspaceRecords: [invitation],
  });

  const response = await lambda.handler(createLambdaEvent('GET', '/api/teams/projects'));

  expect(response.statusCode).toBe(200);
  expect(commands[0]).toMatchObject({
    commandName: 'TransactWriteItemsCommand',
    input: {
      TransactItems: [
        {
          Put: {
            TableName: 'WorkspaceAccessTable',
            Item: {
              workspaceId: { S: 'user#demo@example.com' },
              recordKey: { S: 'MEMBER#demo@example.com' },
              entryType: { S: 'workspace-member' },
              memberKey: { S: 'demo@example.com' },
              email: { S: 'demo@example.com' },
              role: { S: 'member' },
              status: { S: 'active' },
              identityOwnership: { S: 'workspace-created' },
              version: { N: '1' },
            },
            ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        },
        {
          Update: expect.objectContaining({
            TableName: 'WorkspaceAccessTable',
            Key: {
              workspaceId: { S: 'user#demo@example.com' },
              recordKey: { S: 'INVITATION#demo@example.com' },
            },
            ConditionExpression: expect.stringContaining('expiresAt > :now'),
            ExpressionAttributeValues: expect.objectContaining({
              ':accepted': { S: 'accepted' },
              ':expectedVersion': { N: '1' },
            }),
          }),
        },
      ],
    },
  });
});

test('inline lambda increments the active owner count when an owner invitation is accepted', async () => {
  const commands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commands.push({ commandName: command.constructor.name, input: command.input });
    return command.constructor.name === 'QueryCommand' ? { Items: [] } : {};
  }, {
    omitCurrentWorkspaceMember: true,
    workspaceRecords: [createWorkspaceInvitationFixture({
      email: 'demo@example.com',
      identityOwnership: 'pre-existing',
      role: 'owner',
      status: 'pending',
    })],
  });

  const response = await lambda.handler(createLambdaEvent('GET', '/api/teams/projects'));
  const transaction = commands.find((command) => command.commandName === 'TransactWriteItemsCommand');
  const transactItems = transaction?.input.TransactItems as Array<Record<string, unknown>>;

  expect(response.statusCode).toBe(200);
  expect(transactItems).toHaveLength(3);
  expect(transactItems[2]).toMatchObject({
    Update: {
      TableName: 'WorkspaceAccessTable',
      Key: {
        workspaceId: { S: 'user#demo@example.com' },
        recordKey: { S: 'WORKSPACE' },
      },
      UpdateExpression: expect.stringContaining('ADD activeOwnerCount :one'),
    },
  });
});

test.each([
  { name: 'revoked', status: 'revoked' as const, expiresAt: '2099-01-01T00:00:00.000Z' },
  { name: 'expired', status: 'pending' as const, expiresAt: '2020-01-01T00:00:00.000Z' },
])('inline lambda denies a missing member with a $name invitation', async ({ status, expiresAt }) => {
  const businessCommands: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    businessCommands.push(command.constructor.name);
    return {};
  }, {
    omitCurrentWorkspaceMember: true,
    workspaceRecords: [createWorkspaceInvitationFixture({
      email: 'demo@example.com',
      expiresAt,
      identityOwnership: 'workspace-created',
      status,
    })],
  });

  const response = await lambda.handler(createLambdaEvent('GET', '/api/teams/projects'));

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace access is denied.' });
  expect(businessCommands).toEqual([]);
});

test('inline lambda never reactivates a deactivated member from a pending invitation', async () => {
  const businessCommands: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    businessCommands.push(command.constructor.name);
    return {};
  }, {
    workspaceStatus: 'deactivated',
    workspaceRecords: [createWorkspaceInvitationFixture({
      email: 'demo@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
    })],
  });

  const response = await lambda.handler(createLambdaEvent('GET', '/api/teams/projects'));

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace access is denied.' });
  expect(businessCommands).toEqual([]);
});

test.each([
  {
    failure: 'transaction cancellation',
    createError: () => createTransactionCanceledError(['ConditionalCheckFailed', 'None']),
  },
  {
    failure: 'transport timeout',
    createError: () => Object.assign(new Error('Transaction response timed out.'), { name: 'TimeoutError' }),
  },
])('inline lambda recovers after a committed invitation acceptance with $failure', async ({ createError }) => {
  let memberReads = 0;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createError();
    }

    return command.constructor.name === 'QueryCommand' ? { Items: [] } : {};
  }, {
    omitCurrentWorkspaceMember: true,
    workspaceRecords: [createWorkspaceInvitationFixture({
      email: 'demo@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
    })],
    workspaceRecordResolver(key, fallback) {
      if (key?.recordKey?.S !== 'MEMBER#demo@example.com') {
        return fallback;
      }

      memberReads += 1;
      return memberReads === 1
        ? undefined
        : createWorkspaceMemberFixture('demo@example.com', 'Demo User', 'member', 'active');
    },
  });

  const response = await lambda.handler(createLambdaEvent('GET', '/api/teams/projects'));

  expect(response.statusCode).toBe(200);
  expect(memberReads).toBe(2);
});

test('inline lambda prevents guest members from calling write APIs', async () => {
  const businessCommands: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    businessCommands.push(command.constructor.name);
    return {};
  }, { workspaceRole: 'guest' });
  const event = {
    ...createLambdaEvent('POST', '/api/projects/refero/tasks'),
    body: JSON.stringify({
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      status: 'todo',
      title: 'Guest write',
    }),
  };
  const response = await lambda.handler(event);

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace access is denied.' });
  expect(businessCommands).toEqual([]);
});

test('inline lambda does not let a system admin bypass Workspace structure roles', async () => {
  const businessCommands: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    businessCommands.push(command.constructor.name);
    return {};
  }, { workspaceRole: 'member' });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/teams', ['mukuroji-system-admins']),
    body: JSON.stringify({ name: 'System admin team' }),
  });

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace access is denied.' });
  expect(businessCommands).toEqual([]);
});

test('inline lambda updates a Workspace member with actor and version transaction guards', async () => {
  const commands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commands.push({ commandName: command.constructor.name, input: command.input });
    return {};
  }, { workspaceRole: 'owner' });
  const event = {
    ...createLambdaEvent('PATCH', '/api/workspace/members/sato%40example.com'),
    body: JSON.stringify({ expectedVersion: 1, role: 'guest' }),
  };
  const response = await lambda.handler(event);

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    member: {
      email: 'sato@example.com',
      role: 'guest',
      status: 'active',
      version: 2,
    },
  });
  expect(commands).toEqual([
    {
      commandName: 'TransactWriteItemsCommand',
      input: expect.objectContaining({
        TransactItems: expect.arrayContaining([
          expect.objectContaining({ ConditionCheck: expect.any(Object) }),
          expect.objectContaining({
            Put: expect.objectContaining({
              ConditionExpression: '#version = :expectedVersion',
            }),
          }),
        ]),
      }),
    },
  ]);
});

test('inline lambda preserves the last active Workspace owner during a concurrent role change', async () => {
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'TransactWriteItemsCommand') {
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
    }

    return {};
  }, { workspaceRole: 'owner' });
  const event = {
    ...createLambdaEvent('PATCH', '/api/workspace/members/demo%40example.com'),
    body: JSON.stringify({ expectedVersion: 1, role: 'admin' }),
  };
  const response = await lambda.handler(event);

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({
    message: 'At least one active Workspace owner is required.',
  });
});

test('inline lambda blocks Workspace deactivation while the member manages an active project', async () => {
  const commandNames: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    commandNames.push(command.constructor.name);

    if (command.constructor.name === 'QueryCommand') {
      return { Items: createProjectManagerAssignmentFixture('sato@example.com') };
    }

    return {};
  }, { workspaceRole: 'owner' });
  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/workspace/members/sato%40example.com'),
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({
    message: 'Remove active project manager roles before deactivating Workspace access.',
  });
  expect(commandNames).toEqual(['QueryCommand']);
});

test('inline lambda allows Workspace deactivation when manager roles belong only to archived projects', async () => {
  const commandNames: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    commandNames.push(command.constructor.name);

    if (command.constructor.name === 'QueryCommand') {
      return { Items: createProjectManagerAssignmentFixture('sato@example.com', true) };
    }

    return {};
  }, { workspaceRole: 'owner' });
  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/workspace/members/sato%40example.com'),
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  });

  expect(response.statusCode).toBe(200);
  expect(commandNames).toEqual(['QueryCommand', 'TransactWriteItemsCommand']);
});

test('inline lambda never deletes a pre-existing Cognito user when an invitation is revoked', async () => {
  const cognitoCommands: string[] = [];
  const invitation = createWorkspaceInvitationFixture({
    identityOwnership: 'pre-existing',
    status: 'pending',
  });
  const lambda = createInlineLambda(async () => ({}), {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/revoke'),
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      email: 'invited@example.com',
      identityOwnership: 'pre-existing',
      status: 'revoked',
    },
  });
  expect(cognitoCommands).toEqual(['GetUserCommand']);
});

test('inline lambda retries Cognito cleanup for an already revoked Workspace-created invitation', async () => {
  const dynamoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const cognitoCommands: string[] = [];
  const invitation = {
    ...createWorkspaceInvitationFixture({
      identityOwnership: 'workspace-created',
      status: 'revoked',
    }),
    failureMessage: { S: 'Cognito cleanup failed and can be retried safely.' },
  };
  const lambda = createInlineLambda(async (command) => {
    dynamoCommands.push({ commandName: command.constructor.name, input: command.input });
    return {};
  }, {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/revoke'),
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      email: 'invited@example.com',
      identityOwnership: 'workspace-created',
      status: 'revoked',
      version: 3,
    },
  });
  expect(JSON.parse(response.body).invitation).not.toHaveProperty('failureMessage');
  expect(cognitoCommands).toEqual(['GetUserCommand', 'AdminDeleteUserCommand']);
  expect(dynamoCommands).toEqual([
    {
      commandName: 'TransactWriteItemsCommand',
      input: {
        TransactItems: [
          {
            ConditionCheck: expect.objectContaining({
              ConditionExpression: expect.stringContaining('#version = :actorVersion'),
            }),
          },
          {
            Put: expect.objectContaining({
              ConditionExpression: '#version = :expectedVersion',
              ExpressionAttributeValues: { ':expectedVersion': { N: '1' } },
              Item: expect.objectContaining({
                failureMessage: { S: 'Cognito cleanup failed and can be retried safely.' },
              }),
            }),
          },
        ],
      },
    },
    {
      commandName: 'PutItemCommand',
      input: expect.objectContaining({
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeValues: { ':expectedVersion': { N: '2' } },
      }),
    },
  ]);
});

test('inline lambda blocks reinvite while Workspace-owned Cognito cleanup is pending', async () => {
  const cognitoCommands: string[] = [];
  const invitation = {
    ...createWorkspaceInvitationFixture({
      identityOwnership: 'workspace-created',
      status: 'revoked',
    }),
    failureMessage: { S: 'Cognito cleanup is pending and can be retried safely.' },
  };
  const lambda = createInlineLambda(async () => ({}), {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);
      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/reinvite'),
  );

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({
    message: 'Cognito cleanup must complete before this invitation can be recreated.',
  });
  expect(cognitoCommands).toEqual(['GetUserCommand']);
});

test('inline lambda adopts a pre-existing Cognito user without sending an invitation email', async () => {
  const dynamoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const cognitoCommands: string[] = [];
  const lambda = createInlineLambda(async (command) => {
    dynamoCommands.push({ commandName: command.constructor.name, input: command.input });
    return {};
  }, {
    workspaceRole: 'owner',
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      if (command.constructor.name === 'AdminGetUserCommand') {
        return {
          Username: 'invited@example.com',
          UserAttributes: [
            { Name: 'email', Value: 'invited@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
          ],
        };
      }

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/workspace/invitations'),
    body: JSON.stringify({
      email: 'Invited@Example.com',
      name: 'Invited User',
      role: 'member',
    }),
  });

  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      email: 'invited@example.com',
      identityOwnership: 'pre-existing',
      deliveryStatus: 'not-required',
      status: 'pending',
      version: 2,
    },
  });
  expect(cognitoCommands).toEqual(['GetUserCommand', 'AdminGetUserCommand']);
  expect(dynamoCommands).toEqual([
    {
      commandName: 'TransactWriteItemsCommand',
      input: {
        TransactItems: [
          {
            ConditionCheck: expect.objectContaining({
              ConditionExpression: expect.stringContaining('#version = :actorVersion'),
              ExpressionAttributeValues: expect.objectContaining({
                ':actorRole': { S: 'owner' },
                ':actorVersion': { N: '1' },
              }),
            }),
          },
          {
            ConditionCheck: expect.objectContaining({
              ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
              Key: expect.objectContaining({
                recordKey: { S: 'MEMBER#invited@example.com' },
              }),
            }),
          },
          {
            Put: expect.objectContaining({
              ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
              Item: expect.objectContaining({
                recordKey: { S: 'INVITATION#invited@example.com' },
              }),
            }),
          },
        ],
      },
    },
    {
      commandName: 'PutItemCommand',
      input: expect.objectContaining({
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeValues: { ':expectedVersion': { N: '1' } },
      }),
    },
  ]);
});

test('inline lambda resends an initial invitation to a pre-existing temporary-password Cognito user', async () => {
  const cognitoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async () => ({}), {
    workspaceRole: 'owner',
    async cognitoSend(command) {
      cognitoCommands.push({ commandName: command.constructor.name, input: command.input });

      if (command.constructor.name === 'AdminGetUserCommand') {
        return {
          Username: 'invited@example.com',
          UserStatus: 'FORCE_CHANGE_PASSWORD',
          UserAttributes: [
            { Name: 'email', Value: 'invited@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
          ],
        };
      }

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/workspace/invitations'),
    body: JSON.stringify({ email: 'invited@example.com', role: 'member' }),
  });

  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invited@example.com',
      identityOwnership: 'pre-existing',
      status: 'pending',
    },
  });
  expect(cognitoCommands.at(-1)).toEqual({
    commandName: 'AdminCreateUserCommand',
    input: expect.objectContaining({
      MessageAction: 'RESEND',
      Username: 'invited@example.com',
    }),
  });
});

test('inline lambda reconciles and resends a temporary-password user from an AdminCreateUser race', async () => {
  const cognitoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let adminGetUserReads = 0;
  const lambda = createInlineLambda(async () => ({}), {
    workspaceRole: 'owner',
    async cognitoSend(command) {
      cognitoCommands.push({ commandName: command.constructor.name, input: command.input });

      if (command.constructor.name === 'AdminGetUserCommand') {
        adminGetUserReads += 1;

        if (adminGetUserReads === 1) {
          const error = new Error('User was not found.');
          error.name = 'UserNotFoundException';
          throw error;
        }

        return {
          Username: 'invited@example.com',
          UserStatus: 'FORCE_CHANGE_PASSWORD',
          UserAttributes: [{ Name: 'email', Value: 'invited@example.com' }],
        };
      }

      if (
        command.constructor.name === 'AdminCreateUserCommand' &&
        !('MessageAction' in command.input)
      ) {
        const error = new Error('User already exists.');
        error.name = 'UsernameExistsException';
        throw error;
      }

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/workspace/invitations'),
    body: JSON.stringify({ email: 'invited@example.com', role: 'member' }),
  });

  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invited@example.com',
      identityOwnership: 'ambiguous',
      status: 'pending',
    },
  });
  expect(cognitoCommands.map((command) => command.commandName)).toEqual([
    'GetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminUpdateUserAttributesCommand',
    'AdminCreateUserCommand',
  ]);
  expect(cognitoCommands.at(-2)?.input).toEqual(expect.objectContaining({
    Username: 'invited@example.com',
    UserAttributes: [{ Name: 'custom:directory_id', Value: 'user#demo@example.com' }],
  }));
  expect(cognitoCommands.at(-1)?.input).toEqual(expect.objectContaining({
    MessageAction: 'RESEND',
    Username: 'invited@example.com',
  }));
});

test('inline lambda does not provision Cognito when a member is created during invitation reservation', async () => {
  const dynamoCommands: string[] = [];
  const cognitoCommands: string[] = [];
  let targetMemberReads = 0;
  const lambda = createInlineLambda(async (command) => {
    dynamoCommands.push(command.constructor.name);

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
    }

    return {};
  }, {
    workspaceRole: 'owner',
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
    workspaceRecordResolver(key, fallback) {
      if (key?.recordKey?.S !== 'MEMBER#invited@example.com') {
        return fallback;
      }

      targetMemberReads += 1;
      return targetMemberReads === 1
        ? undefined
        : createWorkspaceMemberFixture('invited@example.com', 'Invited User', 'member', 'active');
    },
  });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/workspace/invitations'),
    body: JSON.stringify({ email: 'invited@example.com', role: 'member' }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace member already exists.' });
  expect(dynamoCommands).toEqual(['TransactWriteItemsCommand']);
  expect(cognitoCommands).toEqual(['GetUserCommand']);
});

test('inline lambda resends temporary credentials for a Workspace-created Cognito user', async () => {
  const dynamoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const cognitoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const invitation = createWorkspaceInvitationFixture({
    identityOwnership: 'workspace-created',
    status: 'pending',
  });
  const lambda = createInlineLambda(async (command) => {
    dynamoCommands.push({ commandName: command.constructor.name, input: command.input });
    return {};
  }, {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push({ commandName: command.constructor.name, input: command.input });

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/resend'),
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      email: 'invited@example.com',
      identityOwnership: 'workspace-created',
      deliveryStatus: 'sent',
      status: 'pending',
      version: 3,
    },
  });
  expect(cognitoCommands).toEqual([
    {
      commandName: 'GetUserCommand',
      input: expect.any(Object),
    },
    {
      commandName: 'AdminCreateUserCommand',
      input: expect.objectContaining({
        MessageAction: 'RESEND',
        Username: 'invited@example.com',
      }),
    },
  ]);
  expect(dynamoCommands[0]).toEqual({
    commandName: 'TransactWriteItemsCommand',
    input: {
      TransactItems: [
        {
          ConditionCheck: expect.objectContaining({
            ConditionExpression: expect.stringContaining('#version = :actorVersion'),
          }),
        },
        {
          Put: expect.objectContaining({
            ConditionExpression: '#version = :expectedVersion',
            ExpressionAttributeValues: { ':expectedVersion': { N: '1' } },
          }),
        },
      ],
    },
  });
});

test('inline lambda preserves ambiguous ownership while resending a temporary-password user', async () => {
  const cognitoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const invitation = createWorkspaceInvitationFixture({
    identityOwnership: 'ambiguous',
    status: 'delivery-failed',
  });
  const lambda = createInlineLambda(async () => ({}), {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push({ commandName: command.constructor.name, input: command.input });

      if (command.constructor.name === 'AdminGetUserCommand') {
        return {
          Username: 'invited@example.com',
          UserStatus: 'FORCE_CHANGE_PASSWORD',
          UserAttributes: [
            { Name: 'email', Value: 'invited@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
          ],
        };
      }

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/resend'),
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      identityOwnership: 'ambiguous',
      status: 'pending',
      version: 3,
    },
  });
  expect(cognitoCommands.at(-1)).toEqual({
    commandName: 'AdminCreateUserCommand',
    input: expect.objectContaining({
      MessageAction: 'RESEND',
      Username: 'invited@example.com',
    }),
  });
});

test('inline lambda does not reinvite when membership is created before the prepare transaction', async () => {
  const dynamoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const cognitoCommands: string[] = [];
  const invitation = createWorkspaceInvitationFixture({
    identityOwnership: 'ambiguous',
    status: 'revoked',
  });
  const lambda = createInlineLambda(async (command) => {
    dynamoCommands.push({ commandName: command.constructor.name, input: command.input });

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
    }

    return {};
  }, {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/reinvite'),
  );

  expect(response.statusCode).toBe(409);
  expect(cognitoCommands).toEqual(['GetUserCommand']);
  expect(dynamoCommands).toEqual([
    {
      commandName: 'TransactWriteItemsCommand',
      input: {
        TransactItems: [
          { ConditionCheck: expect.any(Object) },
          {
            ConditionCheck: expect.objectContaining({
              ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
              Key: expect.objectContaining({
                recordKey: { S: 'MEMBER#invited@example.com' },
              }),
            }),
          },
          {
            Put: expect.objectContaining({
              ConditionExpression: '#version = :expectedVersion',
            }),
          },
        ],
      },
    },
  ]);
});

test('inline lambda promotes a successfully recreated Cognito identity to Workspace ownership', async () => {
  const dynamoCommands: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const cognitoCommands: string[] = [];
  const invitation = createWorkspaceInvitationFixture({
    identityOwnership: 'workspace-created',
    status: 'revoked',
  });
  const lambda = createInlineLambda(async (command) => {
    dynamoCommands.push({ commandName: command.constructor.name, input: command.input });
    return {};
  }, {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      if (command.constructor.name === 'AdminGetUserCommand') {
        const error = new Error('User was not found.');
        error.name = 'UserNotFoundException';
        throw error;
      }

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/reinvite'),
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invited@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
      version: 3,
    },
  });
  expect(cognitoCommands).toEqual([
    'GetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
  ]);
  expect(dynamoCommands[0]).toMatchObject({
    commandName: 'TransactWriteItemsCommand',
    input: {
      TransactItems: [
        { ConditionCheck: expect.any(Object) },
        { ConditionCheck: expect.any(Object) },
        { Put: { Item: { identityOwnership: { S: 'ambiguous' } } } },
      ],
    },
  });
  expect(dynamoCommands.at(-1)).toMatchObject({
    commandName: 'PutItemCommand',
    input: {
      Item: { identityOwnership: { S: 'workspace-created' } },
    },
  });
});

test('inline lambda stops invitation side effects when the actor is concurrently deactivated', async () => {
  const cognitoCommands: string[] = [];
  let actorReads = 0;
  const invitation = createWorkspaceInvitationFixture({
    identityOwnership: 'workspace-created',
    status: 'pending',
  });
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'TransactWriteItemsCommand') {
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
    }

    return {};
  }, {
    workspaceRole: 'owner',
    workspaceRecords: [invitation],
    async cognitoSend(command) {
      cognitoCommands.push(command.constructor.name);

      return {
        Username: 'demo@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'demo@example.com' },
          { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
        ],
      };
    },
    workspaceRecordResolver(key, fallback) {
      if (key?.recordKey?.S !== 'MEMBER#demo@example.com') {
        return fallback;
      }

      actorReads += 1;
      return actorReads === 1
        ? fallback
        : createWorkspaceMemberFixture('demo@example.com', 'Demo User', 'owner', 'deactivated');
    },
  });
  const response = await lambda.handler(
    createLambdaEvent('POST', '/api/workspace/invitations/invited%40example.com/resend'),
  );

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Workspace access is denied.' });
  expect(cognitoCommands).toEqual(['GetUserCommand']);
});

test('inline lambda rejects legacy task status updates', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'DirectoryTable') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'demo@example.com' },
            email: { S: 'demo@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ],
      };
    }

    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'TasksTable') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            directoryProjectId: { S: 'user#demo@example.com#project#refero' },
            projectId: { S: 'refero' },
            taskId: { S: 'wireframe' },
            sortOrder: { N: '10' },
            titleKey: { S: 'tasks.item.wireframe' },
            assigneeKey: { S: 'tasks.assignee.sato' },
            status: { S: 'todo' },
            dueDate: { S: '2026/06/03' },
            priority: { S: 'high' },
          },
        ],
      };
    }

    return {};
  });

  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/projects/refero/tasks/wireframe'),
    body: JSON.stringify({ status: 'done' }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({ message: 'Legacy task issues are read-only.' });
  expect(commandInputs).toHaveLength(3);
  expect(commandInputs[2]).toEqual({
    commandName: 'QueryCommand',
    input: {
      TableName: 'TasksTable',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId AND taskId = :taskId',
      ExpressionAttributeValues: {
        ':directoryProjectId': { S: 'user#demo@example.com#project#refero' },
        ':taskId': { S: 'wireframe' },
      },
      Limit: 1,
    },
  });
  expect(commandInputs.some((input) => input.commandName === 'UpdateItemCommand')).toBe(false);
});

test('inline lambda returns conflict when a task changes during its status transaction', async () => {
  let taskReads = 0;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'DirectoryTable') {
      return { Items: [] };
    }

    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'TasksTable') {
      taskReads += 1;
      return {
        Items: [createInlineProjectTaskItem(taskReads === 1 ? 'todo' : 'doing')],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None']);
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent(
      'PATCH',
      '/api/projects/refero/tasks/wireframe',
      ['mukuroji-system-admins'],
    ),
    body: JSON.stringify({ status: 'done' }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({ message: 'Task was modified by another request.' });
  expect(taskReads).toBe(2);
});

test('inline lambda returns not found when a task disappears during its status transaction', async () => {
  let taskReads = 0;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'DirectoryTable') {
      return { Items: [] };
    }

    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'TasksTable') {
      taskReads += 1;
      return { Items: taskReads === 1 ? [createInlineProjectTaskItem()] : [] };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None']);
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent(
      'PATCH',
      '/api/projects/refero/tasks/wireframe',
      ['mukuroji-system-admins'],
    ),
    body: JSON.stringify({ status: 'done' }),
  });

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ message: 'Task was not found.' });
  expect(taskReads).toBe(2);
});

test('inline lambda does not map task transaction infrastructure failures to conflict', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const lambda = createInlineTaskStatusFailureLambda(
    createTransactionCanceledError(['ConditionalCheckFailed', 'ProvisionedThroughputExceeded']),
    false,
  );

  try {
    const response = await lambda.handler({
      ...createLambdaEvent(
        'PATCH',
        '/api/projects/refero/tasks/wireframe',
        ['mukuroji-system-admins'],
      ),
      body: JSON.stringify({ status: 'done' }),
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ message: 'Failed to load project tasks.' });
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda does not map transaction cancellations without reasons to conflict', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const lambda = createInlineTaskStatusFailureLambda(
    Object.assign(new Error('Transaction was canceled.'), {
      name: 'TransactionCanceledException',
    }),
    false,
  );

  try {
    const response = await lambda.handler({
      ...createLambdaEvent(
        'PATCH',
        '/api/projects/refero/tasks/wireframe',
        ['mukuroji-system-admins'],
      ),
      body: JSON.stringify({ status: 'done' }),
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ message: 'Failed to load project tasks.' });
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda does not reread missing task state for an unknown cancellation reason', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const lambda = createInlineTaskStatusFailureLambda(
    createTransactionCanceledError(['TransactionConflict']),
    false,
  );

  try {
    const response = await lambda.handler({
      ...createLambdaEvent(
        'PATCH',
        '/api/projects/refero/tasks/wireframe',
        ['mukuroji-system-admins'],
      ),
      body: JSON.stringify({ status: 'done' }),
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ message: 'Failed to load project tasks.' });
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda maps an audit-only condition to conflict without rereading task state', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const lambda = createInlineTaskStatusFailureLambda(
    createTransactionCanceledError(['None', 'ConditionalCheckFailed']),
    false,
  );

  try {
    const response = await lambda.handler({
      ...createLambdaEvent(
        'PATCH',
        '/api/projects/refero/tasks/wireframe',
        ['mukuroji-system-admins'],
      ),
      body: JSON.stringify({ status: 'done' }),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ message: 'The same item already exists.' });
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda preserves resource-not-found handling for transaction calls', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const lambda = createInlineTaskStatusFailureLambda(
    Object.assign(new Error('Table was not found.'), {
      name: 'ResourceNotFoundException',
    }),
  );

  try {
    const response = await lambda.handler({
      ...createLambdaEvent(
        'PATCH',
        '/api/projects/refero/tasks/wireframe',
        ['mukuroji-system-admins'],
      ),
      body: JSON.stringify({ status: 'done' }),
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ message: 'Project data is not initialized.' });
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda creates a project and grants the creator manager role', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
        ],
      };
    }

    return {};
  }, { workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/teams/core-team/projects'),
    body: JSON.stringify({ name: '新規プロジェクト', tone: 'green' }),
  });

  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toEqual({
    project: {
      id: '新規プロジェクト',
      name: '新規プロジェクト',
      tone: 'green',
    },
  });
  expect(commandInputs).toHaveLength(2);
  expect(commandInputs[1]).toMatchObject({
    commandName: 'TransactWriteItemsCommand',
    input: {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: 'DirectoryTable',
            Key: {
              directoryId: { S: 'user#demo@example.com' },
              entryKey: { S: '000010#000000#TEAM#core-team' },
            },
            ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          },
        },
        {
          Update: {
            TableName: 'WorkspaceAccessTable',
            Key: {
              workspaceId: { S: 'user#demo@example.com' },
              recordKey: { S: 'MEMBER#demo@example.com' },
            },
            UpdateExpression: 'SET #version = #version + :one',
            ConditionExpression:
              '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
            ExpressionAttributeValues: expect.objectContaining({
              ':active': { S: 'active' },
              ':expectedVersion': { N: '1' },
            }),
          },
        },
        {
          Put: {
            TableName: 'DirectoryTable',
            Item: {
              directoryId: { S: 'user#demo@example.com' },
              entryKey: { S: '000010#000010#PROJECT#新規プロジェクト' },
              entryType: { S: 'project' },
              teamId: { S: 'core-team' },
              projectId: { S: '新規プロジェクト' },
              tone: { S: 'green' },
            },
            ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
          },
        },
        {
          Put: {
            TableName: 'DirectoryTable',
            Item: {
              directoryId: { S: 'user#demo@example.com' },
              entryKey: { S: 'PROJECT_MEMBER#新規プロジェクト#demo@example.com' },
              entryType: { S: 'project-member' },
              projectId: { S: '新規プロジェクト' },
              memberKey: { S: 'demo@example.com' },
              email: { S: 'demo@example.com' },
              role: { S: 'manager' },
            },
            ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
          },
        },
      ],
    },
  });
});

test('inline lambda returns conflict when project creation transaction is canceled', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
        ],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['None', 'None', 'ConditionalCheckFailed', 'None']);
    }

    return {};
  }, { workspaceRole: 'owner' });

  try {
    const response = await lambda.handler({
      ...createLambdaEvent('POST', '/api/teams/core-team/projects'),
      body: JSON.stringify({ name: '新規プロジェクト' }),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ message: 'The same item already exists.' });
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda returns not found when project creation transaction loses its active team', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let queryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      queryReads += 1;

      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
            ...(queryReads >= 2 ? { archivedAt: { S: '2026-06-08T00:00:00.000Z' } } : {}),
          },
        ],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None', 'None']);
    }

    return {};
  }, { workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/teams/core-team/projects'),
    body: JSON.stringify({ name: '新規プロジェクト' }),
  });

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ message: 'Team was not found.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
});

test('inline lambda archives a project with a conditional update', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'demo@example.com' },
            email: { S: 'demo@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ],
      };
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler(createLambdaEvent(
    'PATCH',
    '/api/teams/core-team/projects/refero/archive',
  ));
  const body = JSON.parse(response.body) as Record<string, unknown>;

  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,DELETE,OPTIONS');
  expect(response.headers['access-control-allow-headers']).toBe(
    'authorization,content-type,idempotency-key,x-correlation-id',
  );
  expect(body).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  });
  expect(commandInputs).toHaveLength(2);
  expect(commandInputs[1].commandName).toBe('TransactWriteItemsCommand');
  const transactItems = commandInputs[1].input.TransactItems as Array<Record<string, unknown>>;

  expect(transactItems).toHaveLength(2);
  expect(transactItems[0]).toMatchObject({
    Update: {
      TableName: 'DirectoryTable',
      Key: {
        directoryId: { S: 'user#demo@example.com' },
        entryKey: { S: '000010#000010#PROJECT#refero' },
      },
      UpdateExpression: 'SET archivedAt = :archivedAt',
      ConditionExpression:
        'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
      ExpressionAttributeValues: {
        ':archivedAt': { S: body.archivedAt },
      },
    },
  });
  expect(transactItems[1]).toMatchObject({
    Put: {
      TableName: 'AuditEventsTable',
      Item: {
        directoryId: { S: 'user#demo@example.com' },
        eventType: { S: 'project.archived' },
        entityType: { S: 'project' },
        entityId: { S: 'refero' },
        action: { S: 'archived' },
        actorUserId: { S: 'demo-sub' },
        outboxStatus: { S: 'pending' },
      },
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    },
  });
});

test('inline lambda archives a team with a conditional update', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
        ],
      };
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler(createLambdaEvent(
    'PATCH',
    '/api/teams/core-team/archive',
    ['mukuroji-system-admins'],
  ));
  const body = JSON.parse(response.body) as Record<string, unknown>;

  expect(response.statusCode).toBe(200);
  expect(body).toEqual({
    teamId: 'core-team',
    archivedAt: expect.any(String),
  });
  expect(commandInputs).toHaveLength(2);
  expect(commandInputs[1].commandName).toBe('TransactWriteItemsCommand');
  const transactItems = commandInputs[1].input.TransactItems as Array<Record<string, unknown>>;

  expect(transactItems).toHaveLength(2);
  expect(transactItems[0]).toMatchObject({
    Update: {
      TableName: 'DirectoryTable',
      Key: {
        directoryId: { S: 'user#demo@example.com' },
        entryKey: { S: '000010#000000#TEAM#core-team' },
      },
      UpdateExpression: 'SET archivedAt = :archivedAt',
      ConditionExpression:
        'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
      ExpressionAttributeValues: {
        ':archivedAt': { S: body.archivedAt },
      },
    },
  });
  expect(transactItems[1]).toMatchObject({
    Put: {
      TableName: 'AuditEventsTable',
      Item: {
        directoryId: { S: 'user#demo@example.com' },
        eventType: { S: 'project.archived' },
        entityType: { S: 'project' },
        entityId: { S: 'team/core-team' },
        action: { S: 'archived' },
        actorUserId: { S: 'demo-sub' },
        outboxStatus: { S: 'pending' },
      },
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    },
  });
});

test('inline lambda denies task access for archived projects', async () => {
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
            archivedAt: { S: '2026-06-06T00:00:00.000Z' },
          },
        ],
      };
    }

    return {};
  });

  const response = await lambda.handler(createLambdaEvent('GET', '/api/projects/refero/tasks'));

  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual({ message: 'Project access is denied.' });
});

test('inline lambda updates project member roles for a project manager', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'demo@example.com' },
            email: { S: 'demo@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ],
      };
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/projects/refero/members/sato%40example.com'),
    body: JSON.stringify({
      role: 'member',
    }),
  });
  const body = JSON.parse(response.body) as Record<string, unknown>;

  expect(response.statusCode).toBe(200);
  expect(body).toMatchObject({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      username: 'sato@example.com',
      enabled: true,
      status: 'CONFIRMED',
      role: 'member',
    },
  });
  expect(commandInputs).toHaveLength(3);
  expect(commandInputs[2].commandName).toBe('TransactWriteItemsCommand');
  const transactItems = commandInputs[2].input.TransactItems as Array<Record<string, unknown>>;

  expect(transactItems).toHaveLength(3);
  expect(transactItems[0]).toMatchObject({
    Update: {
      TableName: 'WorkspaceAccessTable',
      Key: {
        workspaceId: { S: 'user#demo@example.com' },
        recordKey: { S: 'MEMBER#sato@example.com' },
      },
      UpdateExpression: 'SET #version = #version + :one',
      ConditionExpression:
        '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
      ExpressionAttributeValues: expect.objectContaining({
        ':active': { S: 'active' },
        ':expectedVersion': { N: '1' },
      }),
    },
  });
  expect(transactItems[1]).toMatchObject({
    Put: {
      TableName: 'DirectoryTable',
      Item: {
        directoryId: { S: 'user#demo@example.com' },
        entryKey: { S: 'PROJECT_MEMBER#refero#sato@example.com' },
        entryType: { S: 'project-member' },
        projectId: { S: 'refero' },
        memberKey: { S: 'sato@example.com' },
        email: { S: 'sato@example.com' },
        name: { S: '佐藤 花子' },
        role: { S: 'member' },
        createdAt: { S: body.member && typeof body.member === 'object' && 'updatedAt' in body.member ? String(body.member.updatedAt) : expect.any(String) },
        updatedAt: { S: body.member && typeof body.member === 'object' && 'updatedAt' in body.member ? String(body.member.updatedAt) : expect.any(String) },
      },
    },
  });
  expect(transactItems[2]).toMatchObject({
    Put: {
      TableName: 'AuditEventsTable',
      Item: {
        directoryId: { S: 'user#demo@example.com' },
        eventType: { S: 'member.added' },
        entityType: { S: 'member' },
        entityId: { S: 'refero/sato@example.com' },
        action: { S: 'created' },
        actorUserId: { S: 'demo-sub' },
        outboxStatus: { S: 'pending' },
      },
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    },
  });
});

test('inline lambda rejects a project manager grant when Workspace access changes concurrently', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({ commandName: command.constructor.name, input: command.input });

    if (command.constructor.name === 'QueryCommand') {
      return { Items: createInlineProjectMemberFixtureItems() };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None', 'None']);
    }

    return {};
  }, { workspaceRole: 'owner' });
  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/projects/refero/members/sato%40example.com'),
    body: JSON.stringify({ role: 'manager' }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({
    message: 'Workspace access changed. Reload and retry.',
  });
  expect(commandInputs.at(-1)).toMatchObject({
    commandName: 'TransactWriteItemsCommand',
    input: {
      TransactItems: [
        {
          Update: expect.objectContaining({
            TableName: 'WorkspaceAccessTable',
            ConditionExpression:
              '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          }),
        },
        expect.objectContaining({ Put: expect.any(Object) }),
      ],
    },
  });
});

test('inline lambda keeps the last project manager from being downgraded', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'demo@example.com' },
            email: { S: 'demo@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ],
      };
    }

    return {};
  });

  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/projects/refero/members/demo%40example.com'),
    body: JSON.stringify({
      role: 'viewer',
    }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({ message: 'At least one project manager is required.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'QueryCommand',
  ]);
});

test('inline lambda treats manager guard transaction cancellation as last manager conflict', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let queryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      queryReads += 1;

      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'demo@example.com' },
            email: { S: 'demo@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
          ...(queryReads < 3
            ? [
                {
                  directoryId: { S: 'user#demo@example.com' },
                  entryKey: { S: 'PROJECT_MEMBER#refero#zmanager@example.com' },
                  entryType: { S: 'project-member' },
                  projectId: { S: 'refero' },
                  memberKey: { S: 'zmanager@example.com' },
                  email: { S: 'zmanager@example.com' },
                  role: { S: 'manager' },
                  createdAt: { S: '2026-06-08T00:00:00.000Z' },
                  updatedAt: { S: '2026-06-08T00:00:00.000Z' },
                },
              ]
            : []),
        ],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None']);
    }

    return {};
  });

  const response = await lambda.handler(createLambdaEvent(
    'DELETE',
    '/api/projects/refero/members/demo%40example.com',
  ));

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({ message: 'At least one project manager is required.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
});

test('inline lambda returns not found when the target member is deleted during the guard transaction', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let queryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      queryReads += 1;

      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000000#TEAM#core-team' },
            entryType: { S: 'team' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            nameJa: { S: 'コアチーム' },
            nameEn: { S: 'Core Team' },
            expanded: { BOOL: true },
          },
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: '000010#000010#PROJECT#refero' },
            entryType: { S: 'project' },
            teamId: { S: 'core-team' },
            teamSortOrder: { N: '10' },
            projectId: { S: 'refero' },
            projectSortOrder: { N: '10' },
            nameJa: { S: 'Refero' },
            nameEn: { S: 'Refero' },
            tone: { S: 'blue' },
          },
          ...(queryReads < 3
            ? [
                {
                  directoryId: { S: 'user#demo@example.com' },
                  entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
                  entryType: { S: 'project-member' },
                  projectId: { S: 'refero' },
                  memberKey: { S: 'demo@example.com' },
                  email: { S: 'demo@example.com' },
                  role: { S: 'manager' },
                  createdAt: { S: '2026-06-08T00:00:00.000Z' },
                  updatedAt: { S: '2026-06-08T00:00:00.000Z' },
                },
              ]
            : []),
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#zmanager@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'zmanager@example.com' },
            email: { S: 'zmanager@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['None', 'ConditionalCheckFailed']);
    }

    return {};
  });

  const response = await lambda.handler(createLambdaEvent(
    'DELETE',
    '/api/projects/refero/members/demo%40example.com',
  ));

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ message: 'Project member was not found.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
});

test('inline lambda returns not found when the project is archived during the guard transaction', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let queryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      queryReads += 1;

      return {
        Items: createInlineProjectMemberFixtureItems({
          archivedProject: queryReads >= 3,
        }),
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None']);
    }

    return {};
  });

  const response = await lambda.handler(createLambdaEvent(
    'DELETE',
    '/api/projects/refero/members/demo%40example.com',
  ));

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ message: 'Project was not found.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
});

test('inline lambda treats manager downgrade transaction cancellation as last manager conflict', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let queryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      queryReads += 1;

      return {
        Items: createInlineProjectMemberFixtureItems({
          includeOtherManager: queryReads < 3,
        }),
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['None', 'ConditionalCheckFailed', 'None']);
    }

    return {};
  });

  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/projects/refero/members/demo%40example.com'),
    body: JSON.stringify({
      role: 'viewer',
    }),
  });

  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({ message: 'At least one project manager is required.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
});

test('inline lambda returns generic conflict when manager guard transaction cancellation remains valid', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: createInlineProjectMemberFixtureItems(),
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['None', 'ConditionalCheckFailed']);
    }

    return {};
  });

  try {
    const response = await lambda.handler(createLambdaEvent(
      'DELETE',
      '/api/projects/refero/members/demo%40example.com',
    ));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ message: 'The same item already exists.' });
    expect(commandInputs.map((command) => command.commandName)).toEqual([
      'QueryCommand',
      'QueryCommand',
      'TransactWriteItemsCommand',
      'QueryCommand',
    ]);
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda returns not found when a non-manager update loses its target member', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let directoryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      directoryReads += 1;

      return {
        Items: createInlineProjectMemberFixtureItems({
          includeTargetMember: directoryReads === 1,
          targetRole: 'member',
        }),
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['None', 'ConditionalCheckFailed', 'None']);
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent(
      'PATCH',
      '/api/projects/refero/members/demo%40example.com',
      ['mukuroji-system-admins'],
    ),
    body: JSON.stringify({ role: 'viewer' }),
  });

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ message: 'Project member was not found.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
  expect(commandInputs[0].input).toMatchObject({ ConsistentRead: true });
  expect(commandInputs.at(-1)?.input).toMatchObject({ ConsistentRead: true });
});

test('inline lambda returns not found when a non-manager removal loses its target member', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  let directoryReads = 0;
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name === 'QueryCommand') {
      directoryReads += 1;

      return {
        Items: createInlineProjectMemberFixtureItems({
          includeTargetMember: directoryReads === 1,
          targetRole: 'member',
        }),
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw createTransactionCanceledError(['ConditionalCheckFailed', 'None']);
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler(createLambdaEvent(
    'DELETE',
    '/api/projects/refero/members/demo%40example.com',
    ['mukuroji-system-admins'],
  ));

  expect(response.statusCode).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ message: 'Project member was not found.' });
  expect(commandInputs.map((command) => command.commandName)).toEqual([
    'QueryCommand',
    'TransactWriteItemsCommand',
    'QueryCommand',
  ]);
  expect(commandInputs[0].input).toMatchObject({ ConsistentRead: true });
  expect(commandInputs.at(-1)?.input).toMatchObject({ ConsistentRead: true });
});

test('inline lambda lets a system admin update project member roles without project access checks', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  const response = await lambda.handler({
    ...createLambdaEvent(
      'PATCH',
      '/api/projects/refero/members/sato%40example.com',
      ['mukuroji-system-admins'],
    ),
    body: JSON.stringify({
      role: 'member',
    }),
  });
  const body = JSON.parse(response.body) as Record<string, unknown>;

  expect(response.statusCode).toBe(200);
  expect(body).toMatchObject({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      role: 'member',
    },
  });
  expect(commandInputs).toHaveLength(2);
  expect(commandInputs[0]).toMatchObject({
    commandName: 'QueryCommand',
    input: {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
    },
  });
  expect(commandInputs[1].commandName).toBe('TransactWriteItemsCommand');
  const transactItems = commandInputs[1].input.TransactItems as Array<Record<string, unknown>>;

  expect(transactItems).toHaveLength(3);
  expect(transactItems[0]).toMatchObject({
    Update: {
      TableName: 'WorkspaceAccessTable',
      Key: {
        workspaceId: { S: 'user#demo@example.com' },
        recordKey: { S: 'MEMBER#sato@example.com' },
      },
      UpdateExpression: 'SET #version = #version + :one',
    },
  });
  expect(transactItems[1]).toMatchObject({
    Put: {
      TableName: 'DirectoryTable',
      Item: {
        directoryId: { S: 'user#demo@example.com' },
        entryKey: { S: 'PROJECT_MEMBER#refero#sato@example.com' },
        projectId: { S: 'refero' },
        memberKey: { S: 'sato@example.com' },
        role: { S: 'member' },
      },
    },
  });
  expect(transactItems[2]).toMatchObject({
    Put: {
      TableName: 'AuditEventsTable',
      Item: {
        directoryId: { S: 'user#demo@example.com' },
        eventType: { S: 'member.added' },
        entityType: { S: 'member' },
        entityId: { S: 'refero/sato@example.com' },
        action: { S: 'created' },
        actorUserId: { S: 'demo-sub' },
        outboxStatus: { S: 'pending' },
      },
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    },
  });
});

test('inline lambda keeps audit event identity stable across create retries', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const transactions: Array<Array<Record<string, unknown>>> = [];
  const storedEventIds = new Set<string>();
  let teamCreated = false;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand') {
      return {
        Items: teamCreated
          ? [
              {
                directoryId: { S: 'user#demo@example.com' },
                entryKey: { S: '000010#000000#TEAM#retry-team' },
                entryType: { S: 'team' },
                teamId: { S: 'retry-team' },
                teamSortOrder: { N: '10' },
                nameJa: { S: 'Retry team' },
                nameEn: { S: 'Retry team' },
                expanded: { BOOL: true },
              },
            ]
          : [],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      const transactItems = command.input.TransactItems as Array<Record<string, unknown>>;
      const auditPut = transactItems.at(-1)?.Put as Record<string, unknown>;
      const auditItem = auditPut.Item as Record<string, { S?: string }>;
      const eventId = String(auditItem.eventId.S);

      transactions.push(transactItems);

      if (storedEventIds.has(eventId)) {
        throw createTransactionCanceledError(
          transactItems.map((_, index) =>
            index === transactItems.length - 1 ? 'ConditionalCheckFailed' : 'None'),
        );
      }

      storedEventIds.add(eventId);
      teamCreated = true;
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });
  const baseRequest = createLambdaEvent('POST', '/api/teams', ['mukuroji-system-admins']);
  const request = {
    ...baseRequest,
    body: JSON.stringify({ name: 'Retry team' }),
    headers: {
      ...baseRequest.headers,
      'idempotency-key': 'create-team-request-1',
    },
  };

  try {
    const first = await lambda.handler(request);
    const second = await lambda.handler(request);
    const firstAuditItem = readDynamoTransactPutItem(transactions[0], -1);
    const secondAuditItem = readDynamoTransactPutItem(transactions[1], -1);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(firstAuditItem.entityId.S).toBe('team/retry-team');
    expect(secondAuditItem.entityId.S).toBe('team/retry-team-2');
    expect(secondAuditItem.eventId.S).toBe(firstAuditItem.eventId.S);
    expect(firstAuditItem.actorUserId.S).toBe('demo-sub');
    expect(firstAuditItem.idempotencyKeyHash.S).toBe(
      createHash('sha256')
        .update('audit-idempotency-v1\0user#demo@example.com\0demo-sub\0create-team-request-1')
        .digest('hex'),
    );
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda falls back to the normalized user key when Cognito sub is missing', async () => {
  let transaction: Array<Record<string, unknown>> | undefined;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand') {
      return { Items: [] };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      transaction = command.input.TransactItems as Array<Record<string, unknown>>;
    }

    return {};
  }, {
    includeAuditEventsTable: true,
    principalSub: null,
    workspaceRole: 'owner',
  });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/teams', ['mukuroji-system-admins']),
    body: JSON.stringify({ name: 'Fallback actor' }),
  });
  const auditItem = readDynamoTransactPutItem(transaction, -1);
  const actor = auditItem.actor as unknown as {
    M: {
      id: { S: string };
      displayName: { S: string };
    };
  };

  expect(response.statusCode).toBe(201);
  expect(auditItem.actorUserId.S).toBe('demo@example.com');
  expect(actor.M.id.S).toBe('demo@example.com');
  expect(actor.M.displayName.S).toBe('demo@example.com');
});

test('inline lambda keeps audit event identity stable when member retry changes the event type', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const directoryItems = createInlineProjectMemberFixtureItems();
  const transactions: Array<Array<Record<string, unknown>>> = [];
  const storedEventIds = new Set<string>();
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand') {
      return { Items: directoryItems };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      const transactItems = command.input.TransactItems as Array<Record<string, unknown>>;
      const memberItem = readDynamoTransactPutItem(transactItems, 1);
      const auditItem = readDynamoTransactPutItem(transactItems, -1);
      const eventId = String(auditItem.eventId.S);

      transactions.push(transactItems);

      if (storedEventIds.has(eventId)) {
        throw createTransactionCanceledError(
          transactItems.map((_, index) =>
            index === transactItems.length - 1 ? 'ConditionalCheckFailed' : 'None'),
        );
      }

      storedEventIds.add(eventId);
      directoryItems.push(memberItem as (typeof directoryItems)[number]);
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });
  const baseRequest = createLambdaEvent(
    'PATCH',
    '/api/projects/refero/members/sato%40example.com',
  );
  const request = {
    ...baseRequest,
    body: JSON.stringify({ role: 'member' }),
    headers: {
      ...baseRequest.headers,
      'idempotency-key': 'member-request-1',
    },
  };

  try {
    const first = await lambda.handler(request);
    const second = await lambda.handler(request);
    const firstAuditItem = readDynamoTransactPutItem(transactions[0], -1);
    const secondAuditItem = readDynamoTransactPutItem(transactions[1], -1);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(firstAuditItem.eventType.S).toBe('member.added');
    expect(secondAuditItem.eventType.S).toBe('member.updated');
    expect(secondAuditItem.eventId.S).toBe(firstAuditItem.eventId.S);
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda scopes comment targets to their team issue', async () => {
  let transaction: Array<Record<string, unknown>> | undefined;
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'DirectoryTable') {
      return { Items: createInlineProjectMemberFixtureItems() };
    }

    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'TeamIssuesTable') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            directoryTeamId: { S: 'user#demo@example.com#team#core-team' },
            teamId: { S: 'core-team' },
            issueId: { S: 'issue-1' },
            title: { S: 'Scoped comment' },
            assignedProjectId: { S: 'refero' },
            assigneeUserId: { S: 'sato@example.com' },
            status: { S: 'todo' },
            dueDate: { S: '2026/07/31' },
            priority: { S: 'high' },
            createdAt: { S: '2026-07-11T00:00:00.000Z' },
            updatedAt: { S: '2026-07-11T00:00:00.000Z' },
          },
        ],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      transaction = command.input.TransactItems as Array<Record<string, unknown>>;
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });
  const response = await lambda.handler({
    ...createLambdaEvent('POST', '/api/teams/core-team/issues/issue-1/comments'),
    body: JSON.stringify({ body: 'Scoped comment body' }),
  });
  const specializedItem = readDynamoTransactPutItem(transaction, 1);
  const auditItem = readDynamoTransactPutItem(transaction, 2);

  expect(response.statusCode).toBe(201);
  expect(auditItem.entityId.S).toBe('team/core-team/issue/issue-1');
  expect(auditItem.targetId.S).toBe(
    `team/core-team/issue/issue-1/comment/${specializedItem.eventId.S}`,
  );
});

test('inline lambda scopes issue activity and binds its cursor to the query', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const auditQueries: Array<Record<string, unknown>> = [];
  const workItemId = 'team/core-team/issue/issue-1';
  const entityKey = `user#demo@example.com#work-item#${workItemId}`;
  const occurredAt = '2026-07-11T00:00:00.000Z';
  const lastEvaluatedKey = {
    directoryId: { S: 'user#demo@example.com' },
    eventId: { S: 'evt-1' },
    entityKey: { S: entityKey },
    entityEventKey: { S: `${occurredAt}#evt-1` },
  };
  const lambda = createInlineLambda(async (command) => {
    if (command.constructor.name !== 'QueryCommand') {
      return {};
    }

    if (command.input.TableName === 'DirectoryTable') {
      return { Items: createInlineProjectMemberFixtureItems() };
    }

    if (command.input.TableName === 'TeamIssuesTable') {
      return {
        Items: [
          {
            directoryId: { S: 'user#demo@example.com' },
            directoryTeamId: { S: 'user#demo@example.com#team#core-team' },
            teamId: { S: 'core-team' },
            issueId: { S: 'issue-1' },
            title: { S: 'Scoped audit' },
            assignedProjectId: { S: 'refero' },
            assigneeUserId: { S: 'sato@example.com' },
            status: { S: 'todo' },
            dueDate: { S: '2026/07/31' },
            priority: { S: 'high' },
            createdAt: { S: occurredAt },
            updatedAt: { S: occurredAt },
          },
        ],
      };
    }

    if (command.input.TableName === 'AuditEventsTable') {
      auditQueries.push(command.input);
      return {
        Items: [
          {
            ...lastEvaluatedKey,
            workspaceId: { S: 'user#demo@example.com' },
            workspaceKey: { S: 'user#demo@example.com' },
            workspaceEventKey: { S: `${occurredAt}#evt-1` },
            actor: {
              M: {
                id: { S: 'demo-sub' },
                kind: { S: 'user' },
                displayName: { S: 'demo@example.com' },
              },
            },
            actorUserId: { S: 'demo-sub' },
            actorKey: { S: 'user#demo@example.com#actor#demo-sub' },
            actorEventKey: { S: `${occurredAt}#evt-1` },
            entity: { M: { type: { S: 'work-item' }, id: { S: workItemId } } },
            entityType: { S: 'work-item' },
            entityId: { S: workItemId },
            target: { M: { type: { S: 'work-item' }, id: { S: workItemId } } },
            targetType: { S: 'work-item' },
            targetId: { S: workItemId },
            targetKey: { S: entityKey },
            targetEventKey: { S: `${occurredAt}#evt-1` },
            schemaVersion: { N: '1' },
            eventType: { S: 'work-item.updated' },
            action: { S: 'updated' },
            occurredAt: { S: occurredAt },
            occurredAtEventId: { S: `${occurredAt}#evt-1` },
            correlationId: { S: 'correlation-1' },
            idempotencyKeyHash: { S: 'secret-idempotency-hash' },
            requestFingerprint: { S: 'secret-request-fingerprint' },
            source: { S: 'api' },
            sourceDetails: { M: { kind: { S: 'api' }, route: { S: '/internal' } } },
            changes: { L: [] },
            metadata: {
              M: {
                adapter: { S: 'team-issue' },
                legacyKey: { S: 'user#demo@example.com#internal-partition' },
              },
            },
            expiresAt: { N: '2000000000' },
            outboxStatus: { S: 'pending' },
          },
        ],
        LastEvaluatedKey: lastEvaluatedKey,
      };
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });

  try {
    const first = await lambda.handler(createLambdaEvent(
      'GET',
      '/api/teams/core-team/issues/issue-1/activity',
    ));
    const firstBody = JSON.parse(first.body) as {
      events: Array<Record<string, unknown>>;
      nextCursor: string;
    };
    const cursorPayload = JSON.parse(Buffer.from(firstBody.nextCursor, 'base64url').toString('utf8')) as {
      version: number;
      indexName: string;
      scopeHash: string;
      lastEvaluatedKey: Record<string, unknown>;
    };

    expect(first.statusCode).toBe(200);
    expect(auditQueries[0]).toMatchObject({
      IndexName: 'EntityOccurredAtIndex',
      ExpressionAttributeValues: {
        ':partition': { S: entityKey },
        ':to': { S: '9999-12-31T23:59:59.999Z#\uffff' },
      },
    });
    expect(firstBody.events[0]).toMatchObject({
      eventId: 'evt-1',
      workspaceId: 'user#demo@example.com',
      entity: { type: 'work-item', id: workItemId },
      actor: { id: 'demo-sub', kind: 'user', displayName: 'demo@example.com' },
      metadata: { adapter: 'team-issue' },
    });
    expect(firstBody.events[0]).not.toHaveProperty('directoryId');
    expect(firstBody.events[0]).not.toHaveProperty('entityKey');
    expect(firstBody.events[0]).not.toHaveProperty('occurredAtEventId');
    expect(firstBody.events[0]).not.toHaveProperty('requestFingerprint');
    expect(firstBody.events[0]).not.toHaveProperty('idempotencyKeyHash');
    expect(firstBody.events[0]).not.toHaveProperty('expiresAt');
    expect(firstBody.events[0]).not.toHaveProperty('outboxStatus');
    expect(firstBody.events[0]).not.toHaveProperty('sourceDetails');
    expect(cursorPayload).toMatchObject({
      version: 1,
      indexName: 'EntityOccurredAtIndex',
      scopeHash: expect.any(String),
      lastEvaluatedKey,
    });

    const secondEvent = {
      ...createLambdaEvent('GET', '/api/teams/core-team/issues/issue-1/activity'),
      queryStringParameters: { cursor: firstBody.nextCursor },
    };
    const second = await lambda.handler(secondEvent);

    expect(second.statusCode).toBe(200);
    expect(auditQueries[1]).toMatchObject({ ExclusiveStartKey: lastEvaluatedKey });

    const mismatchedEvent = {
      ...createLambdaEvent('GET', '/api/teams/core-team/issues/issue-1/activity'),
      queryStringParameters: {
        cursor: firstBody.nextCursor,
        eventType: 'comment.created',
      },
    };
    const mismatched = await lambda.handler(mismatchedEvent);

    expect(mismatched.statusCode).toBe(400);
    expect(JSON.parse(mismatched.body)).toEqual({ message: 'Audit cursor is invalid.' });

    const wrongPartitionCursor = Buffer.from(JSON.stringify({
      ...cursorPayload,
      lastEvaluatedKey: {
        ...lastEvaluatedKey,
        entityKey: { S: 'user#demo@example.com#work-item#team/other/issue/issue-1' },
      },
    }), 'utf8').toString('base64url');
    const wrongPartition = await lambda.handler({
      ...createLambdaEvent('GET', '/api/teams/core-team/issues/issue-1/activity'),
      queryStringParameters: { cursor: wrongPartitionCursor },
    });

    expect(wrongPartition.statusCode).toBe(400);

    const wrongWorkspaceCursor = Buffer.from(JSON.stringify({
      ...cursorPayload,
      lastEvaluatedKey: {
        ...lastEvaluatedKey,
        directoryId: { S: 'other-workspace' },
      },
    }), 'utf8').toString('base64url');
    const wrongWorkspace = await lambda.handler({
      ...createLambdaEvent('GET', '/api/teams/core-team/issues/issue-1/activity'),
      queryStringParameters: { cursor: wrongWorkspaceCursor },
    });

    expect(wrongWorkspace.statusCode).toBe(400);
    expect(auditQueries).toHaveLength(2);
  } finally {
    consoleError.mockRestore();
  }
});

test('inline lambda rejects access tokens from unexpected Cognito user pools', async () => {
  const lambda = createInlineLambda(async () => {
    throw new Error('DynamoDB should not be called for an unexpected issuer.');
  });
  const event = createLambdaEvent('GET', '/api/projects/refero/tasks');

  event.headers.authorization = `Bearer ${createAccessToken(
    [],
    'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_other',
  )}`;

  const response = await lambda.handler(event);

  expect(response.statusCode).toBe(401);
  expect(JSON.parse(response.body)).toEqual({
    message: 'Authentication failed.',
  });
});

function createInlineProjectMemberFixtureItems(
  options: {
    archivedProject?: boolean;
    archivedTeam?: boolean;
    includeOtherManager?: boolean;
    includeTargetMember?: boolean;
    targetRole?: 'manager' | 'member' | 'viewer';
  } = {},
) {
  const includeOtherManager = options.includeOtherManager ?? true;
  const includeTargetMember = options.includeTargetMember ?? true;
  const targetRole = options.targetRole ?? 'manager';

  return [
    {
      directoryId: { S: 'user#demo@example.com' },
      entryKey: { S: '000010#000000#TEAM#core-team' },
      entryType: { S: 'team' },
      teamId: { S: 'core-team' },
      teamSortOrder: { N: '10' },
      nameJa: { S: 'コアチーム' },
      nameEn: { S: 'Core Team' },
      expanded: { BOOL: true },
      ...(options.archivedTeam ? { archivedAt: { S: '2026-06-08T00:00:00.000Z' } } : {}),
    },
    {
      directoryId: { S: 'user#demo@example.com' },
      entryKey: { S: '000010#000010#PROJECT#refero' },
      entryType: { S: 'project' },
      teamId: { S: 'core-team' },
      teamSortOrder: { N: '10' },
      projectId: { S: 'refero' },
      projectSortOrder: { N: '10' },
      nameJa: { S: 'Refero' },
      nameEn: { S: 'Refero' },
      tone: { S: 'blue' },
      ...(options.archivedProject ? { archivedAt: { S: '2026-06-08T00:00:00.000Z' } } : {}),
    },
    ...(includeTargetMember
      ? [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#demo@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'demo@example.com' },
            email: { S: 'demo@example.com' },
            role: { S: targetRole },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ]
      : []),
    ...(includeOtherManager
      ? [
          {
            directoryId: { S: 'user#demo@example.com' },
            entryKey: { S: 'PROJECT_MEMBER#refero#zmanager@example.com' },
            entryType: { S: 'project-member' },
            projectId: { S: 'refero' },
            memberKey: { S: 'zmanager@example.com' },
            email: { S: 'zmanager@example.com' },
            role: { S: 'manager' },
            createdAt: { S: '2026-06-08T00:00:00.000Z' },
            updatedAt: { S: '2026-06-08T00:00:00.000Z' },
          },
        ]
      : []),
  ];
}

function createProjectManagerAssignmentFixture(memberKey: string, archivedProject = false) {
  return [
    {
      directoryId: { S: 'user#demo@example.com' },
      entryKey: { S: '000010#000000#TEAM#core-team' },
      entryType: { S: 'team' },
      teamId: { S: 'core-team' },
      teamSortOrder: { N: '10' },
      nameJa: { S: 'コアチーム' },
      nameEn: { S: 'Core Team' },
      expanded: { BOOL: true },
    },
    {
      directoryId: { S: 'user#demo@example.com' },
      entryKey: { S: '000010#000010#PROJECT#refero' },
      entryType: { S: 'project' },
      teamId: { S: 'core-team' },
      teamSortOrder: { N: '10' },
      projectId: { S: 'refero' },
      projectSortOrder: { N: '10' },
      nameJa: { S: 'Refero' },
      nameEn: { S: 'Refero' },
      tone: { S: 'blue' },
      ...(archivedProject ? { archivedAt: { S: '2026-06-08T00:00:00.000Z' } } : {}),
    },
    {
      directoryId: { S: 'user#demo@example.com' },
      entryKey: { S: `PROJECT_MEMBER#refero#${memberKey}` },
      entryType: { S: 'project-member' },
      projectId: { S: 'refero' },
      memberKey: { S: memberKey },
      email: { S: memberKey },
      role: { S: 'manager' },
      createdAt: { S: '2026-06-08T00:00:00.000Z' },
      updatedAt: { S: '2026-06-08T00:00:00.000Z' },
    },
  ];
}

/**
 * DynamoDB transaction fixture から指定位置の Put item を取得します。
 */
function readDynamoTransactPutItem(
  transactItems: Array<Record<string, unknown>> | undefined,
  index: number,
) {
  const transactItem = transactItems?.at(index);
  const put = transactItem?.Put;

  if (!put || typeof put !== 'object' || !('Item' in put)) {
    throw new TypeError(`Transaction item ${index} is not a DynamoDB Put.`);
  }

  const item = put.Item;

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError(`Transaction item ${index} does not contain a DynamoDB item.`);
  }

  return item as Record<string, { S?: string }>;
}

function createInlineProjectTaskItem(status = 'todo') {
  return {
    directoryId: { S: 'user#demo@example.com' },
    directoryProjectId: { S: 'user#demo@example.com#project#refero' },
    projectId: { S: 'refero' },
    taskId: { S: 'wireframe' },
    sortOrder: { N: '10' },
    title: { S: 'Wireframe' },
    assigneeUserId: { S: 'sato@example.com' },
    status: { S: status },
    dueDate: { S: '2026/06/03' },
    priority: { S: 'high' },
  };
}

function createTransactionCanceledError(cancellationReasonCodes: string[]) {
  return Object.assign(new Error('Transaction was canceled.'), {
    name: 'TransactionCanceledException',
    CancellationReasons: cancellationReasonCodes.map((Code) => ({ Code })),
  });
}

function createInlineTaskStatusFailureLambda(
  transactionError: Error,
  latestTaskExists = true,
) {
  let taskReads = 0;

  return createInlineLambda(async (command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'DirectoryTable') {
      return { Items: [] };
    }

    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'TasksTable') {
      taskReads += 1;

      return {
        Items: taskReads === 1 || latestTaskExists ? [createInlineProjectTaskItem()] : [],
      };
    }

    if (command.constructor.name === 'TransactWriteItemsCommand') {
      throw transactionError;
    }

    return {};
  }, { includeAuditEventsTable: true, workspaceRole: 'owner' });
}

function createInlineLambda(
  dynamoDbSend: (
    command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    },
  ) => Promise<Record<string, unknown>>,
  options: {
    /** Audit events table を inline Lambda の環境変数へ追加するかどうかです。 */
    includeAuditEventsTable?: boolean;
    /** Audit actor ID として返す Cognito sub です。 */
    principalSub?: string | null;
    /** Cognito command を差し替える test callback です。 */
    cognitoSend?: (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
    /** 現在ユーザーとして返す Workspace role です。 */
    workspaceRole?: 'owner' | 'admin' | 'member' | 'guest';
    /** 現在ユーザーとして返す Workspace status です。 */
    workspaceStatus?: 'active' | 'deactivated';
    /** 現在ユーザーの Workspace membership を省略するかどうかです。 */
    omitCurrentWorkspaceMember?: boolean;
    /** default fixture に追加する Workspace records です。 */
    workspaceRecords?: Array<Record<string, unknown>>;
    /** Workspace GetItem の race 状態を差し替える test callback です。 */
    workspaceRecordResolver?: (
      key: { recordKey?: { S?: string }; workspaceId?: { S?: string } } | undefined,
      fallback: Record<string, unknown> | undefined,
    ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  } = {},
) {
  const lambdaCode = readInlineLambdaCode();
  const exports = {};
  const principalSub = options.principalSub === undefined ? 'demo-sub' : options.principalSub;
  const workspaceRecords = [
    ...(options.workspaceRecords ?? []),
    ...createWorkspaceAccessFixtureRecords(
      options.workspaceRole ?? 'member',
      options.workspaceStatus ?? 'active',
    ),
  ].filter((record) => {
    if (!options.omitCurrentWorkspaceMember) {
      return true;
    }

    return (record as { recordKey?: { S?: string } }).recordKey?.S !== 'MEMBER#demo@example.com';
  });
  const context = vm.createContext({
    Buffer,
    console,
    exports,
    process: {
      env: {
        ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
        ...(options.includeAuditEventsTable
          ? {
              AUDIT_EVENTS_TABLE_NAME: 'AuditEventsTable',
              AUDIT_RETENTION_DAYS: '2555',
            }
          : {}),
        COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
        PROJECT_DIRECTORY_TABLE_NAME: 'DirectoryTable',
        SYSTEM_ADMIN_GROUPS: 'mukuroji-system-admins',
        TEAM_ISSUE_EVENTS_TABLE_NAME: 'TeamIssueEventsTable',
        TEAM_ISSUES_TABLE_NAME: 'TeamIssuesTable',
        TASKS_TABLE_NAME: 'TasksTable',
        WORKSPACE_ACCESS_TABLE_NAME: 'WorkspaceAccessTable',
        WORKSPACE_DIRECTORY_ID: 'user#demo@example.com',
      },
    },
    require: (moduleName: string) => {
      if (moduleName === 'node:crypto') {
        return { createHash };
      }

      if (moduleName === '@aws-sdk/client-cognito-identity-provider') {
        return {
          CognitoIdentityProviderClient: function CognitoIdentityProviderClient(
            this: { send: (command: { constructor: { name: string } }) => Promise<Record<string, unknown>> },
          ) {
            this.send = async (command) => {
              if (options.cognitoSend) {
                return options.cognitoSend(command as {
                  constructor: { name: string };
                  input: Record<string, unknown>;
                });
              }

              if (command.constructor.name === 'ListUsersCommand') {
                return {
                  Users: [
                    {
                      Username: 'sato@example.com',
                      Enabled: true,
                      UserStatus: 'CONFIRMED',
                      Attributes: [
                        {
                          Name: 'email',
                          Value: 'sato@example.com',
                        },
                        {
                          Name: 'name',
                          Value: '佐藤 花子',
                        },
                        {
                          Name: 'custom:directory_id',
                          Value: 'user#demo@example.com',
                        },
                      ],
                    },
                  ],
                };
              }

              if (command.constructor.name === 'AdminGetUserCommand') {
                const username = String((command as { input?: { Username?: unknown } }).input?.Username ?? 'sato@example.com');
                return {
                  Username: username,
                  Enabled: true,
                  UserStatus: 'CONFIRMED',
                  UserAttributes: [
                    {
                      Name: 'email',
                      Value: username,
                    },
                    {
                      Name: 'name',
                      Value: '佐藤 花子',
                    },
                    {
                      Name: 'custom:directory_id',
                      Value: 'user#demo@example.com',
                    },
                  ],
                };
              }

              return {
                Username: 'demo@example.com',
                UserAttributes: [
                  {
                    Name: 'email',
                    Value: 'demo@example.com',
                  },
                  ...(principalSub
                    ? [
                        {
                          Name: 'sub',
                          Value: principalSub,
                        },
                      ]
                    : []),
                  {
                    Name: 'custom:directory_id',
                    Value: 'user#demo@example.com',
                  },
                ],
              };
            };
          },
          AdminCreateUserCommand: createCommandConstructor('AdminCreateUserCommand'),
          AdminDeleteUserCommand: createCommandConstructor('AdminDeleteUserCommand'),
          AdminGetUserCommand: createCommandConstructor('AdminGetUserCommand'),
          AdminUpdateUserAttributesCommand: createCommandConstructor('AdminUpdateUserAttributesCommand'),
          GetUserCommand: createCommandConstructor('GetUserCommand'),
          ListUsersCommand: createCommandConstructor('ListUsersCommand'),
        };
      }

      if (moduleName === '@aws-sdk/client-dynamodb') {
        return {
          DynamoDBClient: function DynamoDBClient(
            this: {
              send: typeof dynamoDbSend;
            },
          ) {
            this.send = async (command) => {
              if (command.input.TableName === 'WorkspaceAccessTable') {
                if (command.constructor.name === 'GetItemCommand') {
                  const key = command.input.Key as {
                    recordKey?: { S?: string };
                    workspaceId?: { S?: string };
                  } | undefined;
                  const item = workspaceRecords.find((record) => {
                    const candidate = record as {
                      recordKey?: { S?: string };
                      workspaceId?: { S?: string };
                    };
                    return candidate.workspaceId?.S === key?.workspaceId?.S &&
                      candidate.recordKey?.S === key?.recordKey?.S;
                  });
                  const resolvedItem = options.workspaceRecordResolver
                    ? await options.workspaceRecordResolver(key, item)
                    : item;

                  return resolvedItem ? { Item: resolvedItem } : {};
                }

                if (command.constructor.name === 'QueryCommand') {
                  return { Items: workspaceRecords };
                }
              }

              return dynamoDbSend(command);
            };
          },
          DeleteItemCommand: createCommandConstructor('DeleteItemCommand'),
          GetItemCommand: createCommandConstructor('GetItemCommand'),
          PutItemCommand: createCommandConstructor('PutItemCommand'),
          QueryCommand: createCommandConstructor('QueryCommand'),
          TransactWriteItemsCommand: createCommandConstructor('TransactWriteItemsCommand'),
          UpdateItemCommand: createCommandConstructor('UpdateItemCommand'),
        };
      }

      throw new Error(`Unsupported module: ${moduleName}`);
    },
  });

  vm.runInContext(lambdaCode, context);

  return exports as {
    handler: (event: Record<string, unknown>) => Promise<{
      body: string;
      headers: Record<string, string>;
      statusCode: number;
    }>;
  };
}

function createWorkspaceAccessFixtureRecords(
  currentRole: 'owner' | 'admin' | 'member' | 'guest',
  currentStatus: 'active' | 'deactivated',
) {
  const createdAt = '2026-07-11T00:00:00.000Z';

  return [
    {
      workspaceId: { S: 'user#demo@example.com' },
      recordKey: { S: 'WORKSPACE' },
      entryType: { S: 'workspace-meta' },
      activeOwnerCount: { N: currentRole === 'owner' && currentStatus === 'active' ? '1' : '0' },
      version: { N: '1' },
      createdAt: { S: createdAt },
      updatedAt: { S: createdAt },
    },
    createWorkspaceMemberFixture('demo@example.com', 'Demo User', currentRole, currentStatus),
    createWorkspaceMemberFixture('sato@example.com', '佐藤 花子', 'member', 'active'),
    createWorkspaceMemberFixture('viewer@example.com', 'Viewer User', 'guest', 'active'),
  ];
}

function createWorkspaceMemberFixture(
  memberKey: string,
  name: string,
  role: 'owner' | 'admin' | 'member' | 'guest',
  status: 'active' | 'deactivated',
) {
  const createdAt = '2026-07-11T00:00:00.000Z';

  return {
    workspaceId: { S: 'user#demo@example.com' },
    recordKey: { S: `MEMBER#${memberKey}` },
    entryType: { S: 'workspace-member' },
    id: { S: memberKey },
    memberKey: { S: memberKey },
    email: { S: memberKey },
    name: { S: name },
    role: { S: role },
    status: { S: status },
    version: { N: '1' },
    createdAt: { S: createdAt },
    updatedAt: { S: createdAt },
    ...(status === 'deactivated' ? { deactivatedAt: { S: createdAt } } : {}),
  };
}

function createWorkspaceInvitationFixture(
  input: {
    /** 招待対象として保存する正規化済み email です。 */
    email?: string;
    /** 招待の有効期限です。 */
    expiresAt?: string;
    /** Cognito identity の provisioning ownership です。 */
    identityOwnership: 'workspace-created' | 'pre-existing' | 'ambiguous';
    /** 受諾後に作成する Workspace role です。 */
    role?: 'owner' | 'admin' | 'member' | 'guest';
    /** invitation lifecycle の状態です。 */
    status: 'provisioning' | 'pending' | 'delivery-failed' | 'expired' | 'revoked' | 'accepted';
  },
) {
  const createdAt = '2026-07-11T00:00:00.000Z';
  const email = input.email ?? 'invited@example.com';

  return {
    workspaceId: { S: 'user#demo@example.com' },
    recordKey: { S: `INVITATION#${email}` },
    entryType: { S: 'workspace-invitation' },
    id: { S: email },
    email: { S: email },
    role: { S: input.role ?? 'member' },
    status: { S: input.status },
    deliveryStatus: { S: 'not-required' },
    identityOwnership: { S: input.identityOwnership },
    version: { N: '1' },
    expiresAt: { S: input.expiresAt ?? '2099-01-01T00:00:00.000Z' },
    createdAt: { S: createdAt },
    updatedAt: { S: createdAt },
    invitedBy: { S: 'demo@example.com' },
  };
}

function readInlineLambdaCode() {
  const app = new cdk.App();
  const stack = new CdkStack(app, 'InlineLambdaTestStack');
  const template = Template.fromStack(stack);
  const lambdaResource = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) =>
    JSON.stringify(resource).includes('isProjectDirectoryRequest'),
  );

  return String(lambdaResource?.Properties?.Code?.ZipFile ?? '');
}

function createCommandConstructor(name: string) {
  const commandConstructor = function Command(
    this: { input: Record<string, unknown> },
    input: Record<string, unknown>,
  ) {
    this.input = input;
  };

  Object.defineProperty(commandConstructor, 'name', { value: name });

  return commandConstructor;
}

function createLambdaEvent(method: string, rawPath: string, groups: string[] = []) {
  return {
    body: undefined,
    headers: {
      authorization: `Bearer ${createAccessToken(groups)}`,
      origin: 'http://localhost:5173',
    },
    isBase64Encoded: false,
    rawPath,
    requestContext: {
      http: {
        method,
      },
    },
  };
}

function createAccessToken(
  groups: string[],
  issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mukuroji',
) {
  const payload = Buffer
    .from(JSON.stringify({
      'cognito:groups': groups,
      iss: issuer,
    }))
    .toString('base64url');

  return `header.${payload}.signature`;
}
