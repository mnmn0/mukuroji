import * as cdk from 'aws-cdk-lib';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Refero プロジェクトに初期投入するタスク seed データです。
 */
const projectTaskItems = [
  ['refero', 'wireframe', 10, 'tasks.item.wireframe', 'tasks.assignee.sato', 'in-progress', '2026/06/03', 'high'],
  ['refero', 'brand-guideline', 20, 'tasks.item.brandGuideline', 'tasks.assignee.suzuki', 'review', '2026/06/05', 'medium'],
  ['refero', 'pricing-content', 30, 'tasks.item.pricingContent', 'tasks.assignee.tanaka', 'in-progress', '2026/06/08', 'high'],
  ['refero', 'seo-research', 40, 'tasks.item.seoResearch', 'tasks.assignee.yamamoto', 'todo', '2026/06/09', 'medium'],
  ['refero', 'hero-design', 50, 'tasks.item.heroDesign', 'tasks.assignee.sato', 'review', '2026/06/10', 'medium'],
  ['refero', 'analytics-tags', 60, 'tasks.item.analyticsTags', 'tasks.assignee.suzuki', 'in-progress', '2026/06/11', 'low'],
  ['refero', 'competitor-report', 70, 'tasks.item.competitorReport', 'tasks.assignee.tanaka', 'done', '2026/06/02', 'low'],
  ['refero', 'terms-page', 80, 'tasks.item.termsPage', 'tasks.assignee.yamamoto', 'todo', '2026/06/12', 'medium'],
  ['refero', 'faq-content', 90, 'tasks.item.faqContent', 'tasks.assignee.sato', 'todo', '2026/06/15', 'low'],
  ['refero', 'landing-release', 100, 'tasks.item.landingRelease', 'tasks.assignee.suzuki', 'todo', '2026/06/16', 'high'],
] as const;

/**
 * CDK seed が作成する demo user 用 directory partition key です。
 */
const demoUserDirectoryId = 'user#demo@example.com';

function createDirectoryProjectId(directoryId: string, projectId: string) {
  return `${directoryId}#project#${projectId}`;
}

/**
 * サイドバーに表示するチームとプロジェクトの関係 seed データです。
 */
const projectDirectoryItems = [
  {
    entryKey: '000010#000000#TEAM#core-team',
    entryType: 'team',
    teamId: 'core-team',
    teamSortOrder: 10,
    nameJa: 'コアチーム',
    nameEn: 'Core Team',
    expanded: true,
  },
  {
    entryKey: '000010#000010#PROJECT#refero',
    entryType: 'project',
    teamId: 'core-team',
    teamSortOrder: 10,
    projectId: 'refero',
    projectSortOrder: 10,
    nameJa: 'Refero',
    nameEn: 'Refero',
    tone: 'blue',
  },
  {
    entryKey: '000010#000020#PROJECT#product-roadmap',
    entryType: 'project',
    teamId: 'core-team',
    teamSortOrder: 10,
    projectId: 'product-roadmap',
    projectSortOrder: 20,
    nameJa: 'プロダクトロードマップ',
    nameEn: 'Product Roadmap',
    tone: 'yellow',
  },
  {
    entryKey: '000010#000030#PROJECT#shared-launch',
    entryType: 'project',
    teamId: 'core-team',
    teamSortOrder: 10,
    projectId: 'shared-launch',
    projectSortOrder: 30,
    nameJa: '共通ローンチ',
    nameEn: 'Shared Launch',
    tone: 'green',
  },
  {
    entryKey: '000020#000000#TEAM#design-team',
    entryType: 'team',
    teamId: 'design-team',
    teamSortOrder: 20,
    nameJa: 'デザインチーム',
    nameEn: 'Design Team',
    expanded: true,
  },
  {
    entryKey: '000020#000010#PROJECT#shared-launch',
    entryType: 'project',
    teamId: 'design-team',
    teamSortOrder: 20,
    projectId: 'shared-launch',
    projectSortOrder: 10,
    nameJa: '共通ローンチ',
    nameEn: 'Shared Launch',
    tone: 'purple',
  },
  {
    entryKey: '000020#000020#PROJECT#brand-refresh',
    entryType: 'project',
    teamId: 'design-team',
    teamSortOrder: 20,
    projectId: 'brand-refresh',
    projectSortOrder: 20,
    nameJa: 'ブランド刷新',
    nameEn: 'Brand Refresh',
    tone: 'yellow',
  },
] as const;

