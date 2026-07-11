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
  ).find((resource) => resource.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled);

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

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminGetUser',
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
  expect(seedPayload).toContain('"directoryId":{"S":"user#demo@example.com"}');
  expect(seedPayload).toContain('"directoryProjectId":{"S":"user#demo@example.com#project#refero"}');
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

  expect(directorySeedPayload).toContain('"directoryId":{"S":"user#demo@example.com"}');
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

  const lambdaResource = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) =>
    JSON.stringify(resource).includes('isProjectDirectoryRequest'),
  );
  const lambdaCode = lambdaResource?.Properties?.Code?.ZipFile ?? '';

  expect(lambdaCode).toContain('(?:api\\/)?projects\\/([^/]+)\\/tasks');
  expect(lambdaCode).toContain('(?:api\\/)?projects\\/([^/]+)\\/issues');
  expect(lambdaCode).toContain('(?:api\\/)?teams\\/([^/]+)\\/issues');
  expect(lambdaCode).toContain('toProjectPrincipal');
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
  });

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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
    }

    return {};
  });

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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
    }

    return {};
  });

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
  }, true);

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
  expect(commandInputs).toHaveLength(3);
  expect(commandInputs[2].commandName).toBe('TransactWriteItemsCommand');
  const transactItems = commandInputs[2].input.TransactItems as Array<Record<string, unknown>>;

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
  }, true);

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
  }, true);

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

  expect(transactItems).toHaveLength(2);
  expect(transactItems[0]).toMatchObject({
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
  expect(transactItems[1]).toMatchObject({
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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
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
      const error = new Error('Transaction was canceled.');
      error.name = 'TransactionCanceledException';
      throw error;
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

test('inline lambda lets a system admin update project member roles without project access checks', async () => {
  const commandInputs: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  const lambda = createInlineLambda(async (command) => {
    commandInputs.push({
      commandName: command.constructor.name,
      input: command.input,
    });

    return {};
  }, true);

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

  expect(transactItems).toHaveLength(2);
  expect(transactItems[0]).toMatchObject({
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
  expect(transactItems[1]).toMatchObject({
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
        const error = new Error('Duplicate audit event.');
        error.name = 'TransactionCanceledException';
        throw error;
      }

      storedEventIds.add(eventId);
      teamCreated = true;
    }

    return {};
  }, true);
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
  }, true, null);
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
      const memberItem = readDynamoTransactPutItem(transactItems, 0);
      const auditItem = readDynamoTransactPutItem(transactItems, -1);
      const eventId = String(auditItem.eventId.S);

      transactions.push(transactItems);

      if (storedEventIds.has(eventId)) {
        const error = new Error('Duplicate audit event.');
        error.name = 'TransactionCanceledException';
        throw error;
      }

      storedEventIds.add(eventId);
      directoryItems.push(memberItem as (typeof directoryItems)[number]);
    }

    return {};
  }, true);
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
  }, true);
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
  }, true);

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
  } = {},
) {
  const includeOtherManager = options.includeOtherManager ?? true;
  const includeTargetMember = options.includeTargetMember ?? true;

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
            role: { S: 'manager' },
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

function createInlineLambda(
  dynamoDbSend: (
    command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    },
  ) => Promise<Record<string, unknown>>,
  includeAuditEventsTable = false,
  principalSub: string | null = 'demo-sub',
) {
  const lambdaCode = readInlineLambdaCode();
  const exports = {};
  const context = vm.createContext({
    Buffer,
    console,
    exports,
    process: {
      env: {
        ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
        ...(includeAuditEventsTable
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
                return {
                  Username: 'sato@example.com',
                  Enabled: true,
                  UserStatus: 'CONFIRMED',
                  UserAttributes: [
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
          AdminGetUserCommand: createCommandConstructor('AdminGetUserCommand'),
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
            this.send = dynamoDbSend;
          },
          DeleteItemCommand: createCommandConstructor('DeleteItemCommand'),
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
