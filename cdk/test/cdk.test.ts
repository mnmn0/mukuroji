import * as vm from 'node:vm';
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

  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: {
        ALLOWED_ORIGINS: {
          Ref: 'TaskApiAllowedOrigins',
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
      },
    },
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
  });

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
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
  expect(lambdaCode).toContain('toProjectPrincipal');
  expect(lambdaCode).toContain('createDirectoryProjectId');
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
  expect(lambdaCode).toContain('isExpectedCognitoIssuer');
  expect(lambdaCode).toContain('isCognitoUserInDirectory');
  expect(lambdaCode).toContain('AdminGetUserCommand');
  expect(lambdaCode).toContain('ListUsersCommand');
  expect(lambdaCode).toContain('hydrateProjectTasks');
  expect(lambdaCode).toContain('getUserProfile');
  expect(lambdaCode).toContain('async function updateProjectTaskStatus');
  expect(lambdaCode).toContain('async function updateProjectMember');
  expect(lambdaCode).toContain('async function removeProjectMember');
  expect(lambdaCode).toContain('SET #status = :status');
  expect(lambdaCode).toContain('SET archivedAt = :archivedAt');
  expect(lambdaCode).toContain('isActiveDirectoryItem');
  expect(lambdaCode).toContain("'GET,POST,PATCH,DELETE,OPTIONS'");
});

test('inline lambda updates a task status with a conditional update', async () => {
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

    if (command.constructor.name === 'UpdateItemCommand') {
      return {
        Attributes: {
          directoryId: { S: 'user#demo@example.com' },
          directoryProjectId: { S: 'user#demo@example.com#project#refero' },
          projectId: { S: 'refero' },
          taskId: { S: 'wireframe' },
          sortOrder: { N: '10' },
          titleKey: { S: 'tasks.item.wireframe' },
          assigneeKey: { S: 'tasks.assignee.sato' },
          status: { S: 'done' },
          dueDate: { S: '2026/06/03' },
          priority: { S: 'high' },
        },
      };
    }

    return {};
  });

  const response = await lambda.handler({
    ...createLambdaEvent('PATCH', '/api/projects/refero/tasks/wireframe'),
    body: JSON.stringify({ status: 'done' }),
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    task: {
      id: 'wireframe',
      titleKey: 'tasks.item.wireframe',
      assigneeKey: 'tasks.assignee.sato',
      status: 'done',
      dueDate: '2026/06/03',
      priority: 'high',
    },
  });
  expect(commandInputs).toHaveLength(2);
  expect(commandInputs[1]).toEqual({
    commandName: 'UpdateItemCommand',
    input: {
      TableName: 'TasksTable',
      Key: {
        directoryProjectId: { S: 'user#demo@example.com#project#refero' },
        taskId: { S: 'wireframe' },
      },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': { S: 'done' },
      },
      ConditionExpression: 'attribute_exists(directoryProjectId) AND attribute_exists(taskId)',
      ReturnValues: 'ALL_NEW',
    },
  });
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
  });

  const response = await lambda.handler(createLambdaEvent(
    'PATCH',
    '/api/teams/core-team/projects/refero/archive',
  ));
  const body = JSON.parse(response.body) as Record<string, unknown>;

  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,DELETE,OPTIONS');
  expect(body).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  });
  expect(commandInputs).toHaveLength(3);
  expect(commandInputs[2]).toMatchObject({
    commandName: 'UpdateItemCommand',
    input: {
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
  });

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
  expect(commandInputs[1]).toMatchObject({
    commandName: 'UpdateItemCommand',
    input: {
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
  });

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
  expect(commandInputs[2]).toMatchObject({
    commandName: 'PutItemCommand',
    input: {
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
  });

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
  expect(commandInputs[1]).toMatchObject({
    commandName: 'PutItemCommand',
    input: {
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

function createInlineLambda(
  dynamoDbSend: (
    command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    },
  ) => Promise<Record<string, unknown>>,
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
        COGNITO_USER_POOL_ID: 'ap-northeast-1_mukuroji',
        PROJECT_DIRECTORY_TABLE_NAME: 'DirectoryTable',
        SYSTEM_ADMIN_GROUPS: 'mukuroji-system-admins',
        TASKS_TABLE_NAME: 'TasksTable',
      },
    },
    require: (moduleName: string) => {
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