/**
 * DynamoDB の transaction write item payload を作成します。
 */
function createProjectTaskTransactItems(tableName: string) {
  return projectTaskItems.map(([projectId, taskId, sortOrder, titleKey, assigneeKey, status, dueDate, priority]) => ({
    Put: {
      TableName: tableName,
      Item: {
        directoryId: { S: demoUserDirectoryId },
        directoryProjectId: { S: createDirectoryProjectId(demoUserDirectoryId, projectId) },
        projectId: { S: projectId },
        taskId: { S: taskId },
        sortOrder: { N: String(sortOrder) },
        titleKey: { S: titleKey },
        assigneeKey: { S: assigneeKey },
        status: { S: status },
        dueDate: { S: dueDate },
        priority: { S: priority },
      },
    },
  }));
}

/**
 * サイドバー directory 用の transaction write item payload を作成します。
 */
function createProjectDirectoryTransactItems(tableName: string) {
  return projectDirectoryItems.map((entry) => {
    const item = {
      directoryId: { S: demoUserDirectoryId },
      entryKey: { S: entry.entryKey },
      entryType: { S: entry.entryType },
      teamId: { S: entry.teamId },
      teamSortOrder: { N: String(entry.teamSortOrder) },
      nameJa: { S: entry.nameJa },
      nameEn: { S: entry.nameEn },
      ...(entry.entryType === 'team'
        ? {
            expanded: { BOOL: entry.expanded },
          }
        : {
            projectId: { S: entry.projectId },
            projectSortOrder: { N: String(entry.projectSortOrder) },
            tone: { S: entry.tone },
          }),
    };

    return {
      Put: {
        TableName: tableName,
        Item: item,
      },
    };
  });
}

