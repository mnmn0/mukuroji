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

function createProjectMemberEntryKey(projectId: string, memberKey: string) {
  return `PROJECT_MEMBER#${projectId}#${memberKey}`;
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
 * CDK seed が作成する demo user 用 project member seed データです。
 */
const projectMemberItems = [
  ['refero', 'demo@example.com', 'demo@example.com', 'Demo User', 'manager'],
  ['refero', 'sato@example.com', 'sato@example.com', '佐藤 花子', 'member'],
  ['refero', 'viewer@example.com', 'viewer@example.com', 'Viewer User', 'viewer'],
  ['product-roadmap', 'demo@example.com', 'demo@example.com', 'Demo User', 'manager'],
  ['shared-launch', 'demo@example.com', 'demo@example.com', 'Demo User', 'manager'],
  ['brand-refresh', 'demo@example.com', 'demo@example.com', 'Demo User', 'manager'],
] as const;

/**
 * DynamoDB の transaction write item payload を作成します。
 */
function createProjectTaskTransactItems(tableName: string) {
  return projectTaskItems.map(([projectId, taskId, sortOrder, titleKey, assigneeKey, status, dueDate, priority]) => ({
    Put: {
      TableName: tableName,
      ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
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
  const directoryItems = projectDirectoryItems.map((entry) => {
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
        ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        Item: item,
      },
    };
  });
  const memberItems = projectMemberItems.map(([projectId, memberKey, email, name, role]) => ({
    Put: {
      TableName: tableName,
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
      Item: {
        directoryId: { S: demoUserDirectoryId },
        entryKey: { S: createProjectMemberEntryKey(projectId, memberKey) },
        entryType: { S: 'project-member' },
        projectId: { S: projectId },
        memberKey: { S: memberKey },
        email: { S: email },
        name: { S: name },
        role: { S: role },
        createdAt: { S: '2026-06-08T00:00:00.000Z' },
        updatedAt: { S: '2026-06-08T00:00:00.000Z' },
      },
    },
  }));

  return [...directoryItems, ...memberItems];
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
    const systemAdminGroups = new cdk.CfnParameter(this, 'SystemAdminGroups', {
      type: 'String',
      default: 'mukuroji-system-admins',
      description: 'Comma-separated Cognito group names that grant system administrator privileges.',
    });

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
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TASKS_TABLE_NAME: tasksTable.tableName,
      },
      code: lambda.Code.fromInline(`
const { CognitoIdentityProviderClient, GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient, DeleteItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

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

  let principal;
  let directoryId;

  try {
    const user = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
    principal = toProjectPrincipal(user, accessToken);
    directoryId = principal?.directoryId;
  } catch {
    return json(401, { message: 'Authentication failed.' }, headers);
  }

  if (!directoryId) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  if (isCreateTeamRequest(event)) {
    if (!principal.isSystemAdmin) {
      return json(403, { message: 'Project access is denied.' }, headers);
    }

    try {
      return await createTeam(event, headers, directoryId);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to create team.');
    }
  }

  const createProjectTeamId = readCreateProjectTeamId(event);

  if (createProjectTeamId) {
    if (!principal.isSystemAdmin) {
      return json(403, { message: 'Project access is denied.' }, headers);
    }

    try {
      return await createProject(event, headers, directoryId, createProjectTeamId);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to create project.');
    }
  }

  const archiveTeamId = readArchiveTeamId(event);

  if (archiveTeamId) {
    if (!principal.isSystemAdmin) {
      return json(403, { message: 'Project access is denied.' }, headers);
    }

    try {
      return await archiveTeam(headers, directoryId, archiveTeamId);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to archive team.');
    }
  }

  const archiveProjectParams = readArchiveProjectParams(event);

  if (archiveProjectParams) {
    try {
      const permissionError = await enforceProjectPermission(
        headers,
        principal,
        archiveProjectParams.projectId,
        'manager',
      );

      if (permissionError) {
        return permissionError;
      }

      return await archiveProject(
        headers,
        directoryId,
        archiveProjectParams.teamId,
        archiveProjectParams.projectId,
      );
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to archive project.');
    }
  }

  const projectMembersProjectId = readProjectMembersProjectId(event);

  if (projectMembersProjectId) {
    const permissionError = await enforceProjectPermission(
      headers,
      principal,
      projectMembersProjectId,
      'manager',
    );

    if (permissionError) {
      return permissionError;
    }

    return listProjectMembers(headers, directoryId, projectMembersProjectId);
  }

  const projectMemberParams = readProjectMemberParams(event);

  if (projectMemberParams) {
    const permissionError = await enforceProjectPermission(
      headers,
      principal,
      projectMemberParams.projectId,
      'manager',
    );

    if (permissionError) {
      return permissionError;
    }

    if (event.requestContext?.http?.method === 'PATCH') {
      return updateProjectMember(event, headers, directoryId, projectMemberParams.projectId, projectMemberParams.memberKey);
    }

    return removeProjectMember(headers, directoryId, projectMemberParams.projectId, projectMemberParams.memberKey);
  }

  if (isProjectDirectoryRequest(event)) {
    return listProjectDirectory(event, headers, directoryId);
  }

  const taskStatusParams = readProjectTaskStatusParams(event);
  const projectId =
    taskStatusParams?.projectId ??
    event.pathParameters?.projectId ??
    event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/tasks$/)?.[1];

  if (!projectId) {
    return json(404, { message: 'Project tasks endpoint was not found.' }, headers);
  }

  const decodedProjectId = taskStatusParams?.projectId ?? decodePathSegment(projectId);

  if (!decodedProjectId) {
    return json(400, { message: 'Project ID is invalid.' }, headers);
  }

  try {
    const permissionError = await enforceProjectPermission(
      headers,
      principal,
      decodedProjectId,
      event.requestContext?.http?.method === 'GET' ? 'viewer' : 'member',
    );

    if (permissionError) {
      return permissionError;
    }

    if (event.requestContext?.http?.method === 'POST') {
      return await createProjectTask(event, headers, directoryId, decodedProjectId);
    }

    if (taskStatusParams) {
      return await updateProjectTaskStatus(
        event,
        headers,
        directoryId,
        decodedProjectId,
        taskStatusParams.taskId,
      );
    }

    if (event.requestContext?.http?.method !== 'GET') {
      return json(405, { message: 'Method is not allowed.' }, headers);
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
    return toProjectDataError(error, headers, 'Failed to load project tasks.');
  }
};

async function createTeam(event, headers, directoryId) {
  const body = readJsonBody(event);
  const names = readLocalizedNames(body);

  if (!names) {
    return json(400, { message: 'Name is required.' }, headers);
  }

  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const teamId = createUniqueResourceId(names.nameJa, items.filter((item) => item.entryType?.S === 'team').map((item) => item.teamId?.S).filter(Boolean));
  const teamSortOrder = Math.max(0, ...items.filter((item) => item.entryType?.S === 'team').map((item) => Number(item.teamSortOrder?.N ?? 0))) + 10;
  const item = {
    directoryId: { S: directoryId },
    entryKey: { S: createTeamEntryKey(teamSortOrder, teamId) },
    entryType: { S: 'team' },
    teamId: { S: teamId },
    teamSortOrder: { N: String(teamSortOrder) },
    nameJa: { S: names.nameJa },
    nameEn: { S: names.nameEn },
    expanded: { BOOL: true },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
  }));

  return json(201, {
    team: {
      id: teamId,
      name: names.nameJa,
      expanded: true,
      projects: [],
    },
  }, headers);
}

async function createProject(event, headers, directoryId, teamId) {
  const body = readJsonBody(event);
  const names = readLocalizedNames(body);

  if (!names) {
    return json(400, { message: 'Name is required.' }, headers);
  }

  const tone = body.tone === undefined ? 'blue' : body.tone;

  if (!isProjectTone(tone)) {
    return json(400, { message: 'Project tone is invalid.' }, headers);
  }

  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const team = items.find((item) => item.entryType?.S === 'team' && item.teamId?.S === teamId && isActiveDirectoryItem(item));

  if (!team) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  const projectId = createUniqueResourceId(names.nameJa, items.filter((item) => item.entryType?.S === 'project').map((item) => item.projectId?.S).filter(Boolean));
  const teamSortOrder = Number(team.teamSortOrder.N);
  const projectSortOrder = Math.max(0, ...items.filter((item) => item.entryType?.S === 'project' && item.teamId?.S === teamId).map((item) => Number(item.projectSortOrder?.N ?? 0))) + 10;
  const item = {
    directoryId: { S: directoryId },
    entryKey: { S: createProjectEntryKey(teamSortOrder, projectSortOrder, projectId) },
    entryType: { S: 'project' },
    teamId: { S: teamId },
    teamSortOrder: { N: String(teamSortOrder) },
    projectId: { S: projectId },
    projectSortOrder: { N: String(projectSortOrder) },
    nameJa: { S: names.nameJa },
    nameEn: { S: names.nameEn },
    tone: { S: tone },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
  }));

  return json(201, {
    project: {
      id: projectId,
      name: names.nameJa,
      tone,
    },
  }, headers);
}

async function archiveTeam(headers, directoryId, teamId) {
  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const team = items.find((item) => item.entryType?.S === 'team' && item.teamId?.S === teamId && isActiveDirectoryItem(item));

  if (!team) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  const archivedAt = new Date().toISOString();

  await dynamodb.send(new UpdateItemCommand({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Key: {
      directoryId: { S: directoryId },
      entryKey: { S: team.entryKey.S },
    },
    UpdateExpression: 'SET archivedAt = :archivedAt',
    ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
    ExpressionAttributeValues: {
      ':archivedAt': { S: archivedAt },
    },
  }));

  return json(200, { teamId, archivedAt }, headers);
}

async function archiveProject(headers, directoryId, teamId, projectId) {
  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const team = items.find((item) => item.entryType?.S === 'team' && item.teamId?.S === teamId && isActiveDirectoryItem(item));

  if (!team) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  const project = items.find((item) =>
    item.entryType?.S === 'project' &&
    item.teamId?.S === teamId &&
    item.projectId?.S === projectId &&
    isActiveDirectoryItem(item)
  );

  if (!project) {
    return json(404, { message: 'Project was not found.' }, headers);
  }

  const archivedAt = new Date().toISOString();

  await dynamodb.send(new UpdateItemCommand({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Key: {
      directoryId: { S: directoryId },
      entryKey: { S: project.entryKey.S },
    },
    UpdateExpression: 'SET archivedAt = :archivedAt',
    ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
    ExpressionAttributeValues: {
      ':archivedAt': { S: archivedAt },
    },
  }));

  return json(200, { teamId, projectId, archivedAt }, headers);
}

async function listProjectMembers(headers, directoryId, projectId) {
  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const members = items
    .filter((item) => item.entryType?.S === 'project-member' && item.projectId?.S === projectId)
    .sort(compareProjectMembers)
    .map(toProjectMember);

  return json(200, { projectId, members }, headers);
}

async function updateProjectMember(event, headers, directoryId, projectId, memberKey) {
  const body = readJsonBody(event);
  const normalizedMemberKey = normalizeProjectMemberKey(memberKey);
  const email = body.email === undefined ? normalizedMemberKey : normalizeProjectMemberKey(body.email);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;

  if (!normalizedMemberKey || !email) {
    return json(400, { message: 'Project member email is required.' }, headers);
  }

  if (!isProjectRole(body.role)) {
    return json(400, { message: 'Project role is invalid.' }, headers);
  }

  const existingMembers = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const existingMember = existingMembers.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === normalizedMemberKey
  );
  const updatedAt = new Date().toISOString();
  const item = {
    directoryId: { S: directoryId },
    entryKey: { S: createProjectMemberEntryKey(projectId, normalizedMemberKey) },
    entryType: { S: 'project-member' },
    projectId: { S: projectId },
    memberKey: { S: normalizedMemberKey },
    email: { S: email },
    role: { S: body.role },
    createdAt: { S: existingMember?.createdAt?.S ?? updatedAt },
    updatedAt: { S: updatedAt },
    ...(name ? { name: { S: name } } : {}),
  };

  await dynamodb.send(new PutItemCommand({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Item: item,
  }));

  return json(200, { member: toProjectMember(item) }, headers);
}

async function removeProjectMember(headers, directoryId, projectId, memberKey) {
  const normalizedMemberKey = normalizeProjectMemberKey(memberKey);

  if (!normalizedMemberKey) {
    return json(400, { message: 'Project member email is required.' }, headers);
  }
  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === normalizedMemberKey
  );

  if (!member) {
    return json(404, { message: 'Project member was not found.' }, headers);
  }

  await dynamodb.send(new DeleteItemCommand({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Key: {
      directoryId: { S: directoryId },
      entryKey: { S: member.entryKey.S },
    },
    ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey)',
  }));

  return json(200, { projectId, memberId: normalizedMemberKey }, headers);
}

async function createProjectTask(event, headers, directoryId, projectId) {
  const body = readJsonBody(event);

  if (
    typeof body.title !== 'string' ||
    typeof body.assignee !== 'string' ||
    typeof body.dueDate !== 'string' ||
    !body.title.trim() ||
    !body.assignee.trim() ||
    !body.dueDate.trim()
  ) {
    return json(400, { message: 'Task title, assignee, and due date are required.' }, headers);
  }

  if (!isTaskStatus(body.status) || !isTaskPriority(body.priority)) {
    return json(400, { message: 'Task status or priority is invalid.' }, headers);
  }

  const title = body.title.trim();
  const assignee = body.assignee.trim();
  const dueDate = body.dueDate.trim();
  const directoryProjectId = createDirectoryProjectId(directoryId, projectId);
  const items = await queryAll({
    TableName: process.env.TASKS_TABLE_NAME,
    IndexName: 'ProjectSortOrderIndex',
    KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
    ExpressionAttributeValues: {
      ':directoryProjectId': { S: directoryProjectId },
    },
    ScanIndexForward: true,
  });
  const taskId = createUniqueResourceId(title, items.map((item) => item.taskId?.S).filter(Boolean));
  const item = {
    directoryId: { S: directoryId },
    directoryProjectId: { S: directoryProjectId },
    projectId: { S: projectId },
    taskId: { S: taskId },
    sortOrder: { N: String((items.length + 1) * 10) },
    title: { S: title },
    assignee: { S: assignee },
    status: { S: body.status },
    dueDate: { S: dueDate },
    priority: { S: body.priority },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: process.env.TASKS_TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
  }));

  return json(201, {
    task: toTask(item),
  }, headers);
}

async function updateProjectTaskStatus(event, headers, directoryId, projectId, taskId) {
  const body = readJsonBody(event);

  if (!isTaskStatus(body.status)) {
    return json(400, { message: 'Task status is invalid.' }, headers);
  }

  const directoryProjectId = createDirectoryProjectId(directoryId, projectId);
  let response;

  try {
    response = await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.TASKS_TABLE_NAME,
      Key: {
        directoryProjectId: { S: directoryProjectId },
        taskId: { S: taskId },
      },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': { S: body.status },
      },
      ConditionExpression: 'attribute_exists(directoryProjectId) AND attribute_exists(taskId)',
      ReturnValues: 'ALL_NEW',
    }));
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return json(404, { message: 'Task was not found.' }, headers);
    }

    throw error;
  }

  return json(200, {
    task: toTask(response.Attributes),
  }, headers);
}

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

function isCreateTeamRequest(event) {
  const path = event.rawPath ?? '';
  return event.requestContext?.http?.method === 'POST' && (path === '/teams' || path === '/api/teams');
}

function readCreateProjectTeamId(event) {
  if (event.requestContext?.http?.method !== 'POST') {
    return undefined;
  }

  const encodedTeamId = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/projects$/)?.[1];

  return encodedTeamId ? decodePathSegment(encodedTeamId) : undefined;
}

function readArchiveTeamId(event) {
  if (event.requestContext?.http?.method !== 'PATCH') {
    return undefined;
  }

  const encodedTeamId = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/archive$/)?.[1];

  return encodedTeamId ? decodePathSegment(encodedTeamId) : undefined;
}

function readArchiveProjectParams(event) {
  if (event.requestContext?.http?.method !== 'PATCH') {
    return undefined;
  }

  const match = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/projects\\/([^/]+)\\/archive$/);
  const teamId = match?.[1] ? decodePathSegment(match[1]) : undefined;
  const projectId = match?.[2] ? decodePathSegment(match[2]) : undefined;

  return teamId && projectId ? { teamId, projectId } : undefined;
}

function readProjectMembersProjectId(event) {
  if (event.requestContext?.http?.method !== 'GET') {
    return undefined;
  }

  const encodedProjectId = event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/members$/)?.[1];

  return encodedProjectId ? decodePathSegment(encodedProjectId) : undefined;
}

function readProjectMemberParams(event) {
  if (event.requestContext?.http?.method !== 'PATCH' && event.requestContext?.http?.method !== 'DELETE') {
    return undefined;
  }

  const match = event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/members\\/([^/]+)$/);
  const projectId = match?.[1] ? decodePathSegment(match[1]) : undefined;
  const memberKey = match?.[2] ? decodePathSegment(match[2]) : undefined;

  return projectId && memberKey ? { projectId, memberKey } : undefined;
}

function readProjectTaskStatusParams(event) {
  if (event.requestContext?.http?.method !== 'PATCH') {
    return undefined;
  }

  const match = event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/tasks\\/([^/]+)$/);
  const projectId = match?.[1] ? decodePathSegment(match[1]) : undefined;
  const taskId = match?.[2] ? decodePathSegment(match[2]) : undefined;

  return projectId && taskId ? { projectId, taskId } : undefined;
}

async function enforceProjectPermission(headers, principal, projectId, minimumRole) {
  if (!(await hasProjectAccess(principal.directoryId, projectId))) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  if (principal.isSystemAdmin) {
    return undefined;
  }

  const role = await getProjectRole(principal.directoryId, projectId, principal.userKey);

  if (!role || !projectRoleAllows(role, minimumRole)) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  return undefined;
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

  const activeTeamIds = new Set(
    items
      .filter((item) => item.entryType?.S === 'team' && isActiveDirectoryItem(item))
      .map((item) => item.teamId?.S)
      .filter(Boolean)
  );

  return items.some((item) =>
    item.entryType?.S === 'project' &&
    item.projectId?.S === projectId &&
    activeTeamIds.has(item.teamId?.S) &&
    isActiveDirectoryItem(item)
  );
}

async function getProjectRole(directoryId, projectId, memberKey) {
  const normalizedMemberKey = normalizeProjectMemberKey(memberKey);
  const items = await queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
  });
  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === normalizedMemberKey
  );

  return member?.role?.S;
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

function toProjectDataError(error, headers, fallbackMessage) {
  console.error(error);

  if (error?.name === 'ConditionalCheckFailedException') {
    return json(409, { message: 'The same item already exists.' }, headers);
  }

  if (error?.name === 'ResourceNotFoundException') {
    return json(503, { message: 'Project data is not initialized.' }, headers);
  }

  return json(500, { message: fallbackMessage }, headers);
}

function readJsonBody(event) {
  if (!event.body) {
    return {};
  }

  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function createHeaders(event) {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const allowedOrigins = parseAllowedOrigins();
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

function toProjectPrincipal(user, accessToken) {
  const userKey = user.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value ?? user.Username;

  if (!userKey?.trim()) {
    return undefined;
  }

  const normalizedUserKey = userKey.trim().toLowerCase();
  const directoryId =
    readUserAttribute(user, 'custom:directory_id')?.trim() ||
    readUserAttribute(user, 'custom:workspace_id')?.trim() ||
    'user#' + normalizedUserKey;
  const groups = readCognitoGroups(accessToken);

  return {
    directoryId,
    userKey: normalizedUserKey,
    isSystemAdmin: groups.some((group) => getSystemAdminGroups().includes(group)),
  };
}

function readUserAttribute(user, name) {
  return user.UserAttributes?.find((attribute) => attribute.Name === name)?.Value;
}

function readCognitoGroups(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  const groups = claims?.['cognito:groups'];

  return Array.isArray(groups) ? groups.filter((group) => typeof group === 'string' && group) : [];
}

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];

  if (!payload) {
    return undefined;
  }

  try {
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(normalizedPayload.length + ((4 - normalizedPayload.length % 4) % 4), '=');
    return JSON.parse(Buffer.from(paddedPayload, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function getSystemAdminGroups() {
  const groups = (process.env.SYSTEM_ADMIN_GROUPS ?? 'mukuroji-system-admins')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);

  return groups.length > 0 ? groups : ['mukuroji-system-admins'];
}

function createDirectoryProjectId(directoryId, projectId) {
  return directoryId + '#project#' + projectId;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function readLocalizedNames(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const nameJa = typeof body.nameJa === 'string' ? body.nameJa.trim() : '';
  const nameEn = typeof body.nameEn === 'string' ? body.nameEn.trim() : '';
  const primaryName = nameJa || name || nameEn;

  if (!primaryName) {
    return undefined;
  }

  return {
    nameJa: primaryName,
    nameEn: nameEn || name || primaryName,
  };
}

function createResourceId(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\\p{Letter}\\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'item-' + Date.now();
}

function createUniqueResourceId(value, existingIds) {
  const baseId = createResourceId(value);
  const usedIds = new Set(existingIds);

  if (!usedIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;

  while (usedIds.has(baseId + '-' + suffix)) {
    suffix += 1;
  }

  return baseId + '-' + suffix;
}

function createTeamEntryKey(teamSortOrder, teamId) {
  return padSortOrder(teamSortOrder) + '#000000#TEAM#' + teamId;
}

function createProjectEntryKey(teamSortOrder, projectSortOrder, projectId) {
  return padSortOrder(teamSortOrder) + '#' + padSortOrder(projectSortOrder) + '#PROJECT#' + projectId;
}

function createProjectMemberEntryKey(projectId, memberKey) {
  return 'PROJECT_MEMBER#' + projectId + '#' + memberKey;
}

function padSortOrder(value) {
  return String(value).padStart(6, '0');
}

function toProjectDirectory(items, locale) {
  const teams = [];
  const teamById = new Map();
  const projectItems = [];

  for (const item of items) {
    if (!isActiveDirectoryItem(item)) {
      continue;
    }

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

function toProjectMember(item) {
  const member = {
    id: item.memberKey.S,
    email: item.email.S,
    role: item.role.S,
    updatedAt: item.updatedAt.S,
  };

  if (item.name?.S) {
    member.name = item.name.S;
  }

  return member;
}

function compareProjectMembers(first, second) {
  const roleDelta = projectRoleWeight(second.role?.S) - projectRoleWeight(first.role?.S);

  if (roleDelta !== 0) {
    return roleDelta;
  }

  return (first.name?.S ?? first.email?.S ?? '').localeCompare(second.name?.S ?? second.email?.S ?? '', 'ja');
}

function localizedName(item, locale) {
  return locale === 'en' ? item.nameEn?.S ?? item.nameJa.S : item.nameJa?.S ?? item.nameEn.S;
}

function isActiveDirectoryItem(item) {
  return !item.archivedAt?.S;
}

function toTask(item) {
  const task = {
    id: item.taskId.S,
    status: item.status.S,
    dueDate: item.dueDate.S,
    priority: item.priority.S,
  };

  if (item.titleKey?.S) {
    task.titleKey = item.titleKey.S;
  }

  if (item.title?.S) {
    task.title = item.title.S;
  }

  if (item.assigneeKey?.S) {
    task.assigneeKey = item.assigneeKey.S;
  }

  if (item.assignee?.S) {
    task.assignee = item.assignee.S;
  }

  return task;
}

function isTaskStatus(value) {
  return value === 'in-progress' || value === 'review' || value === 'todo' || value === 'done';
}

function isTaskPriority(value) {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isProjectRole(value) {
  return value === 'manager' || value === 'member' || value === 'viewer';
}

function projectRoleAllows(role, minimumRole) {
  return projectRoleWeight(role) >= projectRoleWeight(minimumRole);
}

function projectRoleWeight(role) {
  if (role === 'manager') {
    return 3;
  }

  if (role === 'member') {
    return 2;
  }

  return role === 'viewer' ? 1 : 0;
}

function normalizeProjectMemberKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isProjectTone(value) {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow';
}
      `),
    });

    tasksTable.grantReadWriteData(listTasksFunction);
    projectDirectoryTable.grantReadWriteData(listTasksFunction);
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
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST, lambda.HttpMethod.PATCH, lambda.HttpMethod.DELETE],
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
