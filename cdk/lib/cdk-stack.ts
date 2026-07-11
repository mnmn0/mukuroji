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
  ['refero', 'wireframe', 10, 'tasks.item.wireframe', 'sato@example.com', 'in-progress', '2026/06/03', 'high'],
  ['refero', 'brand-guideline', 20, 'tasks.item.brandGuideline', 'suzuki@example.com', 'review', '2026/06/05', 'medium'],
  ['refero', 'pricing-content', 30, 'tasks.item.pricingContent', 'tanaka@example.com', 'in-progress', '2026/06/08', 'high'],
  ['refero', 'seo-research', 40, 'tasks.item.seoResearch', 'yamamoto@example.com', 'todo', '2026/06/09', 'medium'],
  ['refero', 'hero-design', 50, 'tasks.item.heroDesign', 'sato@example.com', 'review', '2026/06/10', 'medium'],
  ['refero', 'analytics-tags', 60, 'tasks.item.analyticsTags', 'suzuki@example.com', 'in-progress', '2026/06/11', 'low'],
  ['refero', 'competitor-report', 70, 'tasks.item.competitorReport', 'tanaka@example.com', 'done', '2026/06/02', 'low'],
  ['refero', 'terms-page', 80, 'tasks.item.termsPage', 'yamamoto@example.com', 'todo', '2026/06/12', 'medium'],
  ['refero', 'faq-content', 90, 'tasks.item.faqContent', 'sato@example.com', 'todo', '2026/06/15', 'low'],
  ['refero', 'landing-release', 100, 'tasks.item.landingRelease', 'suzuki@example.com', 'todo', '2026/06/16', 'high'],
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
  return projectTaskItems.map(([projectId, taskId, sortOrder, titleKey, assigneeUserId, status, dueDate, priority]) => ({
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
        assigneeUserId: { S: assigneeUserId },
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
    const auditRetentionDays = new cdk.CfnParameter(this, 'AuditRetentionDays', {
      type: 'Number',
      default: 2555,
      minValue: 1,
      description: 'Number of days immutable audit events are retained before DynamoDB TTL expiry.',
    });
    const cognitoUserPoolId = new cdk.CfnParameter(this, 'CognitoUserPoolId', {
      type: 'String',
      description: 'Cognito user pool ID trusted by the project tasks Lambda API.',
    });
    const cognitoUserPoolArn = cdk.Stack.of(this).formatArn({
      service: 'cognito-idp',
      resource: 'userpool',
      resourceName: cognitoUserPoolId.valueAsString,
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

    const teamIssuesTable = new dynamodb.Table(this, 'TeamIssuesTable', {
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'issueId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    teamIssuesTable.addGlobalSecondaryIndex({
      indexName: 'TeamIssueSortOrderIndex',
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    teamIssuesTable.addGlobalSecondaryIndex({
      indexName: 'AssignedProjectIssueIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const teamIssueEventsTable = new dynamodb.Table(this, 'TeamIssueEventsTable', {
      partitionKey: { name: 'directoryTeamIssueId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const projectDirectoryTable = new dynamodb.Table(this, 'ProjectDirectoryTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entryKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const auditEventsTable = new dynamodb.Table(this, 'AuditEventsTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'expiresAt',
    });

    auditEventsTable.addGlobalSecondaryIndex({
      indexName: 'WorkspaceOccurredAtIndex',
      partitionKey: { name: 'workspaceKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'workspaceEventKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    auditEventsTable.addGlobalSecondaryIndex({
      indexName: 'EntityOccurredAtIndex',
      partitionKey: { name: 'entityKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entityEventKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    auditEventsTable.addGlobalSecondaryIndex({
      indexName: 'ActorOccurredAtIndex',
      partitionKey: { name: 'actorKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'actorEventKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    auditEventsTable.addGlobalSecondaryIndex({
      indexName: 'TargetOccurredAtIndex',
      partitionKey: { name: 'targetKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'targetEventKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const processedAuditEventsTable = new dynamodb.Table(this, 'ProcessedAuditEventsTable', {
      partitionKey: { name: 'consumerName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const listTasksFunction = new lambda.Function(this, 'ListProjectTasksFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        ALLOWED_ORIGINS: taskApiAllowedOrigins.valueAsString,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: teamIssuesTable.tableName,
        TASKS_TABLE_NAME: tasksTable.tableName,
      },
      code: lambda.Code.fromInline(`
	const { CognitoIdentityProviderClient, AdminGetUserCommand, GetUserCommand, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient, DeleteItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { createHash } = require('node:crypto');

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
    const expectedUserPoolId = readConfiguredCognitoUserPoolId();

    if (!expectedUserPoolId) {
      return json(503, { message: 'Cognito user pool is not available.' }, headers);
    }

    if (!isExpectedCognitoIssuer(accessToken, expectedUserPoolId)) {
      return json(401, { message: 'Authentication failed.' }, headers);
    }

    const user = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
    principal = toProjectPrincipal(user, accessToken, expectedUserPoolId);
    directoryId = principal?.directoryId;
  } catch {
    return json(401, { message: 'Authentication failed.' }, headers);
  }

  if (!directoryId) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  let mutationContext;

  try {
    mutationContext = createMutationContext(event, principal, directoryId);
  } catch (error) {
    return toProjectDataError(error, headers, 'Mutation request is invalid.');
  }

  if (isWorkspaceAuditRequest(event)) {
    if (!principal.isSystemAdmin) {
      return json(403, { message: 'Project access is denied.' }, headers);
    }

    try {
      return await listWorkspaceAuditEvents(event, headers, directoryId);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to load audit events.');
    }
  }

  const teamIssueActivityParams = readTeamIssueActivityParams(event);

  if (teamIssueActivityParams) {
    const permissionError = await enforceTeamPermission(
      headers,
      principal,
      teamIssueActivityParams.teamId,
      'viewer',
    );

    if (permissionError) {
      return permissionError;
    }

    try {
      return await listTeamIssueActivity(
        event,
        headers,
        directoryId,
        teamIssueActivityParams.teamId,
        teamIssueActivityParams.issueId,
        principal,
      );
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to load issue activity.');
    }
  }

  if (isCreateTeamRequest(event)) {
    if (!principal.isSystemAdmin) {
      return json(403, { message: 'Project access is denied.' }, headers);
    }

    try {
      return await createTeam(event, headers, directoryId, mutationContext);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to create team.');
    }
  }

  const createProjectTeamId = readCreateProjectTeamId(event);

  if (createProjectTeamId) {
    try {
      return await createProject(event, headers, directoryId, createProjectTeamId, principal.userKey, mutationContext);
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
      return await archiveTeam(headers, directoryId, archiveTeamId, mutationContext);
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
        mutationContext,
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
	      'member',
	    );

	    if (permissionError) {
	      return permissionError;
	    }

	    try {
	      return await listProjectMembers(headers, directoryId, projectMembersProjectId, principal.userPoolId);
	    } catch (error) {
	      return toProjectDataError(error, headers, 'Failed to load project members.');
	    }
	  }

	  const projectUsersProjectId = readProjectUsersProjectId(event);

	  if (projectUsersProjectId) {
	    const permissionError = await enforceProjectPermission(
	      headers,
	      principal,
	      projectUsersProjectId,
	      'manager',
	    );

	    if (permissionError) {
	      return permissionError;
	    }

	    try {
	      return await listProjectUsers(event, headers, principal.userPoolId, directoryId);
	    } catch (error) {
	      return toProjectDataError(error, headers, 'Failed to load Cognito users.');
	    }
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
	      try {
	        return await updateProjectMember(event, headers, directoryId, projectMemberParams.projectId, projectMemberParams.memberKey, principal.userPoolId, mutationContext);
	      } catch (error) {
	        return toProjectDataError(error, headers, 'Failed to update project member.');
	      }
	    }

	    try {
	      return await removeProjectMember(headers, directoryId, projectMemberParams.projectId, projectMemberParams.memberKey, mutationContext);
	    } catch (error) {
	      return toProjectDataError(error, headers, 'Failed to remove project member.');
	    }
  }

  const teamIssueCommentParams = readTeamIssueCommentParams(event);

  if (teamIssueCommentParams) {
    const permissionError = await enforceTeamPermission(
      headers,
      principal,
      teamIssueCommentParams.teamId,
      'member',
    );

    if (permissionError) {
      return permissionError;
    }

    try {
      return await createTeamIssueComment(
        event,
        headers,
        directoryId,
        teamIssueCommentParams.teamId,
        teamIssueCommentParams.issueId,
        principal.userKey,
        principal.userPoolId,
        principal,
        mutationContext,
      );
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to create issue comment.');
    }
  }

  const teamIssueDetailParams = readTeamIssueDetailParams(event);

  if (teamIssueDetailParams) {
    const permissionError = await enforceTeamPermission(
      headers,
      principal,
      teamIssueDetailParams.teamId,
      event.requestContext?.http?.method === 'GET' ? 'viewer' : 'member',
    );

    if (permissionError) {
      return permissionError;
    }

    try {
      if (event.requestContext?.http?.method === 'PATCH') {
        return await updateTeamIssue(
          event,
          headers,
          directoryId,
          teamIssueDetailParams.teamId,
          teamIssueDetailParams.issueId,
          principal.userKey,
          principal.userPoolId,
          principal,
          mutationContext,
        );
      }

      return await getTeamIssueDetail(
        headers,
        directoryId,
        teamIssueDetailParams.teamId,
        teamIssueDetailParams.issueId,
        principal.userPoolId,
        principal,
        mutationContext,
      );
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to load issue detail.');
    }
  }

  const teamIssueListParams = readTeamIssueListParams(event);

  if (teamIssueListParams) {
    const permissionError = await enforceTeamPermission(
      headers,
      principal,
      teamIssueListParams.teamId,
      event.requestContext?.http?.method === 'GET' ? 'viewer' : 'member',
    );

    if (permissionError) {
      return permissionError;
    }

    try {
      if (event.requestContext?.http?.method === 'POST') {
        return await createTeamIssue(
          event,
          headers,
          directoryId,
        teamIssueListParams.teamId,
        principal.userKey,
        principal.userPoolId,
        principal,
        mutationContext,
      );
      }

      return await listTeamIssues(headers, directoryId, teamIssueListParams.teamId, principal.userPoolId, principal);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to load team issues.');
    }
  }

  const projectIssuesProjectId = readProjectIssuesProjectId(event);

  if (projectIssuesProjectId) {
    const permissionError = await enforceProjectPermission(
      headers,
      principal,
      projectIssuesProjectId,
      'viewer',
    );

    if (permissionError) {
      return permissionError;
    }

    try {
      return await listProjectIssues(headers, directoryId, projectIssuesProjectId, principal.userPoolId);
    } catch (error) {
      return toProjectDataError(error, headers, 'Failed to load project issues.');
    }
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
	      return await createProjectTask(event, headers, directoryId, decodedProjectId, principal.userPoolId, mutationContext);
	    }

    if (taskStatusParams) {
      return await updateProjectTaskStatus(
        event,
	        headers,
	        directoryId,
	        decodedProjectId,
	        taskStatusParams.taskId,
	        principal.userPoolId,
	        mutationContext,
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
	      tasks: await hydrateProjectTasks(items.map(toTask), principal.userPoolId),
    }, headers);
  } catch (error) {
    return toProjectDataError(error, headers, 'Failed to load project tasks.');
  }
};

async function createTeam(event, headers, directoryId, mutationContext) {
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

  await dynamodb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      createAuditEventPut(directoryId, mutationContext, {
        eventType: 'project.created',
        entityType: 'project',
        entityId: 'team/' + teamId,
        action: 'created',
        changes: createAuditChanges(undefined, {
          kind: 'team',
          teamId,
          name: names.nameJa,
          expanded: true,
        }),
        metadata: { kind: 'team', teamId },
      }),
    ].filter(Boolean),
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

async function createProject(event, headers, directoryId, teamId, creatorUserKey, mutationContext) {
  const body = readJsonBody(event);
  const names = readLocalizedNames(body);

  if (!names) {
    return json(400, { message: 'Name is required.' }, headers);
  }

  const tone = body.tone === undefined ? 'blue' : body.tone;

  if (!isProjectTone(tone)) {
    return json(400, { message: 'Project tone is invalid.' }, headers);
  }
  const creatorMemberKey = normalizeProjectMemberKey(creatorUserKey);

  if (!creatorMemberKey) {
    return json(400, { message: 'Project creator member key is required.' }, headers);
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
  const updatedAt = new Date().toISOString();
  const creatorMemberItem = {
    directoryId: { S: directoryId },
    entryKey: { S: createProjectMemberEntryKey(projectId, creatorMemberKey) },
    entryType: { S: 'project-member' },
    projectId: { S: projectId },
    memberKey: { S: creatorMemberKey },
    email: { S: creatorMemberKey },
    role: { S: 'manager' },
    createdAt: { S: updatedAt },
    updatedAt: { S: updatedAt },
  };

  try {
    await dynamodb.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          ConditionCheck: createActiveTeamConditionCheck(directoryId, team.entryKey.S),
        },
        {
          Put: {
            TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
            Item: item,
            ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
          },
        },
        {
          Put: {
            TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
            Item: creatorMemberItem,
            ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
          },
        },
        createAuditEventPut(directoryId, mutationContext, {
          eventType: 'project.created',
          entityType: 'project',
          entityId: projectId,
          action: 'created',
          occurredAt: updatedAt,
          changes: createAuditChanges(undefined, {
            projectId,
            teamId,
            name: names.nameJa,
            tone,
            creatorMemberKey,
            creatorRole: 'manager',
          }),
          metadata: { kind: 'project', projectId, teamId },
        }),
      ].filter(Boolean),
    }));
  } catch (error) {
    if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
      return await handleCreateProjectTransactionCancellation(headers, directoryId, teamId, error);
    }

    throw error;
  }

  return json(201, {
    project: {
      id: projectId,
      name: names.nameJa,
      tone,
    },
  }, headers);
}

async function archiveTeam(headers, directoryId, teamId, mutationContext) {
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

  try {
    await dynamodb.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
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
          },
        },
        createAuditEventPut(directoryId, mutationContext, {
          eventType: 'project.archived',
          entityType: 'project',
          entityId: 'team/' + teamId,
          action: 'archived',
          occurredAt: archivedAt,
          changes: createAuditChanges({ archivedAt: undefined }, { archivedAt }),
          metadata: { kind: 'team', teamId },
        }),
      ].filter(Boolean),
    }));
  } catch (error) {
    if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
      return await handleDirectoryArchiveTransactionCancellation(
        headers,
        directoryId,
        teamId,
        undefined,
        error,
      );
    }

    throw error;
  }

  return json(200, { teamId, archivedAt }, headers);
}

async function archiveProject(headers, directoryId, teamId, projectId, mutationContext) {
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

  try {
    await dynamodb.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
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
          },
        },
        createAuditEventPut(directoryId, mutationContext, {
          eventType: 'project.archived',
          entityType: 'project',
          entityId: projectId,
          action: 'archived',
          occurredAt: archivedAt,
          changes: createAuditChanges({ archivedAt: undefined }, { archivedAt }),
          metadata: { kind: 'project', projectId, teamId },
        }),
      ].filter(Boolean),
    }));
  } catch (error) {
    if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
      return await handleDirectoryArchiveTransactionCancellation(
        headers,
        directoryId,
        teamId,
        projectId,
        error,
      );
    }

    throw error;
  }

	  return json(200, { teamId, projectId, archivedAt }, headers);
	}

	async function listProjectUsers(event, headers, userPoolId, directoryId) {
	  if (!userPoolId) {
	    return json(503, { message: 'Cognito user pool is not available.' }, headers);
	  }

	  const query = event.queryStringParameters?.query?.trim();
	  const limit = clampCognitoPageLimit(Number(event.queryStringParameters?.limit ?? 20));
	  const users = [];
	  let paginationToken = event.queryStringParameters?.paginationToken ?? event.queryStringParameters?.nextToken;

	  do {
	    const response = await cognito.send(new ListUsersCommand({
	      UserPoolId: userPoolId,
	      Limit: Math.max(1, limit - users.length),
	      ...(paginationToken ? { PaginationToken: paginationToken } : {}),
	      ...(query ? { Filter: '"email"^="' + escapeCognitoFilterValue(query.toLowerCase()) + '"' } : {}),
	    }));
	    users.push(
	      ...(response.Users ?? [])
	        .filter((user) => isCognitoUserInDirectory(user, directoryId))
	        .map(toCognitoUserProfile)
	        .filter(Boolean),
	    );
	    paginationToken = response.PaginationToken;
	  } while (users.length < limit && paginationToken);

	  return json(200, {
	    users,
	    nextToken: paginationToken,
	  }, headers);
	}

	async function listProjectMembers(headers, directoryId, projectId, userPoolId) {
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

	  return json(200, { projectId, members: await hydrateProjectMembers(members, userPoolId) }, headers);
	}

async function updateProjectMember(event, headers, directoryId, projectId, memberKey, userPoolId, mutationContext) {
  const body = readJsonBody(event);
  const normalizedMemberKey = normalizeProjectMemberKey(memberKey);

  if (!normalizedMemberKey) {
    return json(400, { message: 'Project member email is required.' }, headers);
  }
  const profile = await getUserProfile(userPoolId, normalizedMemberKey);

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
    ConsistentRead: true,
  });
  const existingMember = existingMembers.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === normalizedMemberKey
  );
  if (
    existingMember?.role?.S === 'manager' &&
    body.role !== 'manager' &&
    !findOtherProjectManager(existingMembers, projectId, normalizedMemberKey)
  ) {
    return json(409, { message: 'At least one project manager is required.' }, headers);
  }
  const guardManager = existingMember?.role?.S === 'manager' && body.role !== 'manager'
    ? findOtherProjectManager(existingMembers, projectId, normalizedMemberKey)
    : undefined;
  const updatedAt = new Date().toISOString();
  const item = {
    directoryId: { S: directoryId },
    entryKey: { S: createProjectMemberEntryKey(projectId, normalizedMemberKey) },
    entryType: { S: 'project-member' },
    projectId: { S: projectId },
    memberKey: { S: normalizedMemberKey },
    email: { S: profile.email },
    role: { S: body.role },
    createdAt: { S: existingMember?.createdAt?.S ?? updatedAt },
    updatedAt: { S: updatedAt },
    ...(profile.name ? { name: { S: profile.name } } : {}),
  };
  const auditEventPut = createAuditEventPut(directoryId, mutationContext, {
    eventType: existingMember ? 'member.updated' : 'member.added',
    entityType: 'member',
    entityId: projectId + '/' + normalizedMemberKey,
    action: existingMember ? 'updated' : 'created',
    occurredAt: updatedAt,
    changes: createAuditChanges(
      existingMember ? fromDynamoItem(existingMember) : undefined,
      fromDynamoItem(item),
      ['email', 'name', 'role'],
    ),
    metadata: { projectId, memberKey: normalizedMemberKey },
  });
  const memberPut = {
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Item: item,
    ConditionExpression: existingMember
      ? '#updatedAt = :expectedUpdatedAt'
      : 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
    ...(existingMember
      ? {
          ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':expectedUpdatedAt': existingMember.updatedAt },
        }
      : {}),
  };

  if (guardManager) {
    try {
      await dynamodb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: createProjectManagerConditionCheck(directoryId, guardManager.entryKey.S),
          },
          {
            Put: memberPut,
          },
          auditEventPut,
        ].filter(Boolean),
      }));
    } catch (error) {
      if (
        isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed') ||
        isTransactionCancellationReason(error, 1, 'ConditionalCheckFailed')
      ) {
        return await handleProjectMemberTransactionCancellation(
          headers,
          directoryId,
          projectId,
          normalizedMemberKey,
          error,
        );
      }

      throw error;
    }
  } else {
    try {
      await dynamodb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: memberPut,
          },
          auditEventPut,
        ].filter(Boolean),
      }));
    } catch (error) {
      if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
        return await handleUpdateProjectMemberTransactionCancellation(
          headers,
          directoryId,
          projectId,
          normalizedMemberKey,
          Boolean(existingMember),
          error,
        );
      }

      throw error;
    }
  }

  return json(200, { member: await hydrateProjectMember(toProjectMember(item), userPoolId) }, headers);
}

async function removeProjectMember(headers, directoryId, projectId, memberKey, mutationContext) {
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
    ConsistentRead: true,
  });
  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === normalizedMemberKey
  );

  if (!member) {
    return json(404, { message: 'Project member was not found.' }, headers);
  }

  if (
    member.role?.S === 'manager' &&
    !findOtherProjectManager(items, projectId, normalizedMemberKey)
  ) {
    return json(409, { message: 'At least one project manager is required.' }, headers);
  }
  const guardManager = member.role?.S === 'manager'
    ? findOtherProjectManager(items, projectId, normalizedMemberKey)
    : undefined;
  const removedAt = new Date().toISOString();
  const auditEventPut = createAuditEventPut(directoryId, mutationContext, {
    eventType: 'member.removed',
    entityType: 'member',
    entityId: projectId + '/' + normalizedMemberKey,
    action: 'deleted',
    occurredAt: removedAt,
    changes: createAuditChanges(
      fromDynamoItem(member),
      undefined,
      ['email', 'name', 'role'],
    ),
    metadata: { projectId, memberKey: normalizedMemberKey },
  });
  const memberDelete = {
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Key: {
      directoryId: { S: directoryId },
      entryKey: { S: member.entryKey.S },
    },
    ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND #updatedAt = :expectedUpdatedAt AND #role = :expectedRole',
    ExpressionAttributeNames: {
      '#updatedAt': 'updatedAt',
      '#role': 'role',
    },
    ExpressionAttributeValues: {
      ':expectedUpdatedAt': member.updatedAt,
      ':expectedRole': member.role,
    },
  };

  if (guardManager) {
    try {
      await dynamodb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: createProjectManagerConditionCheck(directoryId, guardManager.entryKey.S),
          },
          {
            Delete: memberDelete,
          },
          auditEventPut,
        ].filter(Boolean),
      }));
    } catch (error) {
      if (
        isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed') ||
        isTransactionCancellationReason(error, 1, 'ConditionalCheckFailed')
      ) {
        return await handleProjectMemberTransactionCancellation(
          headers,
          directoryId,
          projectId,
          normalizedMemberKey,
          error,
        );
      }

      throw error;
    }
  } else {
    try {
      await dynamodb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Delete: memberDelete,
          },
          auditEventPut,
        ].filter(Boolean),
      }));
    } catch (error) {
      if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
        return await handleProjectMemberTransactionCancellation(
          headers,
          directoryId,
          projectId,
          normalizedMemberKey,
          error,
        );
      }

      throw error;
    }
  }

  return json(200, { projectId, memberId: normalizedMemberKey }, headers);
}

	function findOtherProjectManager(items, projectId, memberKey) {
	  return items.find((item) =>
	      item.entryType?.S === 'project-member' &&
	      item.projectId?.S === projectId &&
	      item.memberKey?.S !== memberKey &&
	      item.role?.S === 'manager'
	    );
	}

async function handleCreateProjectTransactionCancellation(headers, directoryId, teamId, originalError) {
  const items = await readDirectoryItems(directoryId, true);
  const activeTeam = items.find((item) =>
    item.entryType?.S === 'team' &&
    item.teamId?.S === teamId &&
    isActiveDirectoryItem(item)
  );

  if (!activeTeam) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  throw originalError;
}

async function handleProjectMemberTransactionCancellation(headers, directoryId, projectId, memberKey, originalError) {
  const items = await readDirectoryItems(directoryId, true);

  if (!hasActiveProject(items, projectId)) {
    return json(404, { message: 'Project was not found.' }, headers);
  }

  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === memberKey
  );

  if (!member) {
    return json(404, { message: 'Project member was not found.' }, headers);
  }

  if (member.role?.S === 'manager' && !findOtherProjectManager(items, projectId, memberKey)) {
    return json(409, { message: 'At least one project manager is required.' }, headers);
  }

  throw originalError;
}

async function handleUpdateProjectMemberTransactionCancellation(
  headers,
  directoryId,
  projectId,
  memberKey,
  existingMemberExpected,
  originalError,
) {
  const items = await readDirectoryItems(directoryId, true);

  if (!hasActiveProject(items, projectId)) {
    return json(404, { message: 'Project was not found.' }, headers);
  }

  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === memberKey
  );

  if (existingMemberExpected && !member) {
    return json(404, { message: 'Project member was not found.' }, headers);
  }

  throw originalError;
}

async function handleDirectoryArchiveTransactionCancellation(
  headers,
  directoryId,
  teamId,
  projectId,
  originalError,
) {
  const items = await readDirectoryItems(directoryId, true);
  const activeTeam = items.find((item) =>
    item.entryType?.S === 'team' &&
    item.teamId?.S === teamId &&
    isActiveDirectoryItem(item)
  );

  if (!activeTeam) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  if (
    projectId &&
    !items.some((item) =>
      item.entryType?.S === 'project' &&
      item.teamId?.S === teamId &&
      item.projectId?.S === projectId &&
      isActiveDirectoryItem(item)
    )
  ) {
    return json(404, { message: 'Project was not found.' }, headers);
  }

  throw originalError;
}

function hasActiveProject(items, projectId) {
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

function createActiveTeamConditionCheck(directoryId, entryKey) {
  return {
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    Key: {
      directoryId: { S: directoryId },
      entryKey: { S: entryKey },
    },
    ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
  };
}

	function createProjectManagerConditionCheck(directoryId, entryKey) {
	  return {
	    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
	    Key: {
	      directoryId: { S: directoryId },
	      entryKey: { S: entryKey },
	    },
	    ConditionExpression: '#role = :manager',
	    ExpressionAttributeNames: {
	      '#role': 'role',
	    },
	    ExpressionAttributeValues: {
	      ':manager': { S: 'manager' },
	    },
	  };
	}

		async function createProjectTask(event, headers, directoryId, projectId, userPoolId, mutationContext) {
	  const body = readJsonBody(event);
	  const assigneeUserId = normalizeProjectMemberKey(body.assigneeUserId ?? body.assignee);

	  if (
	    typeof body.title !== 'string' ||
	    typeof body.dueDate !== 'string' ||
	    !body.title.trim() ||
	    !assigneeUserId ||
	    !body.dueDate.trim()
	  ) {
	    return json(400, { message: 'Task title, assignee, and due date are required.' }, headers);
  }

  if (!isTaskStatus(body.status) || !isTaskPriority(body.priority)) {
    return json(400, { message: 'Task status or priority is invalid.' }, headers);
  }

	  const title = body.title.trim();
	  const dueDate = body.dueDate.trim();
	  await getUserProfile(userPoolId, assigneeUserId);
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
	    assigneeUserId: { S: assigneeUserId },
    status: { S: body.status },
    dueDate: { S: dueDate },
    priority: { S: body.priority },
  };

  await dynamodb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName: process.env.TASKS_TABLE_NAME,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
        },
      },
      createAuditEventPut(directoryId, mutationContext, {
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: createProjectTaskAuditEntityId(projectId, taskId),
        action: 'created',
        changes: createAuditChanges(undefined, fromDynamoItem(item), [
          'title',
          'assigneeUserId',
          'status',
          'dueDate',
          'priority',
        ]),
        metadata: { adapter: 'legacy-project-task', projectId },
      }),
    ].filter(Boolean),
  }));

	  return json(201, {
	    task: await hydrateProjectTask(toTask(item), userPoolId),
	  }, headers);
	}

	async function updateProjectTaskStatus(event, headers, directoryId, projectId, taskId, userPoolId, mutationContext) {
  const body = readJsonBody(event);

  if (!isTaskStatus(body.status)) {
    return json(400, { message: 'Task status is invalid.' }, headers);
  }

  if (await isLegacyProjectTaskIssue(directoryId, projectId, taskId)) {
    return json(409, { message: 'Legacy task issues are read-only.' }, headers);
  }

  const directoryProjectId = createDirectoryProjectId(directoryId, projectId);
  const currentItems = await queryAll({
    TableName: process.env.TASKS_TABLE_NAME,
    KeyConditionExpression: 'directoryProjectId = :directoryProjectId AND taskId = :taskId',
    ExpressionAttributeValues: {
      ':directoryProjectId': { S: directoryProjectId },
      ':taskId': { S: taskId },
    },
    ConsistentRead: true,
    Limit: 1,
  });
  const currentItem = currentItems[0];

  if (!currentItem) {
    return json(404, { message: 'Task was not found.' }, headers);
  }
  const updatedItem = {
    ...currentItem,
    status: { S: body.status },
  };

  try {
    await dynamodb.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
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
              ':beforeStatus': currentItem.status,
            },
            ConditionExpression: 'attribute_exists(directoryProjectId) AND attribute_exists(taskId) AND #status = :beforeStatus',
          },
        },
        createAuditEventPut(directoryId, mutationContext, {
          eventType: 'work-item.updated',
          entityType: 'work-item',
          entityId: createProjectTaskAuditEntityId(projectId, taskId),
          action: 'updated',
          changes: createAuditChanges(
            fromDynamoItem(currentItem),
            fromDynamoItem(updatedItem),
            ['status'],
          ),
          metadata: { adapter: 'legacy-project-task', projectId },
        }),
      ].filter(Boolean),
    }));
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return json(409, { message: 'Task was modified by another request.' }, headers);
    }

    if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
      return await handleProjectTaskStatusTransactionCancellation(
        headers,
        directoryId,
        projectId,
        taskId,
      );
    }

    throw error;
  }

	  return json(200, {
	    task: await hydrateProjectTask(toTask(updatedItem), userPoolId),
	  }, headers);
	}

async function handleProjectTaskStatusTransactionCancellation(
  headers,
  directoryId,
  projectId,
  taskId,
) {
  const latestItems = await queryAll({
    TableName: process.env.TASKS_TABLE_NAME,
    KeyConditionExpression: 'directoryProjectId = :directoryProjectId AND taskId = :taskId',
    ExpressionAttributeValues: {
      ':directoryProjectId': { S: createDirectoryProjectId(directoryId, projectId) },
      ':taskId': { S: taskId },
    },
    ConsistentRead: true,
    Limit: 1,
  });

  if (!latestItems[0]) {
    return json(404, { message: 'Task was not found.' }, headers);
  }

  return json(409, { message: 'Task was modified by another request.' }, headers);
}

async function listTeamIssues(headers, directoryId, teamId, userPoolId, principal) {
  const directoryItems = await readDirectoryItems(directoryId);

  if (!findActiveTeam(directoryItems, teamId)) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  const storedItems = await queryAll({
    TableName: process.env.TEAM_ISSUES_TABLE_NAME,
    IndexName: 'TeamIssueSortOrderIndex',
    KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
    ExpressionAttributeValues: {
      ':directoryTeamId': { S: createDirectoryTeamId(directoryId, teamId) },
    },
    ScanIndexForward: true,
  });
  const legacyIssues = await readLegacyTeamIssues(directoryId, directoryItems, teamId, principal);

  return json(200, {
    teamId,
    issues: await hydrateTeamIssues(
      mergeTeamIssues(
        storedItems.map(toTeamIssue).filter((issue) => canAccessAssignedProject(directoryItems, principal, issue.assignedProjectId, 'viewer')),
        legacyIssues,
      ),
      userPoolId,
    ),
  }, headers);
}

async function createTeamIssue(event, headers, directoryId, teamId, actorUserId, userPoolId, principal, mutationContext) {
  const body = readJsonBody(event);
  const directoryItems = await readDirectoryItems(directoryId);

  if (!findActiveTeam(directoryItems, teamId)) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  const title = readRequiredString(body.title, 'Issue title is required.');
  const description = readOptionalString(body.description, 'Issue description is invalid.');
  const assigneeUserId = readTeamIssueAssigneeUserId(body);
  const status = readTaskStatus(body.status);
  const dueDate = readRequiredString(body.dueDate, 'Issue due date is required.');
  const priority = readTaskPriority(body.priority);
  const assignedProjectId = readAssignedProjectId(body.assignedProjectId);
  validateAssignedProjectInTeam(directoryItems, teamId, assignedProjectId);
  requireAssignedProjectPermission(directoryItems, principal, assignedProjectId, 'member');
  await getUserProfile(userPoolId, assigneeUserId);

  const directoryTeamId = createDirectoryTeamId(directoryId, teamId);
  const currentItems = await queryAll({
    TableName: process.env.TEAM_ISSUES_TABLE_NAME,
    IndexName: 'TeamIssueSortOrderIndex',
    KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
    ExpressionAttributeValues: {
      ':directoryTeamId': { S: directoryTeamId },
    },
    ScanIndexForward: true,
  });
  const now = new Date().toISOString();
  const legacyIssueIds = await readLegacyTeamIssueIds(directoryId, directoryItems, teamId);
  const issueId = createUniqueResourceId(
    title,
    [
      ...currentItems.map((item) => item.issueId?.S).filter(Boolean),
      ...legacyIssueIds,
    ],
  );
  const item = {
    directoryId: { S: directoryId },
    directoryTeamId: { S: directoryTeamId },
    teamId: { S: teamId },
    issueId: { S: issueId },
    sortOrder: { N: String((currentItems.length + 1) * 10) },
    title: { S: title },
    assigneeUserId: { S: assigneeUserId },
    status: { S: status },
    dueDate: { S: dueDate },
    priority: { S: priority },
    createdAt: { S: now },
    updatedAt: { S: now },
  };

  if (description) {
    item.description = { S: description };
  }

  if (assignedProjectId) {
    item.assignedProjectId = { S: assignedProjectId };
    item.directoryProjectId = { S: createDirectoryProjectId(directoryId, assignedProjectId) };
  }

  const eventItem = createIssueEventItem({
    directoryId,
    teamId,
    issueId,
    eventType: 'created',
    actorUserId,
    summary: 'Issue was created.',
    createdAt: now,
  });
  await dynamodb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName: process.env.TEAM_ISSUES_TABLE_NAME,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)',
        },
      },
      {
        Put: {
          TableName: process.env.TEAM_ISSUE_EVENTS_TABLE_NAME,
          Item: eventItem,
          ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
        },
      },
      createAuditEventPut(directoryId, mutationContext, {
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'created',
        occurredAt: now,
        changes: createAuditChanges(undefined, fromDynamoItem(item), [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'status',
          'dueDate',
          'priority',
        ]),
        metadata: { adapter: 'team-issue', teamId, projectId: assignedProjectId },
      }),
    ].filter(Boolean),
  }));

  return json(201, {
    issue: await hydrateTeamIssue(toTeamIssue(item), userPoolId),
  }, headers);
}

async function getTeamIssueDetail(headers, directoryId, teamId, issueId, userPoolId, principal) {
  const item = await getStoredTeamIssueItem(directoryId, teamId, issueId);

  if (!item) {
    const directoryItems = await readDirectoryItems(directoryId);
    const legacyIssue = (await readLegacyTeamIssues(directoryId, directoryItems, teamId, principal))
      .find((issue) => issue.id === issueId);

    if (legacyIssue) {
      return json(200, {
        issue: await hydrateTeamIssue(legacyIssue, userPoolId),
        comments: [],
        activity: [],
      }, headers);
    }

    return json(404, { message: 'Issue was not found.' }, headers);
  }

  const directoryItems = await readDirectoryItems(directoryId);
  requireAssignedProjectPermission(directoryItems, principal, item.assignedProjectId?.S, 'viewer');
  const events = await readIssueEvents(directoryId, teamId, issueId);

  return json(200, {
    issue: await hydrateTeamIssue(toTeamIssue(item), userPoolId),
    comments: events
      .filter((event) => event.eventType?.S === 'commented')
      .map(toTeamIssueComment),
    activity: events.map(toTeamIssueActivity),
  }, headers);
}

async function updateTeamIssue(event, headers, directoryId, teamId, issueId, actorUserId, userPoolId, principal, mutationContext) {
  const body = readJsonBody(event);
  const directoryItems = await readDirectoryItems(directoryId);

  if (!findActiveTeam(directoryItems, teamId)) {
    return json(404, { message: 'Team was not found.' }, headers);
  }

  const expressionAttributeNames = {
    '#updatedAt': 'updatedAt',
  };
  const expressionAttributeValues = {
    ':updatedAt': { S: new Date().toISOString() },
  };
  const setExpressions = ['#updatedAt = :updatedAt'];
  const removeExpressions = [];
  const currentIssue = await getStoredTeamIssueItem(directoryId, teamId, issueId);

  if (!currentIssue) {
    return json(404, { message: 'Issue was not found.' }, headers);
  }

  expressionAttributeValues[':beforeUpdatedAt'] = currentIssue.updatedAt;

  requireAssignedProjectPermission(directoryItems, principal, currentIssue.assignedProjectId?.S, 'member');

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    expressionAttributeNames['#title'] = 'title';
    expressionAttributeValues[':title'] = { S: readRequiredString(body.title, 'Issue title is required.') };
    setExpressions.push('#title = :title');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    const description = readOptionalString(body.description, 'Issue description is invalid.');
    expressionAttributeNames['#description'] = 'description';

    if (description) {
      expressionAttributeValues[':description'] = { S: description };
      setExpressions.push('#description = :description');
    } else {
      removeExpressions.push('#description');
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'assignedProjectId')) {
    const assignedProjectId = readAssignedProjectId(body.assignedProjectId);
    validateAssignedProjectInTeam(directoryItems, teamId, assignedProjectId);
    requireAssignedProjectPermission(directoryItems, principal, assignedProjectId, 'member');
    expressionAttributeNames['#assignedProjectId'] = 'assignedProjectId';
    expressionAttributeNames['#directoryProjectId'] = 'directoryProjectId';

    if (assignedProjectId) {
      expressionAttributeValues[':assignedProjectId'] = { S: assignedProjectId };
      expressionAttributeValues[':directoryProjectId'] = { S: createDirectoryProjectId(directoryId, assignedProjectId) };
      setExpressions.push('#assignedProjectId = :assignedProjectId');
      setExpressions.push('#directoryProjectId = :directoryProjectId');
    } else {
      removeExpressions.push('#assignedProjectId');
      removeExpressions.push('#directoryProjectId');
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'assigneeUserId')) {
    const assigneeUserId = readTeamIssueAssigneeUserId(body);
    await getUserProfile(userPoolId, assigneeUserId);
    expressionAttributeNames['#assigneeUserId'] = 'assigneeUserId';
    expressionAttributeValues[':assigneeUserId'] = { S: assigneeUserId };
    setExpressions.push('#assigneeUserId = :assigneeUserId');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = { S: readRequiredTaskStatus(body.status) };
    setExpressions.push('#status = :status');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'dueDate')) {
    expressionAttributeNames['#dueDate'] = 'dueDate';
    expressionAttributeValues[':dueDate'] = { S: readRequiredString(body.dueDate, 'Issue due date is required.') };
    setExpressions.push('#dueDate = :dueDate');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
    expressionAttributeNames['#priority'] = 'priority';
    expressionAttributeValues[':priority'] = { S: readTaskPriority(body.priority) };
    setExpressions.push('#priority = :priority');
  }

  const updateExpression = [
    'SET ' + setExpressions.join(', '),
    removeExpressions.length > 0 ? 'REMOVE ' + removeExpressions.join(', ') : undefined,
  ].filter(Boolean).join(' ');
  const beforeIssue = fromDynamoItem(currentIssue);
  const afterIssue = { ...beforeIssue, updatedAt: expressionAttributeValues[':updatedAt'].S };

  for (const [placeholder, field] of Object.entries(expressionAttributeNames)) {
    const value = expressionAttributeValues[':' + field];

    if (value) {
      afterIssue[field] = fromDynamoValue(value);
    } else if (removeExpressions.includes(placeholder)) {
      delete afterIssue[field];
    }
  }
  const eventItem = createIssueEventItem({
    directoryId,
    teamId,
    issueId,
    eventType: 'updated',
    actorUserId,
    summary: 'Issue was updated.',
    createdAt: expressionAttributeValues[':updatedAt'].S,
  });

  try {
    await dynamodb.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: process.env.TEAM_ISSUES_TABLE_NAME,
            Key: {
              directoryTeamId: { S: createDirectoryTeamId(directoryId, teamId) },
              issueId: { S: issueId },
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ConditionExpression: 'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #updatedAt = :beforeUpdatedAt',
          },
        },
        {
          Put: {
            TableName: process.env.TEAM_ISSUE_EVENTS_TABLE_NAME,
            Item: eventItem,
            ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
          },
        },
        createAuditEventPut(directoryId, mutationContext, {
          eventType: 'work-item.updated',
          entityType: 'work-item',
          entityId: createTeamIssueAuditEntityId(teamId, issueId),
          action: 'updated',
          occurredAt: expressionAttributeValues[':updatedAt'].S,
          changes: createAuditChanges(beforeIssue, afterIssue, [
            'title',
            'description',
            'assignedProjectId',
            'assigneeUserId',
            'status',
            'dueDate',
            'priority',
          ]),
          metadata: { adapter: 'team-issue', teamId, projectId: afterIssue.assignedProjectId },
        }),
      ].filter(Boolean),
    }));
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return json(404, { message: 'Issue was not found.' }, headers);
    }

    if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
      return await handleTeamIssueTransactionCancellation(
        headers,
        directoryId,
        teamId,
        issueId,
        error,
      );
    }

    throw error;
  }

  const updatedIssue = await getStoredTeamIssueItem(directoryId, teamId, issueId, true);

  return json(200, {
    issue: await hydrateTeamIssue(toTeamIssue(updatedIssue), userPoolId),
  }, headers);
}

async function createTeamIssueComment(event, headers, directoryId, teamId, issueId, actorUserId, userPoolId, principal, mutationContext) {
  const body = readJsonBody(event);
  const issue = await getStoredTeamIssueItem(directoryId, teamId, issueId);

  if (!issue) {
    return json(404, { message: 'Issue was not found.' }, headers);
  }

  requireAssignedProjectPermission(
    await readDirectoryItems(directoryId),
    principal,
    issue.assignedProjectId?.S,
    'member',
  );

  const createdAt = new Date().toISOString();
  const commentBody = readRequiredCommentBody(body.body);
  const item = createIssueEventItem({
    directoryId,
    teamId,
    issueId,
    eventType: 'commented',
    actorUserId,
    body: commentBody,
    summary: 'Comment was added.',
    createdAt,
  });
  try {
    await dynamodb.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: process.env.TEAM_ISSUES_TABLE_NAME,
            Key: {
              directoryTeamId: { S: createDirectoryTeamId(directoryId, teamId) },
              issueId: { S: issueId },
            },
            ConditionExpression: 'attribute_exists(directoryTeamId) AND attribute_exists(issueId)',
          },
        },
        {
          Put: {
            TableName: process.env.TEAM_ISSUE_EVENTS_TABLE_NAME,
            Item: item,
            ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
          },
        },
        createAuditEventPut(directoryId, mutationContext, {
          eventType: 'comment.created',
          entityType: 'work-item',
          entityId: createTeamIssueAuditEntityId(teamId, issueId),
          targetType: 'comment',
          targetId: createTeamIssueCommentAuditTargetId(teamId, issueId, item.eventId.S),
          action: 'commented',
          occurredAt: createdAt,
          changes: createAuditChanges(undefined, { body: commentBody }),
          metadata: { adapter: 'team-issue', teamId, commentId: item.eventId.S },
        }),
      ].filter(Boolean),
    }));
  } catch (error) {
    if (isTransactionCancellationReason(error, 0, 'ConditionalCheckFailed')) {
      return await handleTeamIssueTransactionCancellation(
        headers,
        directoryId,
        teamId,
        issueId,
        error,
      );
    }

    throw error;
  }

  return json(201, {
    comment: toTeamIssueComment(item),
    activity: toTeamIssueActivity(item),
  }, headers);
}

async function handleTeamIssueTransactionCancellation(
  headers,
  directoryId,
  teamId,
  issueId,
  originalError,
) {
  if (!await getStoredTeamIssueItem(directoryId, teamId, issueId, true)) {
    return json(404, { message: 'Issue was not found.' }, headers);
  }

  throw originalError;
}

async function listProjectIssues(headers, directoryId, projectId, userPoolId) {
  const storedItems = await queryAll({
    TableName: process.env.TEAM_ISSUES_TABLE_NAME,
    IndexName: 'AssignedProjectIssueIndex',
    KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
    ExpressionAttributeValues: {
      ':directoryProjectId': { S: createDirectoryProjectId(directoryId, projectId) },
    },
    ScanIndexForward: true,
  });
  const directoryItems = await readDirectoryItems(directoryId);
  const ownerTeamId = findFirstActiveProjectTeamId(directoryItems, projectId);
  const legacyTasks = ownerTeamId
    ? await queryAll({
        TableName: process.env.TASKS_TABLE_NAME,
        IndexName: 'ProjectSortOrderIndex',
        KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
        ExpressionAttributeValues: {
          ':directoryProjectId': { S: createDirectoryProjectId(directoryId, projectId) },
        },
        ScanIndexForward: true,
      })
    : [];

  return json(200, {
    projectId,
    issues: await hydrateTeamIssues(
      mergeTeamIssues(
        storedItems.map(toTeamIssue),
        legacyTasks.map((task) => toLegacyTeamIssue(toTask(task), ownerTeamId, projectId)),
      ),
      userPoolId,
    ),
  }, headers);
}

async function readLegacyTeamIssues(directoryId, directoryItems, teamId, principal) {
  const issues = [];
  const projects = directoryItems.filter((item) =>
    item.entryType?.S === 'project' &&
    item.teamId?.S === teamId &&
    isActiveDirectoryItem(item) &&
    findFirstActiveProjectTeamId(directoryItems, item.projectId?.S) === teamId &&
    canAccessAssignedProject(directoryItems, principal, item.projectId?.S, 'viewer')
  );

  for (const project of projects) {
    const items = await queryAll({
      TableName: process.env.TASKS_TABLE_NAME,
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': { S: createDirectoryProjectId(directoryId, project.projectId.S) },
      },
      ScanIndexForward: true,
    });
    issues.push(...items.map((item) => toLegacyTeamIssue(toTask(item), teamId, project.projectId.S)));
  }

  return issues;
}

async function readLegacyTeamIssueIds(directoryId, directoryItems, teamId) {
  const issueIds = [];
  const projects = directoryItems.filter((item) =>
    item.entryType?.S === 'project' &&
    item.teamId?.S === teamId &&
    isActiveDirectoryItem(item) &&
    findFirstActiveProjectTeamId(directoryItems, item.projectId?.S) === teamId
  );

  for (const project of projects) {
    const items = await queryAll({
      TableName: process.env.TASKS_TABLE_NAME,
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': { S: createDirectoryProjectId(directoryId, project.projectId.S) },
      },
      ScanIndexForward: true,
    });
    issueIds.push(...items.map((item) => item.taskId?.S).filter(Boolean));
  }

  return issueIds;
}

async function isLegacyProjectTaskIssue(directoryId, projectId, taskId) {
  const directoryItems = await readDirectoryItems(directoryId);

  if (!findFirstActiveProjectTeamId(directoryItems, projectId)) {
    return false;
  }

  const items = await queryAll({
    TableName: process.env.TASKS_TABLE_NAME,
    KeyConditionExpression: 'directoryProjectId = :directoryProjectId AND taskId = :taskId',
    ExpressionAttributeValues: {
      ':directoryProjectId': { S: createDirectoryProjectId(directoryId, projectId) },
      ':taskId': { S: taskId },
    },
    Limit: 1,
  });

  return items.length > 0;
}

function mergeTeamIssues(primaryIssues, fallbackIssues) {
  const issueIds = new Set(primaryIssues.map((issue) => issue.id));

  return [
    ...primaryIssues,
    ...fallbackIssues.filter((issue) => !issueIds.has(issue.id)),
  ];
}

async function getStoredTeamIssueItem(directoryId, teamId, issueId, consistentRead = false) {
  const items = await queryAll({
    TableName: process.env.TEAM_ISSUES_TABLE_NAME,
    KeyConditionExpression: 'directoryTeamId = :directoryTeamId AND issueId = :issueId',
    ExpressionAttributeValues: {
      ':directoryTeamId': { S: createDirectoryTeamId(directoryId, teamId) },
      ':issueId': { S: issueId },
    },
    ConsistentRead: consistentRead,
    Limit: 1,
  });

  return items[0];
}

async function readIssueEvents(directoryId, teamId, issueId) {
  return queryAll({
    TableName: process.env.TEAM_ISSUE_EVENTS_TABLE_NAME,
    KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
    ExpressionAttributeValues: {
      ':directoryTeamIssueId': { S: createDirectoryTeamIssueId(directoryId, teamId, issueId) },
    },
    ScanIndexForward: true,
  });
}

async function listTeamIssueActivity(event, headers, directoryId, teamId, issueId, principal) {
  const issue = await getStoredTeamIssueItem(directoryId, teamId, issueId);
  const directoryItems = await readDirectoryItems(directoryId);
  let entityId;

  if (issue) {
    requireAssignedProjectPermission(
      directoryItems,
      principal,
      issue.assignedProjectId?.S,
      'viewer',
    );
    entityId = createTeamIssueAuditEntityId(teamId, issueId);
  } else {
    const legacyIssue = (await readLegacyTeamIssues(directoryId, directoryItems, teamId, principal))
      .find((candidate) => candidate.id === issueId);

    if (!legacyIssue?.assignedProjectId) {
      return json(404, { message: 'Issue was not found.' }, headers);
    }

    entityId = createProjectTaskAuditEntityId(legacyIssue.assignedProjectId, issueId);
  }
  const page = await queryAuditEventPage(directoryId, event, {
    entityType: 'work-item',
    entityId,
  });

  return json(200, page, headers);
}

async function listWorkspaceAuditEvents(event, headers, directoryId) {
  const isExport = (event.rawPath ?? '').endsWith('/export');

  if (!isExport) {
    return json(200, await queryAuditEventPage(directoryId, event), headers);
  }

  const events = [];
  let cursor;

  do {
    const page = await queryAuditEventPage(directoryId, event, {
      cursor,
      limit: Math.min(100, 1000 - events.length),
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor && events.length < 1000);

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'content-disposition': 'attachment; filename="mukuroji-audit.ndjson"',
      'content-type': 'application/x-ndjson; charset=utf-8',
    },
    body: events.map((item) => JSON.stringify(item)).join('\\n') + (events.length ? '\\n' : ''),
  };
}

async function queryAuditEventPage(directoryId, event, overrides = {}) {
  if (!process.env.AUDIT_EVENTS_TABLE_NAME) {
    const error = new Error('Audit event table is not configured.');
    error.name = 'ResourceNotFoundException';
    throw error;
  }

  const query = event.queryStringParameters ?? {};
  const targetType = overrides.entityType ?? query.targetType;
  const targetId = overrides.entityId ?? query.targetId;
  const actorUserId = (query.actorId ?? query.actorUserId)?.trim();
  const eventType = query.eventType?.trim();

  if ((targetType && !targetId) || (!targetType && targetId)) {
    const error = new Error('Target type and target ID must be specified together.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  const useEntityIndex = Boolean(overrides.entityType);
  const useTargetIndex = Boolean(targetType && targetId && !useEntityIndex);
  const useActorIndex = Boolean(actorUserId && !useEntityIndex && !useTargetIndex);
  const indexName = useEntityIndex
    ? 'EntityOccurredAtIndex'
    : useTargetIndex
      ? 'TargetOccurredAtIndex'
      : useActorIndex
        ? 'ActorOccurredAtIndex'
        : 'WorkspaceOccurredAtIndex';
  const partitionName = useEntityIndex
    ? 'entityKey'
    : useTargetIndex
      ? 'targetKey'
      : useActorIndex
        ? 'actorKey'
        : 'workspaceKey';
  const sortName = useEntityIndex
    ? 'entityEventKey'
    : useTargetIndex
      ? 'targetEventKey'
      : useActorIndex
        ? 'actorEventKey'
        : 'workspaceEventKey';
  const partitionValue = useEntityIndex
    ? createGenericAuditEntityKey(directoryId, targetType, targetId)
    : useTargetIndex
      ? createGenericAuditEntityKey(directoryId, targetType, targetId)
      : useActorIndex
        ? directoryId + '#actor#' + actorUserId
        : directoryId;
  const from = readAuditDate(query.from, '0000-01-01T00:00:00.000Z');
  const to = readAuditDate(query.to, '9999-12-31T23:59:59.999Z');

  if (from > to) {
    const error = new Error('Audit from must be before or equal to to.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  const requestedLimit = overrides.limit ?? Number(query.limit ?? 50);

  if (!Number.isFinite(requestedLimit)) {
    const error = new Error('Audit limit is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  const limit = clampAuditLimit(requestedLimit);
  const cursor = overrides.cursor ?? query.cursor;
  const scopeHash = hashAuditValue(canonicalAuditString({
    actorUserId: actorUserId || undefined,
    directoryId,
    eventType: eventType || undefined,
    from,
    indexName,
    partitionName,
    partitionValue,
    sortName,
    targetId: targetId || undefined,
    targetType: targetType || undefined,
    to,
  }));
  const exclusiveStartKey = cursor
    ? decodeAuditCursor(cursor, {
        directoryId,
        indexName,
        partitionName,
        partitionValue,
        scopeHash,
        sortName,
      })
    : undefined;

  const filterParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':partition': { S: partitionValue },
    ':from': { S: from + '#' },
    ':to': { S: to + '#\\uffff' },
  };

  if (actorUserId && !useActorIndex) {
    filterParts.push('#actorUserId = :actorUserId');
    expressionAttributeNames['#actorUserId'] = 'actorUserId';
    expressionAttributeValues[':actorUserId'] = { S: actorUserId };
  }

  if (eventType) {
    filterParts.push('#eventType = :eventType');
    expressionAttributeNames['#eventType'] = 'eventType';
    expressionAttributeValues[':eventType'] = { S: eventType };
  }

  const response = await dynamodb.send(new QueryCommand({
    TableName: process.env.AUDIT_EVENTS_TABLE_NAME,
    IndexName: indexName,
    KeyConditionExpression: '#partition = :partition AND #sort BETWEEN :from AND :to',
    ExpressionAttributeNames: {
      '#partition': partitionName,
      '#sort': sortName,
      ...expressionAttributeNames,
    },
    ExpressionAttributeValues: expressionAttributeValues,
    ...(filterParts.length ? { FilterExpression: filterParts.join(' AND ') } : {}),
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    Limit: limit,
    ScanIndexForward: false,
  }));

  return {
    events: (response.Items ?? []).map(toAuditEventResponse),
    ...(response.LastEvaluatedKey
      ? { nextCursor: encodeAuditCursor(indexName, scopeHash, response.LastEvaluatedKey) }
      : {}),
  };
}

function toAuditEventResponse(item) {
  const value = fromDynamoItem(item);
  const publicMetadataFields = new Set([
    'adapter',
    'backfilled',
    'commentId',
    'diffUnavailable',
    'kind',
    'legacyEventId',
    'legacyEventType',
    'legacySource',
    'memberKey',
    'projectId',
    'teamId',
  ]);

  if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
    value.metadata = Object.fromEntries(
      Object.entries(value.metadata).filter(([field]) => publicMetadataFields.has(field)),
    );

    if (Object.keys(value.metadata).length === 0) {
      delete value.metadata;
    }
  } else {
    delete value.metadata;
  }

  delete value.directoryId;
  delete value.workspaceKey;
  delete value.workspaceEventKey;
  delete value.entityKey;
  delete value.entityEventKey;
  delete value.targetKey;
  delete value.targetEventKey;
  delete value.actorKey;
  delete value.actorEventKey;
  delete value.occurredAtEventId;
  delete value.requestFingerprint;
  delete value.idempotencyKeyHash;
  delete value.expiresAt;
  delete value.outboxStatus;
  delete value.sourceDetails;

  return value;
}

function encodeAuditCursor(indexName, scopeHash, lastEvaluatedKey) {
  return Buffer.from(JSON.stringify({
    version: 1,
    indexName,
    scopeHash,
    lastEvaluatedKey,
  }), 'utf8').toString('base64url');
}

function decodeAuditCursor(value, expected) {
  try {
    const payload = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const key = payload?.lastEvaluatedKey;

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.version !== 1 ||
      payload.indexName !== expected.indexName ||
      payload.scopeHash !== expected.scopeHash ||
      !key ||
      typeof key !== 'object' ||
      Array.isArray(key) ||
      key[expected.partitionName]?.S !== expected.partitionValue ||
      key.directoryId?.S !== expected.directoryId ||
      typeof key.eventId?.S !== 'string' ||
      typeof key[expected.sortName]?.S !== 'string' ||
      (key.workspaceKey !== undefined && key.workspaceKey?.S !== expected.directoryId)
    ) {
      throw new Error('invalid cursor');
    }

    return key;
  } catch {
    const error = new Error('Audit cursor is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }
}

function readAuditDate(value, fallback) {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    const error = new Error('Audit date range is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return date.toISOString();
}

function clampAuditLimit(value) {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 50;
}

async function putIssueEvent(input) {
  const item = createIssueEventItem(input);

  await dynamodb.send(new PutItemCommand({
    TableName: process.env.TEAM_ISSUE_EVENTS_TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
  }));

  return item;
}

function createIssueEventItem(input) {
  const item = {
    directoryTeamIssueId: { S: createDirectoryTeamIssueId(input.directoryId, input.teamId, input.issueId) },
    eventId: { S: createTeamIssueEventId(input.eventType, input.createdAt) },
    directoryId: { S: input.directoryId },
    teamId: { S: input.teamId },
    issueId: { S: input.issueId },
    eventType: { S: input.eventType },
    actorUserId: { S: input.actorUserId },
    summary: { S: input.summary },
    createdAt: { S: input.createdAt },
  };

  if (input.body) {
    item.body = { S: input.body };
  }

  return item;
}

function createAuditEventPut(directoryId, context, input) {
  const tableName = process.env.AUDIT_EVENTS_TABLE_NAME;

  if (!tableName || !context) {
    return undefined;
  }

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const actorId = context.actorId;
  const idempotencyKeyHash = context.idempotencyKeyHash ?? hashAuditValue(
    'audit-idempotency-v1\\0' + directoryId + '\\0' + actorId + '\\0' + context.idempotencyKey,
  );
  const eventId = 'evt_' + hashAuditValue(canonicalAuditString({
    idempotencyKeyHash,
    schemaVersion: 1,
    sequence: input.sequence ?? 0,
    workspaceId: directoryId,
  })).slice(0, 48);
  const eventKey = occurredAt + '#' + eventId;
  const entityKey = createGenericAuditEntityKey(directoryId, input.entityType, input.entityId);
  const targetType = input.targetType ?? input.entityType;
  const targetId = input.targetId ?? input.entityId;
  const targetKey = createGenericAuditEntityKey(directoryId, targetType, targetId);
  const actorKey = directoryId + '#actor#' + actorId;
  const configuredRetentionDays = Number(process.env.AUDIT_RETENTION_DAYS ?? 2555);

  if (!Number.isFinite(configuredRetentionDays) || configuredRetentionDays <= 0) {
    throw new Error('AUDIT_RETENTION_DAYS must be a positive number.');
  }

  const retentionDays = Math.max(1, Math.floor(configuredRetentionDays));
  const item = {
    directoryId: { S: directoryId },
    workspaceId: { S: directoryId },
    eventId: { S: eventId },
    schemaVersion: { N: '1' },
    eventType: { S: input.eventType },
    occurredAtEventId: { S: eventKey },
    workspaceKey: { S: directoryId },
    workspaceEventKey: { S: eventKey },
    actor: toDynamoValue({
      id: actorId,
      kind: 'user',
      displayName: context.actorDisplayName,
    }),
    entity: toDynamoValue({ type: input.entityType, id: input.entityId }),
    entityType: { S: input.entityType },
    entityId: { S: input.entityId },
    target: toDynamoValue({ type: targetType, id: targetId }),
    targetType: { S: targetType },
    targetId: { S: targetId },
    action: { S: input.action },
    actorUserId: { S: actorId },
    occurredAt: { S: occurredAt },
    correlationId: { S: context.correlationId },
    idempotencyKeyHash: { S: idempotencyKeyHash },
    requestFingerprint: { S: context.requestFingerprint },
    source: { S: context.source },
    sourceDetails: toDynamoValue({
      kind: context.source,
      method: context.method,
      route: context.path,
      requestId: context.requestId,
    }),
    changes: toDynamoValue(input.changes ?? []),
    entityKey: { S: entityKey },
    entityEventKey: { S: eventKey },
    targetKey: { S: targetKey },
    targetEventKey: { S: eventKey },
    actorKey: { S: actorKey },
    actorEventKey: { S: eventKey },
    outboxStatus: { S: 'pending' },
    expiresAt: { N: String(Math.floor(Date.parse(occurredAt) / 1000) + retentionDays * 86400) },
  };

  if (input.metadata) {
    item.metadata = toDynamoValue(sanitizeAuditValue(input.metadata));
  }

  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    },
  };
}

function createGenericAuditEntityKey(workspaceId, entityType, entityId) {
  return workspaceId + '#' + entityType + '#' + entityId;
}

function createProjectTaskAuditEntityId(projectId, taskId) {
  return 'project/' + projectId + '/task/' + taskId;
}

function createTeamIssueAuditEntityId(teamId, issueId) {
  return 'team/' + teamId + '/issue/' + issueId;
}

function createTeamIssueCommentAuditTargetId(teamId, issueId, commentId) {
  return createTeamIssueAuditEntityId(teamId, issueId) + '/comment/' + commentId;
}

function canonicalAuditString(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalAuditString).join(',') + ']';
  }

  if (value && typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalAuditString(value[key]))
      .join(',') + '}';
  }

  return JSON.stringify(value);
}

function createAuditChanges(before, after, fields) {
  const keys = fields ?? Array.from(new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])).sort();

  return keys.flatMap((field) => {
    const beforeValue = before?.[field];
    const afterValue = after?.[field];
    const redacted = isSensitiveAuditField(field);

    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) {
      return [];
    }

    return [{
      field,
      ...(beforeValue !== undefined ? { before: sanitizeAuditValue(beforeValue, field) } : {}),
      ...(afterValue !== undefined ? { after: sanitizeAuditValue(afterValue, field) } : {}),
      ...(redacted ? { redacted: true } : {}),
    }];
  });
}

function sanitizeAuditValue(value, fieldName = '') {
  if (isSensitiveAuditField(fieldName)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return value.length > 4096 ? value.slice(0, 4095) + '…' : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeAuditValue(item, key)]),
    );
  }

  return value;
}

function isSensitiveAuditField(fieldName) {
  return /(?:access[-_]?(?:key|token)|api[-_]?key|authorization|cookie|credential|id[-_]?token|password|private[-_]?key|refresh[-_]?token|secret|signed[-_]?url|token)/i.test(fieldName);
}

function toDynamoValue(value) {
  if (value === null) {
    return { NULL: true };
  }

  if (Array.isArray(value)) {
    return { L: value.map(toDynamoValue) };
  }

  if (value && typeof value === 'object') {
    return {
      M: Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, toDynamoValue(item)]),
      ),
    };
  }

  if (typeof value === 'number') {
    return { N: String(value) };
  }

  if (typeof value === 'boolean') {
    return { BOOL: value };
  }

  return { S: String(value) };
}

function fromDynamoValue(value) {
  if (!value) {
    return undefined;
  }

  if ('S' in value) {
    return value.S;
  }

  if ('N' in value) {
    return Number(value.N);
  }

  if ('BOOL' in value) {
    return value.BOOL;
  }

  if ('NULL' in value) {
    return null;
  }

  if ('L' in value) {
    return value.L.map(fromDynamoValue);
  }

  if ('M' in value) {
    return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, fromDynamoValue(item)]));
  }

  return undefined;
}

function fromDynamoItem(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fromDynamoValue(value)]));
}

async function readDirectoryItems(directoryId, consistentRead = false) {
  return queryAll({
    TableName: process.env.PROJECT_DIRECTORY_TABLE_NAME,
    KeyConditionExpression: 'directoryId = :directoryId',
    ExpressionAttributeValues: {
      ':directoryId': { S: directoryId },
    },
    ScanIndexForward: true,
    ...(consistentRead ? { ConsistentRead: true } : {}),
  });
}

function findActiveTeam(items, teamId) {
  return items.find((item) =>
    item.entryType?.S === 'team' &&
    item.teamId?.S === teamId &&
    isActiveDirectoryItem(item)
  );
}

function validateAssignedProjectInTeam(items, teamId, assignedProjectId) {
  if (!assignedProjectId) {
    return;
  }

  const hasAssignedProject = items.some((item) =>
    item.entryType?.S === 'project' &&
    item.teamId?.S === teamId &&
    item.projectId?.S === assignedProjectId &&
    isActiveDirectoryItem(item)
  );

  if (!hasAssignedProject) {
    const error = new Error('Assigned project is not active in team.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }
}

function requireAssignedProjectPermission(items, principal, assignedProjectId, minimumRole) {
  if (!assignedProjectId || principal.isSystemAdmin) {
    return;
  }

  if (!canAccessAssignedProject(items, principal, assignedProjectId, minimumRole)) {
    const error = new Error('Project access is denied.');
    error.name = 'ProjectAccessDenied';
    throw error;
  }
}

function canAccessAssignedProject(items, principal, assignedProjectId, minimumRole) {
  if (!assignedProjectId || principal.isSystemAdmin) {
    return true;
  }

  const normalizedMemberKey = normalizeProjectMemberKey(principal.userKey);
  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === assignedProjectId &&
    item.memberKey?.S === normalizedMemberKey
  );

  return isProjectRole(member?.role?.S) && projectRoleAllows(member.role.S, minimumRole);
}

function findFirstActiveProjectTeamId(items, projectId) {
  const activeTeamIds = new Set(
    items
      .filter((item) => item.entryType?.S === 'team' && isActiveDirectoryItem(item))
      .map((item) => item.teamId?.S)
      .filter(Boolean)
  );
  const project = items.find((item) =>
    item.entryType?.S === 'project' &&
    item.projectId?.S === projectId &&
    activeTeamIds.has(item.teamId?.S) &&
    isActiveDirectoryItem(item)
  );

  return project?.teamId?.S;
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

function isWorkspaceAuditRequest(event) {
  if (event.requestContext?.http?.method !== 'GET') {
    return false;
  }

  const path = event.rawPath ?? '';
  return path === '/audit/events' ||
    path === '/api/audit/events' ||
    path === '/audit/events/export' ||
    path === '/api/audit/events/export';
}

function readTeamIssueActivityParams(event) {
  if (event.requestContext?.http?.method !== 'GET') {
    return undefined;
  }

  const match = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/issues\\/([^/]+)\\/activity$/);
  const teamId = match?.[1] ? decodePathSegment(match[1]) : undefined;
  const issueId = match?.[2] ? decodePathSegment(match[2]) : undefined;

  return teamId && issueId ? { teamId, issueId } : undefined;
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

	function readProjectUsersProjectId(event) {
	  if (event.requestContext?.http?.method !== 'GET') {
	    return undefined;
	  }

	  const encodedProjectId = event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/users$/)?.[1];

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

function readTeamIssueListParams(event) {
  if (event.requestContext?.http?.method !== 'GET' && event.requestContext?.http?.method !== 'POST') {
    return undefined;
  }

  const encodedTeamId = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/issues$/)?.[1];
  const teamId = encodedTeamId ? decodePathSegment(encodedTeamId) : undefined;

  return teamId ? { teamId } : undefined;
}

function readTeamIssueDetailParams(event) {
  if (event.requestContext?.http?.method !== 'GET' && event.requestContext?.http?.method !== 'PATCH') {
    return undefined;
  }

  const match = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/issues\\/([^/]+)$/);
  const teamId = match?.[1] ? decodePathSegment(match[1]) : undefined;
  const issueId = match?.[2] ? decodePathSegment(match[2]) : undefined;

  return teamId && issueId ? { teamId, issueId } : undefined;
}

function readTeamIssueCommentParams(event) {
  if (event.requestContext?.http?.method !== 'POST') {
    return undefined;
  }

  const match = event.rawPath?.match(/^\\/(?:api\\/)?teams\\/([^/]+)\\/issues\\/([^/]+)\\/comments$/);
  const teamId = match?.[1] ? decodePathSegment(match[1]) : undefined;
  const issueId = match?.[2] ? decodePathSegment(match[2]) : undefined;

  return teamId && issueId ? { teamId, issueId } : undefined;
}

function readProjectIssuesProjectId(event) {
  if (event.requestContext?.http?.method !== 'GET') {
    return undefined;
  }

  const encodedProjectId = event.rawPath?.match(/^\\/(?:api\\/)?projects\\/([^/]+)\\/issues$/)?.[1];

  return encodedProjectId ? decodePathSegment(encodedProjectId) : undefined;
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
  if (principal.isSystemAdmin) {
    return undefined;
  }

  const projectAccess = await getProjectAccess(
    principal.directoryId,
    projectId,
    principal.userKey,
  );

  if (!projectAccess) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  if (!projectAccess.role || !projectRoleAllows(projectAccess.role, minimumRole)) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  return undefined;
}

async function enforceTeamPermission(headers, principal, teamId, minimumRole) {
  if (principal.isSystemAdmin) {
    return undefined;
  }

  const teamAccess = await getTeamAccess(
    principal.directoryId,
    teamId,
    principal.userKey,
  );

  if (!teamAccess) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  if (!teamAccess.role || !projectRoleAllows(teamAccess.role, minimumRole)) {
    return json(403, { message: 'Project access is denied.' }, headers);
  }

  return undefined;
}

async function getProjectAccess(directoryId, projectId, memberKey) {
  const normalizedMemberKey = normalizeProjectMemberKey(memberKey);
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

  const hasProjectAccess = items.some((item) =>
    item.entryType?.S === 'project' &&
    item.projectId?.S === projectId &&
    activeTeamIds.has(item.teamId?.S) &&
    isActiveDirectoryItem(item)
  );

  if (!hasProjectAccess) {
    return undefined;
  }

  const member = items.find((item) =>
    item.entryType?.S === 'project-member' &&
    item.projectId?.S === projectId &&
    item.memberKey?.S === normalizedMemberKey
  );

  return {
    projectId,
    role: member?.role?.S,
  };
}

async function getTeamAccess(directoryId, teamId, memberKey) {
  const normalizedMemberKey = normalizeProjectMemberKey(memberKey);
  const items = await readDirectoryItems(directoryId);

  if (!findActiveTeam(items, teamId)) {
    return undefined;
  }

  const projectIds = new Set(
    items
      .filter((item) =>
        item.entryType?.S === 'project' &&
        item.teamId?.S === teamId &&
        isActiveDirectoryItem(item)
      )
      .map((item) => item.projectId?.S)
      .filter(Boolean)
  );
  const roles = items
    .filter((item) =>
      item.entryType?.S === 'project-member' &&
      item.memberKey?.S === normalizedMemberKey &&
      projectIds.has(item.projectId?.S)
    )
    .map((item) => item.role?.S)
    .filter(Boolean)
    .sort((first, second) => projectRoleWeight(second) - projectRoleWeight(first));

  return roles[0] ? { teamId, role: roles[0] } : undefined;
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

	async function hydrateProjectMembers(members, userPoolId) {
	  return Promise.all(members.map((member) => hydrateProjectMember(member, userPoolId)));
	}

	async function hydrateProjectMember(member, userPoolId) {
	  try {
	    const profile = await getUserProfile(userPoolId, member.id);

	    return {
	      ...member,
	      id: profile.id,
	      email: profile.email,
	      username: profile.username,
	      name: profile.name,
	      enabled: profile.enabled,
	      status: profile.status,
	    };
	  } catch (error) {
	    if (error?.name === 'UserNotFoundException') {
	      return member;
	    }

	    console.warn('Failed to hydrate project member from Cognito:', error);
	    return member;
	  }
	}

	async function hydrateProjectTasks(tasks, userPoolId) {
	  const profiles = new Map();
	  const userIds = [...new Set(tasks.map((task) => task.assigneeUserId).filter(Boolean))];

	  await Promise.all(userIds.map(async (userId) => {
	    try {
	      profiles.set(userId, await getUserProfile(userPoolId, userId));
	    } catch (error) {
	      if (error?.name !== 'UserNotFoundException') {
	        console.warn('Failed to hydrate task assignee from Cognito:', error);
	      }
	    }
	  }));

	  return tasks.map((task) => hydrateProjectTaskFromProfiles(task, profiles));
	}

	async function hydrateProjectTask(task, userPoolId) {
	  if (!task.assigneeUserId) {
	    return task;
	  }

	  try {
	    const profile = await getUserProfile(userPoolId, task.assigneeUserId);
	    return hydrateProjectTaskFromProfiles(task, new Map([[task.assigneeUserId, profile]]));
	  } catch (error) {
	    if (error?.name === 'UserNotFoundException') {
	      return task;
	    }

	    console.warn('Failed to hydrate task assignee from Cognito:', error);
	    return task;
	  }
	}

	function hydrateProjectTaskFromProfiles(task, profiles) {
	  if (!task.assigneeUserId) {
	    return task;
	  }

	  const profile = profiles.get(task.assigneeUserId);

	  if (!profile) {
	    return task;
	  }

	  return {
	    ...task,
	    assigneeEmail: profile.email,
	    assigneeName: profile.name,
	  };
	}

async function hydrateTeamIssues(issues, userPoolId) {
  const profiles = new Map();
  const userIds = [...new Set(issues.map((issue) => issue.assigneeUserId).filter(Boolean))];

  await Promise.all(userIds.map(async (userId) => {
    try {
      profiles.set(userId, await getUserProfile(userPoolId, userId));
    } catch (error) {
      if (error?.name !== 'UserNotFoundException') {
        console.warn('Failed to hydrate issue assignee from Cognito:', error);
      }
    }
  }));

  return issues.map((issue) => hydrateTeamIssueFromProfiles(issue, profiles));
}

async function hydrateTeamIssue(issue, userPoolId) {
  if (!issue.assigneeUserId) {
    return issue;
  }

  try {
    const profile = await getUserProfile(userPoolId, issue.assigneeUserId);
    return hydrateTeamIssueFromProfiles(issue, new Map([[issue.assigneeUserId, profile]]));
  } catch (error) {
    if (error?.name === 'UserNotFoundException') {
      return issue;
    }

    console.warn('Failed to hydrate issue assignee from Cognito:', error);
    return issue;
  }
}

function hydrateTeamIssueFromProfiles(issue, profiles) {
  if (!issue.assigneeUserId) {
    return issue;
  }

  const profile = profiles.get(issue.assigneeUserId);

  if (!profile) {
    return issue;
  }

  return {
    ...issue,
    assigneeEmail: profile.email,
    assigneeName: profile.name,
  };
}

	async function getUserProfile(userPoolId, userId) {
	  if (!userPoolId) {
	    const error = new Error('Cognito user pool is not available.');
	    error.name = 'ResourceNotFoundException';
	    throw error;
	  }

	  const normalizedUserId = normalizeProjectMemberKey(userId);
	  const profile = toCognitoUserProfile(await cognito.send(new AdminGetUserCommand({
	    UserPoolId: userPoolId,
	    Username: normalizedUserId,
	  })));

	  if (!profile) {
	    const error = new Error('Cognito user was not found.');
	    error.name = 'UserNotFoundException';
	    throw error;
	  }

	  return profile;
	}

function json(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function isTransactionCancellationReason(error, index, code) {
  return hasTransactionCancellationReason(error, code) &&
    error.CancellationReasons[index]?.Code === code;
}

function hasTransactionCancellationReason(error, code) {
  if (error?.name !== 'TransactionCanceledException' || !Array.isArray(error.CancellationReasons)) {
    return false;
  }

  const reasonCodes = error.CancellationReasons.map((reason) => reason?.Code);

  return reasonCodes.includes(code) &&
    reasonCodes.every((reasonCode) => reasonCode === 'None' || reasonCode === code);
}

function toProjectDataError(error, headers, fallbackMessage) {
  console.error(error);

  if (
    error?.name === 'ConditionalCheckFailedException' ||
    hasTransactionCancellationReason(error, 'ConditionalCheckFailed')
  ) {
    return json(409, { message: 'The same item already exists.' }, headers);
  }

  if (error?.name === 'UserNotFoundException') {
    return json(404, { message: 'Cognito user was not found.' }, headers);
  }

  if (error?.name === 'InvalidProjectWrite') {
    return json(400, { message: error.message || 'Project write is invalid.' }, headers);
  }

  if (error?.name === 'TeamIssueNotFound') {
    return json(404, { message: 'Issue was not found.' }, headers);
  }

  if (error?.name === 'ProjectAccessDenied') {
    return json(403, { message: 'Project access is denied.' }, headers);
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
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-correlation-id',
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

function createMutationContext(event, principal, workspaceId) {
  const method = event.requestContext?.http?.method ?? 'GET';

  if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
    return undefined;
  }

  const path = event.rawPath ?? '/';
  const requestFingerprint = hashAuditValue(canonicalAuditString({
    body: readJsonBody(event),
    method: method.toUpperCase(),
    path,
    query: event.queryStringParameters,
  }));
  const suppliedIdempotencyKey = readRequestHeader(event, 'idempotency-key')?.trim();
  const idempotencyKey = suppliedIdempotencyKey || event.requestContext?.requestId || requestFingerprint;

  if (idempotencyKey.length > 256) {
    const error = new Error('Idempotency-Key must be 256 characters or fewer.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  const actorId = principal.actorId;
  const idempotencyKeyHash = hashAuditValue(
    'audit-idempotency-v1\\0' + workspaceId + '\\0' + actorId + '\\0' + idempotencyKey,
  );
  const correlationId = readRequestHeader(event, 'x-correlation-id')?.trim() ||
    'corr_' + hashAuditValue(workspaceId + '\\0' + idempotencyKeyHash).slice(0, 32);

  if (correlationId.length > 256) {
    const error = new Error('X-Correlation-Id must be 256 characters or fewer.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return {
    actorId,
    actorDisplayName: principal.userKey,
    correlationId,
    idempotencyKey,
    idempotencyKeyHash,
    method,
    path,
    requestId: event.requestContext?.requestId,
    requestFingerprint,
    source: 'api',
  };
}

function readRequestHeader(event, name) {
  const headers = event.headers ?? {};
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());

  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function hashAuditValue(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function toProjectPrincipal(user, accessToken, userPoolId) {
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
	    actorId: readUserAttribute(user, 'sub')?.trim() || user.Username?.trim() || normalizedUserKey,
	    directoryId,
	    userKey: normalizedUserKey,
	    userPoolId,
	    isSystemAdmin: groups.some((group) => getSystemAdminGroups().includes(group)),
	  };
	}

	function readUserAttribute(user, name) {
	  return user.UserAttributes?.find((attribute) => attribute.Name === name)?.Value;
	}

	function readConfiguredCognitoUserPoolId() {
	  return process.env.COGNITO_USER_POOL_ID?.trim();
	}

	function isExpectedCognitoIssuer(accessToken, userPoolId) {
	  const issuer = decodeJwtPayload(accessToken)?.iss;

	  if (typeof issuer !== 'string') {
	    return false;
	  }

	  return issuer === createCognitoIssuer(userPoolId);
	}

	function createCognitoIssuer(userPoolId) {
	  const region = userPoolId.includes('_')
	    ? userPoolId.split('_')[0]
	    : process.env.AWS_REGION;

	  return 'https://cognito-idp.' + region + '.amazonaws.com/' + userPoolId;
	}

	function toCognitoUserProfile(user) {
	  const email = readCognitoUserAttribute(user, 'email')?.trim().toLowerCase();
	  const username = user.Username?.trim();

	  if (!email || !username) {
	    return undefined;
	  }

	  return {
	    id: email,
	    username,
	    email,
	    name: readCognitoUserAttribute(user, 'name')?.trim() || undefined,
	    enabled: user.Enabled,
	    status: user.UserStatus,
	  };
	}

	function readCognitoUserAttribute(user, name) {
	  return (user.Attributes ?? user.UserAttributes)?.find((attribute) => attribute.Name === name)?.Value;
	}

	function isCognitoUserInDirectory(user, directoryId) {
	  if (!directoryId) {
	    return true;
	  }

	  return ['custom:directory_id', 'custom:workspace_id'].some((attributeName) =>
	    readCognitoUserAttribute(user, attributeName)?.trim() === directoryId
	  );
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

function createDirectoryTeamId(directoryId, teamId) {
  return directoryId + '#team#' + teamId;
}

function createDirectoryTeamIssueId(directoryId, teamId, issueId) {
  return createDirectoryTeamId(directoryId, teamId) + '#issue#' + issueId;
}

function createTeamIssueEventId(eventType, createdAt) {
  return createdAt + '#' + eventType + '#' + Math.random().toString(36).slice(2, 10);
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function readRequiredString(value, message) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(message);
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value.trim();
}

function readOptionalString(value, message) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    const error = new Error(message);
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value.trim();
}

function readAssignedProjectId(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    const error = new Error('Assigned project is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value.trim() || null;
}

function readTeamIssueAssigneeUserId(input) {
  const value = input.assigneeUserId;

  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('Issue assignee is required.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return normalizeProjectMemberKey(value);
}

function readRequiredCommentBody(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('Issue comment body is required.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value.trim();
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
	    email: item.email?.S ?? item.memberKey.S,
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

	  return (first.name?.S ?? first.email?.S ?? first.memberKey?.S ?? '').localeCompare(
	    second.name?.S ?? second.email?.S ?? second.memberKey?.S ?? '',
	    'ja',
	  );
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

	  if (item.assigneeUserId?.S) {
	    task.assigneeUserId = item.assigneeUserId.S;
	  }

	  if (item.assignee?.S) {
    task.assignee = item.assignee.S;
  }

  return task;
}

function toTeamIssue(item) {
  const issue = {
    id: item.issueId.S,
    teamId: item.teamId.S,
    assigneeUserId: item.assigneeUserId.S,
    status: item.status.S,
    dueDate: item.dueDate.S,
    priority: item.priority.S,
    createdAt: item.createdAt.S,
    updatedAt: item.updatedAt.S,
    source: 'dynamodb',
  };

  if (item.assignedProjectId?.S) {
    issue.assignedProjectId = item.assignedProjectId.S;
  }

  if (item.titleKey?.S) {
    issue.titleKey = item.titleKey.S;
  }

  if (item.title?.S) {
    issue.title = item.title.S;
  }

  if (item.description?.S) {
    issue.description = item.description.S;
  }

  return issue;
}

function toLegacyTeamIssue(task, teamId, assignedProjectId) {
  const issue = {
    id: task.id,
    teamId,
    assignedProjectId,
    titleKey: task.titleKey,
    title: task.title,
    assigneeUserId: task.assigneeUserId ?? task.assigneeKey ?? task.assignee ?? 'legacy-assignee@example.invalid',
    assigneeEmail: task.assigneeEmail,
    assigneeName: task.assigneeName,
    status: task.status,
    dueDate: task.dueDate,
    priority: task.priority,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    source: 'legacy',
  };

  return Object.fromEntries(Object.entries(issue).filter(([, value]) => value !== undefined));
}

function toTeamIssueComment(item) {
  return {
    id: item.eventId.S,
    actorUserId: item.actorUserId.S,
    body: item.body?.S ?? '',
    createdAt: item.createdAt.S,
  };
}

function toTeamIssueActivity(item) {
  return {
    id: item.eventId.S,
    type: item.eventType.S,
    actorUserId: item.actorUserId.S,
    summary: item.summary.S,
    createdAt: item.createdAt.S,
  };
}

function readTaskStatus(value) {
  if (value === undefined) {
    return 'todo';
  }

  if (!isTaskStatus(value)) {
    const error = new Error('Task status is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value;
}

function readRequiredTaskStatus(value) {
  if (!isTaskStatus(value)) {
    const error = new Error('Task status is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value;
}

function readTaskPriority(value) {
  if (value === undefined) {
    return 'medium';
  }

  if (!isTaskPriority(value)) {
    const error = new Error('Task priority is invalid.');
    error.name = 'InvalidProjectWrite';
    throw error;
  }

  return value;
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

	function clampCognitoPageLimit(value) {
	  if (!Number.isFinite(value)) {
	    return 20;
	  }

	  return Math.max(1, Math.min(60, Math.floor(value)));
	}

	function escapeCognitoFilterValue(value) {
	  return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
	}

	function isProjectTone(value) {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow';
}
      `),
    });

    tasksTable.grantReadWriteData(listTasksFunction);
    teamIssuesTable.grantReadWriteData(listTasksFunction);
    teamIssueEventsTable.grantReadWriteData(listTasksFunction);
    projectDirectoryTable.grantReadWriteData(listTasksFunction);
    auditEventsTable.grantReadData(listTasksFunction);
    listTasksFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [
          tasksTable.tableArn,
          projectDirectoryTable.tableArn,
          teamIssuesTable.tableArn,
          teamIssueEventsTable.tableArn,
          auditEventsTable.tableArn,
        ],
      }),
    );
	    listTasksFunction.addToRolePolicy(
	      new iam.PolicyStatement({
	        actions: ['cognito-idp:AdminGetUser', 'cognito-idp:GetUser', 'cognito-idp:ListUsers'],
	        resources: [cognitoUserPoolArn],
	      }),
	    );

    const tasksFunctionUrl = listTasksFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: taskApiAllowedOriginList,
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST, lambda.HttpMethod.PATCH, lambda.HttpMethod.DELETE],
        allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
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

    new cdk.CfnOutput(this, 'TeamIssuesTableName', {
      value: teamIssuesTable.tableName,
    });

    new cdk.CfnOutput(this, 'TeamIssueEventsTableName', {
      value: teamIssueEventsTable.tableName,
    });

    new cdk.CfnOutput(this, 'AuditEventsTableName', {
      value: auditEventsTable.tableName,
    });

    new cdk.CfnOutput(this, 'AuditEventsStreamArn', {
      value: auditEventsTable.tableStreamArn!,
    });

    new cdk.CfnOutput(this, 'ProcessedAuditEventsTableName', {
      value: processedAuditEventsTable.tableName,
    });

    new cdk.CfnOutput(this, 'ProjectTasksApiUrl', {
      value: tasksFunctionUrl.url,
    });
  }
}