/**
 * mukuroji のアプリケーションデータ取得基盤を定義する CDK stack です。
 */
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskApiAllowedOrigins = new cdk.CfnParameter(this, 'TaskApiAllowedOrigins', {
      type: 'String',
      default: 'http://localhost:5173,http://127.0.0.1:5173',
      description: 'Comma-separated CORS origins allowed to call the project tasks Lambda Function URL.',
    });
    const taskApiAllowedOriginList = cdk.Fn.split(',', taskApiAllowedOrigins.valueAsString);

    const tasksTable = new dynamodb.Table(this, 'ProjectTasksTable', {
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    tasksTable.addGlobalSecondaryIndex({
      indexName: 'ProjectSortOrderIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const projectDirectoryTable = new dynamodb.Table(this, 'ProjectDirectoryTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entryKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const listTasksFunction = new lambda.Function(this, 'ListProjectTasksFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        ALLOWED_ORIGINS: taskApiAllowedOrigins.valueAsString,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        TASKS_TABLE_NAME: tasksTable.tableName,
      },
      code: lambda.Code.fromInline(`
const { CognitoIdentityProviderClient, GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');

const cognito = new CognitoIdentityProviderClient({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const headers = createHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const accessToken = readBearerAccessToken(event);

  if (!accessToken) {
    return json(401, { message: 'Bearer token is required.' }, headers);
  }

  let directoryId;

  try {
    const user = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
    directoryId = toProjectDirectoryId(user);
  } catch {
    return json(401, { message: 'Authentication failed.' }, headers);
  }

  if (!directoryId) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  if (isProjectDirectoryRequest(event)) {
    return listProjectDirectory(event, headers, directoryId);
  }

  const projectId = event.pathParameters?.projectId ?? event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/tasks$/)?.[1];

  if (!projectId) {
    return json(404, { message: 'Project tasks endpoint was not found.' }, headers);
  }

  const decodedProjectId = decodeURIComponent(projectId);

  try {
    if (!(await hasProjectAccess(directoryId, decodedProjectId))) {
      return json(403, { message: 'Project access is denied.' }, headers);
    }

    const items = await queryAll({
      TableName: process.env.TASKS_TABLE_NAME,
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': { S: createDirectoryProjectId(directoryId, decodedProjectId) },
      },
      ScanIndexForward: true,
    });

    return json(200, {
      projectId: decodedProjectId,
      tasks: items.map(toTask),
    }, headers);
  } catch (error) {
    console.error(error);
    return json(500, { message: 'Failed to load project tasks.' }, headers);
  }
};

async function listProjectDirectory(event, headers, directoryId) {
  const locale = event.queryStringParameters?.locale === 'en' ? 'en' : 'ja';

  try {
    const items = await queryAll({
      TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': { S: directoryId },
      },
      ScanIndexForward: true,
    });

    return json(200, {
      teams: toProjectDirectory(items, locale),
    }, headers);
  } catch (error) {
    console.error(error);
    return json(500, { message: 'Failed to load project directory.' }, headers);
  }
}

function isProjectDirectoryRequest(event) {
  const path = event.rawPath ?? '';
  return path === '/teams/projects' || path === '/api/teams/projects';
}

async function hasProjectAccess(directoryId, projectId) {
  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });

  return items.some((item) => item.entryType?.S === 'project' && item.projectId?.S === projectId);
}

async function queryAll(input) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const response = await dynamodb.send(new QueryCommand({
      ...input,
      ExclusiveStartKey,
    }));

    items.push(...(response.Items ?? []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

function json(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function createHeaders(event) {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const allowedOrigins = parseAllowedOrigins();
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'content-type': 'application/json; charset=utf-8',
    vary: 'origin',
  };
}

function parseAllowedOrigins() {
  const origins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : ['http://localhost:5173'];
}

function readBearerAccessToken(event) {
  const authorization = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  return authorization.match(/^Bearer\\s+(.+)$/i)?.[1];
}

function toProjectDirectoryId(user) {
  const userKey = user.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value ?? user.Username;

  if (!userKey?.trim()) {
    return undefined;
  }

  return 'user#' + userKey.trim().toLowerCase();
}

function createDirectoryProjectId(directoryId, projectId) {
  return directoryId + '#project#' + projectId;
}

function toProjectDirectory(items, locale) {
  const teams = [];
  const teamById = new Map();
  const projectItems = [];

  for (const item of items) {
    if (item.entryType?.S === 'team') {
      const team = {
        id: item.teamId.S,
        name: localizedName(item, locale),
        expanded: item.expanded?.BOOL ?? false,
        projects: [],
      };

      teamById.set(team.id, team);
      teams.push(team);
      continue;
    }

    if (item.entryType?.S === 'project') {
      projectItems.push(item);
    }
  }

  for (const item of projectItems) {
    const team = teamById.get(item.teamId.S);

    if (team) {
      team.projects.push({
        id: item.projectId.S,
        name: localizedName(item, locale),
        tone: item.tone?.S,
      });
    }
  }

  return teams;
}

function localizedName(item, locale) {
  return locale === 'en' ? item.nameEn?.S ?? item.nameJa.S : item.nameJa?.S ?? item.nameEn.S;
}

function toTask(item) {
  return {
    id: item.taskId.S,
    titleKey: item.titleKey.S,
    assigneeKey: item.assigneeKey.S,
    status: item.status.S,
    dueDate: item.dueDate.S,
    priority: item.priority.S,
  };
}
      `),
    });

    tasksTable.grantReadData(listTasksFunction);
    projectDirectoryTable.grantReadData(listTasksFunction);
    listTasksFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:GetUser'],
        resources: ['*'],
      }),
    );

    const tasksFunctionUrl = listTasksFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: taskApiAllowedOriginList,
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['authorization', 'content-type'],
      },
    });

    const seedProjectTasksCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createProjectTaskTransactItems(tasksTable.tableName),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('refero-project-tasks-seed-v2'),
    };
    const seedTasks = new customResources.AwsCustomResource(this, 'SeedProjectTasks', {
      onCreate: seedProjectTasksCall,
      onUpdate: seedProjectTasksCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [tasksTable.tableArn],
        }),
      ]),
    });

    seedTasks.node.addDependency(tasksTable);

    const seedProjectDirectoryCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createProjectDirectoryTransactItems(projectDirectoryTable.tableName),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('project-directory-seed-v2'),
    };
    const seedProjectDirectory = new customResources.AwsCustomResource(this, 'SeedProjectDirectory', {
      onCreate: seedProjectDirectoryCall,
      onUpdate: seedProjectDirectoryCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [projectDirectoryTable.tableArn],
        }),
      ]),
    });

    seedProjectDirectory.node.addDependency(projectDirectoryTable);

    new cdk.CfnOutput(this, 'ProjectTasksTableName', {
      value: tasksTable.tableName,
    });

    new cdk.CfnOutput(this, 'ProjectDirectoryTableName', {
      value: projectDirectoryTable.tableName,
    });

    new cdk.CfnOutput(this, 'ProjectTasksApiUrl', {
      value: tasksFunctionUrl.url,
    });
  }
}
