import * as vm from 'node:vm';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
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
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('ProjectDirectoryTable'),
        },
      },
    },
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
  });

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH']),
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
          Action: 'cognito-idp:GetUser',
          Effect: 'Allow',
          Resource: '*',
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
  expect(directorySeedPayload.match(/"projectId":{"S":"shared-launch"}/g)).toHaveLength(2);
  expect(directorySeedPayload).toContain(
    '"ConditionExpression":"attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)"',
  );
  expect(directorySeedResource?.Properties?.Update).toBeUndefined();

  const lambdaResource = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) =>
    JSON.stringify(resource).includes('isProjectDirectoryRequest'),
  );
  const lambdaCode = lambdaResource?.Properties?.Code?.ZipFile ?? '';

  expect(lambdaCode).toContain('(?:api\\/)?projects\\/([^/]+)\\/tasks');
  expect(lambdaCode).toContain('toProjectDirectoryId');
  expect(lambdaCode).toContain('createDirectoryProjectId');
  expect(lambdaCode).toContain('decodePathSegment');
  expect(lambdaCode).toContain('createUniqueResourceId');
  expect(lambdaCode).toContain('const taskId = createUniqueResourceId(title');
  expect(lambdaCode).toContain('toProjectDataError');
  expect(lambdaCode).toContain('directoryProjectId = :directoryProjectId');
  expect(lambdaCode).toContain('hasProjectAccess');
  expect(lambdaCode).toContain('async function queryAll');
  expect(lambdaCode).toContain('const projectItems = [];');
  expect(lambdaCode).toContain('UpdateItemCommand');
  expect(lambdaCode).toContain('readArchiveTeamId');
  expect(lambdaCode).toContain('readArchiveProjectParams');
  expect(lambdaCode).toContain('readProjectTaskStatusParams');
  expect(lambdaCode).toContain('async function updateProjectTaskStatus');
  expect(lambdaCode).toContain('SET #status = :status');
  expect(lambdaCode).toContain('SET archivedAt = :archivedAt');
  expect(lambdaCode).toContain('isActiveDirectoryItem');
  expect(lambdaCode).toContain("'GET,POST,PATCH,OPTIONS'");
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
  expect(response.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,OPTIONS');
  expect(body).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  });
  expect(commandInputs).toHaveLength(2);
  expect(commandInputs[1]).toMatchObject({
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

  const response = await lambda.handler(createLambdaEvent('PATCH', '/api/teams/core-team/archive'));
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
        PROJECT_DIRECTORY_TABLE_NAME: 'DirectoryTable',
        TASKS_TABLE_NAME: 'TasksTable',
      },
    },
    require: (moduleName: string) => {
      if (moduleName === '@aws-sdk/client-cognito-identity-provider') {
        return {
          CognitoIdentityProviderClient: function CognitoIdentityProviderClient(
            this: { send: () => Promise<Record<string, unknown>> },
          ) {
            this.send = async () => ({
              Username: 'demo@example.com',
              UserAttributes: [
                {
                  Name: 'email',
                  Value: 'demo@example.com',
                },
              ],
            });
          },
          GetUserCommand: createCommandConstructor('GetUserCommand'),
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
          PutItemCommand: createCommandConstructor('PutItemCommand'),
          QueryCommand: createCommandConstructor('QueryCommand'),
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

function createLambdaEvent(method: string, rawPath: string) {
  return {
    body: undefined,
    headers: {
      authorization: 'Bearer test-token',
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
