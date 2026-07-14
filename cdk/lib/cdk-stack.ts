import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Project が複数 Team に表示される場合も含めた canonical owner Team です。
 */
const projectOwnerTeamIds = {
  refero: 'core-team',
  'product-roadmap': 'core-team',
  'shared-launch': 'core-team',
  'brand-refresh': 'design-team',
} as const;

/**
 * Canonical Work Item table に初期投入する Refero の demo データです。
 */
const canonicalWorkItemItems = [
  ['refero', 'wireframe', 10, 'tasks.item.wireframe', '新しいランディングページのワイヤーフレーム作成', 'sato@example.com', 'in-progress', '2026/06/03', 'high'],
  ['refero', 'brand-guideline', 20, 'tasks.item.brandGuideline', 'ブランドガイドラインの更新', 'suzuki@example.com', 'review', '2026/06/05', 'medium'],
  ['refero', 'pricing-content', 30, 'tasks.item.pricingContent', '料金ページのコンテンツ作成', 'tanaka@example.com', 'in-progress', '2026/06/08', 'high'],
  ['refero', 'seo-research', 40, 'tasks.item.seoResearch', 'SEO キーワードリサーチ', 'yamamoto@example.com', 'todo', '2026/06/09', 'medium'],
  ['refero', 'hero-design', 50, 'tasks.item.heroDesign', 'ヒーロー画像のデザイン作成', 'sato@example.com', 'review', '2026/06/10', 'medium'],
  ['refero', 'analytics-tags', 60, 'tasks.item.analyticsTags', 'アナリティクスタグの実装', 'suzuki@example.com', 'in-progress', '2026/06/11', 'low'],
  ['refero', 'competitor-report', 70, 'tasks.item.competitorReport', '競合サイトの分析レポート作成', 'tanaka@example.com', 'done', '2026/06/02', 'low'],
  ['refero', 'terms-page', 80, 'tasks.item.termsPage', '利用規約ページの作成', 'yamamoto@example.com', 'todo', '2026/06/12', 'medium'],
  ['refero', 'faq-content', 90, 'tasks.item.faqContent', 'FAQ セクションのコンテンツ作成', 'sato@example.com', 'todo', '2026/06/15', 'low'],
  ['refero', 'landing-release', 100, 'tasks.item.landingRelease', 'ランディングページの公開', 'suzuki@example.com', 'todo', '2026/06/16', 'high'],
] as const;

/**
 * Legacy task fallback が使用していた決定的な timestamp です。
 */
const canonicalWorkItemSeedTimestamp = '2026-06-01T00:00:00.000Z';

/**
 * 初期 owner を manager として登録する seed project ID です。
 */
const ownerProjectIds = ['refero', 'product-roadmap', 'shared-launch', 'brand-refresh'] as const;

/**
 * 冪等 bootstrap row に使用する決定的な timestamp です。
 */
const workspaceBootstrapTimestamp = '2026-07-11T00:00:00.000Z';

/**
 * Workspace access table の初期 metadata と owner を作成する transaction payload です。
 */
function createWorkspaceAccessTransactItems(
  tableName: string,
  workspaceId: string,
  initialOwnerEmail: string,
) {
  const createdAt = '2026-07-11T00:00:00.000Z';

  return [
    {
      Update: {
        TableName: tableName,
        Key: {
          workspaceId: { S: workspaceId },
          recordKey: { S: 'WORKSPACE' },
        },
        UpdateExpression:
          'SET entryType = if_not_exists(entryType, :entryType), activeOwnerCount = if_not_exists(activeOwnerCount, :activeOwnerCount), #version = if_not_exists(#version, :version), createdAt = if_not_exists(createdAt, :createdAt), updatedAt = if_not_exists(updatedAt, :updatedAt)',
        ConditionExpression: 'attribute_not_exists(workspaceId) OR #entryType = :entryType',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':entryType': { S: 'workspace-meta' },
          ':activeOwnerCount': { N: '1' },
          ':version': { N: '1' },
          ':createdAt': { S: createdAt },
          ':updatedAt': { S: createdAt },
        },
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: {
          workspaceId: { S: workspaceId },
          recordKey: { S: `MEMBER#${initialOwnerEmail}` },
        },
        UpdateExpression:
          'SET entryType = if_not_exists(entryType, :entryType), id = if_not_exists(id, :memberKey), memberKey = if_not_exists(memberKey, :memberKey), email = if_not_exists(email, :memberKey), #role = if_not_exists(#role, :role), #status = if_not_exists(#status, :status), #version = if_not_exists(#version, :version), createdAt = if_not_exists(createdAt, :createdAt), updatedAt = if_not_exists(updatedAt, :updatedAt)',
        ConditionExpression:
          'attribute_not_exists(workspaceId) OR (#entryType = :entryType AND memberKey = :memberKey)',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#role': 'role',
          '#status': 'status',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':entryType': { S: 'workspace-member' },
          ':memberKey': { S: initialOwnerEmail },
          ':role': { S: 'owner' },
          ':status': { S: 'active' },
          ':version': { N: '1' },
          ':createdAt': { S: createdAt },
          ':updatedAt': { S: createdAt },
        },
      },
    },
  ];
}

/**
 * CDK demo data が参照する Workspace member を既存 role/status を上書きせず seed します。
 */
function createWorkspaceDemoMemberTransactItems(tableName: string, workspaceId: string) {
  const createdAt = '2026-07-11T00:00:00.000Z';
  const members = [
    ['sato@example.com', '佐藤 花子', 'member'],
    ['suzuki@example.com', '鈴木 太郎', 'member'],
    ['tanaka@example.com', '田中 美咲', 'member'],
    ['yamamoto@example.com', '山本 健', 'member'],
    ['viewer@example.com', 'Viewer User', 'guest'],
  ] as const;

  return members.map(([memberKey, name, role]) => ({
    Update: {
      TableName: tableName,
      Key: {
        workspaceId: { S: workspaceId },
        recordKey: { S: `MEMBER#${memberKey}` },
      },
      UpdateExpression:
        'SET entryType = if_not_exists(entryType, :entryType), id = if_not_exists(id, :memberKey), memberKey = if_not_exists(memberKey, :memberKey), email = if_not_exists(email, :memberKey), #name = if_not_exists(#name, :name), #role = if_not_exists(#role, :role), #status = if_not_exists(#status, :status), #version = if_not_exists(#version, :version), createdAt = if_not_exists(createdAt, :createdAt), updatedAt = if_not_exists(updatedAt, :updatedAt)',
      ConditionExpression:
        'attribute_not_exists(workspaceId) OR (#entryType = :entryType AND memberKey = :memberKey)',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#name': 'name',
        '#role': 'role',
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':entryType': { S: 'workspace-member' },
        ':memberKey': { S: memberKey },
        ':name': { S: name },
        ':role': { S: role },
        ':status': { S: 'active' },
        ':version': { N: '1' },
        ':createdAt': { S: createdAt },
        ':updatedAt': { S: createdAt },
      },
    },
  }));
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
 * Refero プロジェクトに追加する owner 以外の demo member です。
 */
const projectMemberItems = [
  ['refero', 'sato@example.com', 'sato@example.com', '佐藤 花子', 'member'],
  ['refero', 'viewer@example.com', 'viewer@example.com', 'Viewer User', 'viewer'],
] as const;

/**
 * DynamoDB に保存する project partition key を作成します。
 */
function createDirectoryProjectId(directoryId: string, projectId: string) {
  return `${directoryId}#project#${projectId}`;
}

/**
 * DynamoDB に保存する project member sort key を作成します。
 */
function createProjectMemberEntryKey(projectId: string, memberKey: string) {
  return `PROJECT_MEMBER#${projectId}#${memberKey}`;
}

/**
 * DynamoDB に保存する workspace member sort key を作成します。
 */
function createWorkspaceMemberEntryKey(memberKey: string) {
  return `WORKSPACE_MEMBER#${memberKey}`;
}

/**
 * DynamoDB に保存する email alias sort key を作成します。
 */
function createEmailAliasEntryKey(email: string) {
  return `EMAIL_ALIAS#${email}`;
}

/**
 * Team-owned canonical Work Item の初回 seed transaction を作成します。
 */
function createCanonicalWorkItemTransactItems(tableName: string, directoryId: string) {
  return canonicalWorkItemItems.map(([
    projectId,
    workItemId,
    sortOrder,
    titleKey,
    title,
    assigneeUserId,
    status,
    dueDate,
    priority,
  ]) => {
    const teamId = projectOwnerTeamIds[projectId];

    return {
      Put: {
        TableName: tableName,
        ConditionExpression: 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)',
        Item: {
          directoryId: { S: directoryId },
          directoryTeamId: { S: `${directoryId}#team#${teamId}` },
          directoryProjectId: { S: createDirectoryProjectId(directoryId, projectId) },
          teamId: { S: teamId },
          assignedProjectId: { S: projectId },
          issueId: { S: workItemId },
          workItemId: { S: workItemId },
          schemaVersion: { N: '1' },
          revision: { N: '1' },
          sortOrder: { N: String(sortOrder) },
          titleKey: { S: titleKey },
          title: { S: title },
          assigneeUserId: { S: assigneeUserId },
          status: { S: status },
          dueDate: { S: dueDate },
          priority: { S: priority },
          createdAt: { S: canonicalWorkItemSeedTimestamp },
          updatedAt: { S: canonicalWorkItemSeedTimestamp },
          source: { S: 'dynamodb' },
          migrationSource: { S: 'legacy-project-task' },
          migrationSourceKey: {
            S: `${createDirectoryProjectId(directoryId, projectId)}#task#${workItemId}`,
          },
        },
      },
    };
  });
}

/**
 * Team/project directory の初回 seed transaction を作成します。
 */
function createProjectDirectoryTransactItems(tableName: string, directoryId: string) {
  const directoryItems = projectDirectoryItems.map((entry) => ({
    Put: {
      TableName: tableName,
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
      Item: {
        directoryId: { S: directoryId },
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
      },
    },
  }));
  const memberItems = projectMemberItems.map(([projectId, memberKey, email, name, role]) => ({
    Put: {
      TableName: tableName,
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
      Item: {
        directoryId: { S: directoryId },
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
 * Workspace metadata、owner、email alias と owner project 権限を冪等投入します。
 */
function createWorkspaceBootstrapTransactItems(
  tableName: string,
  directoryId: string,
  initialOwnerEmail: string,
  initialOwnerUsername: string,
) {
  const workspaceMetadataItem = {
    Update: {
      TableName: tableName,
      Key: {
        directoryId: { S: directoryId },
        entryKey: { S: 'WORKSPACE#METADATA' },
      },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), workspaceId = if_not_exists(workspaceId, :workspaceId)',
      ConditionExpression:
        'attribute_not_exists(directoryId) OR (#entryType = :entryType AND workspaceId = :workspaceId)',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
      },
      ExpressionAttributeValues: {
        ':entryType': { S: 'workspace-metadata' },
        ':workspaceId': { S: directoryId },
      },
    },
  };
  const workspaceOwnerItem = {
    Update: {
      TableName: tableName,
      Key: {
        directoryId: { S: directoryId },
        entryKey: { S: createWorkspaceMemberEntryKey(initialOwnerEmail) },
      },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), workspaceId = if_not_exists(workspaceId, :workspaceId), memberKey = if_not_exists(memberKey, :memberKey), email = :email, username = :username, #role = :role, createdAt = if_not_exists(createdAt, :timestamp), updatedAt = if_not_exists(updatedAt, :timestamp)',
      ConditionExpression:
        'attribute_not_exists(directoryId) OR (#entryType = :entryType AND workspaceId = :workspaceId AND memberKey = :memberKey)',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#role': 'role',
      },
      ExpressionAttributeValues: {
        ':entryType': { S: 'workspace-member' },
        ':workspaceId': { S: directoryId },
        ':memberKey': { S: initialOwnerEmail },
        ':email': { S: initialOwnerEmail },
        ':username': { S: initialOwnerUsername },
        ':role': { S: 'owner' },
        ':timestamp': { S: workspaceBootstrapTimestamp },
      },
    },
  };
  const emailAliasItem = {
    Update: {
      TableName: tableName,
      Key: {
        directoryId: { S: directoryId },
        entryKey: { S: createEmailAliasEntryKey(initialOwnerEmail) },
      },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), workspaceId = if_not_exists(workspaceId, :workspaceId), memberKey = if_not_exists(memberKey, :memberKey), email = :email, username = :username',
      ConditionExpression:
        'attribute_not_exists(directoryId) OR (#entryType = :entryType AND workspaceId = :workspaceId AND memberKey = :memberKey)',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
      },
      ExpressionAttributeValues: {
        ':entryType': { S: 'email-alias' },
        ':workspaceId': { S: directoryId },
        ':memberKey': { S: initialOwnerEmail },
        ':email': { S: initialOwnerEmail },
        ':username': { S: initialOwnerUsername },
      },
    },
  };
  const ownerProjectMemberItems = ownerProjectIds.map((projectId) => ({
    Update: {
      TableName: tableName,
      Key: {
        directoryId: { S: directoryId },
        entryKey: { S: createProjectMemberEntryKey(projectId, initialOwnerEmail) },
      },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), projectId = if_not_exists(projectId, :projectId), memberKey = if_not_exists(memberKey, :memberKey), email = :email, #role = if_not_exists(#role, :role), createdAt = if_not_exists(createdAt, :timestamp), updatedAt = if_not_exists(updatedAt, :timestamp)',
      ConditionExpression:
        'attribute_not_exists(directoryId) OR (#entryType = :entryType AND projectId = :projectId AND memberKey = :memberKey)',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#role': 'role',
      },
      ExpressionAttributeValues: {
        ':entryType': { S: 'project-member' },
        ':projectId': { S: projectId },
        ':memberKey': { S: initialOwnerEmail },
        ':email': { S: initialOwnerEmail },
        ':role': { S: 'manager' },
        ':timestamp': { S: workspaceBootstrapTimestamp },
      },
    },
  }));

  return [workspaceMetadataItem, workspaceOwnerItem, emailAliasItem, ...ownerProjectMemberItems];
}

/**
 * Create と Update の両方で同じ AWS SDK call を行う custom resource properties を作成します。
 */
function createIdempotentAwsCustomResourceProps(
  call: customResources.AwsSdkCall,
  policy: customResources.AwsCustomResourcePolicy,
): customResources.AwsCustomResourceProps {
  return {
    onCreate: call,
    onUpdate: call,
    policy,
    installLatestAwsSdk: false,
  };
}

/**
 * mukuroji の本番 API、永続 data store、workspace bootstrap を定義する stack です。
 */
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskApiAllowedOrigins = new cdk.CfnParameter(this, 'TaskApiAllowedOrigins', {
      type: 'String',
      default: 'http://localhost:5173,http://127.0.0.1:5173',
      allowedPattern: '^https?://[^,\\s]+(,https?://[^,\\s]+)*$',
      constraintDescription:
        'TaskApiAllowedOrigins must be a comma-separated list of HTTP(S) origins without whitespace.',
      description: 'Comma-separated CORS origins allowed to call the mukuroji API.',
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
      allowedPattern: '^[a-z]{2}(?:-[a-z0-9]+)+_[A-Za-z0-9]+$',
      description: 'Existing Cognito user pool ID trusted by the mukuroji API.',
    });
    const cognitoUserPoolClientId = new cdk.CfnParameter(this, 'CognitoUserPoolClientId', {
      type: 'String',
      allowedPattern: '^[A-Za-z0-9]+$',
      description: 'Existing Cognito app client ID used by the mukuroji API.',
    });
    const workspaceDirectoryId = new cdk.CfnParameter(this, 'WorkspaceDirectoryId', {
      type: 'String',
      minLength: 1,
      allowedPattern: '^\\S+$',
      constraintDescription: 'WorkspaceDirectoryId must not contain whitespace.',
      description: 'Canonical workspace directory ID shared by Cognito claims and DynamoDB partitions.',
    });
    const initialOwnerEmail = new cdk.CfnParameter(this, 'InitialOwnerEmail', {
      type: 'String',
      allowedPattern: '^[^A-Z\\s@]+@[^A-Z\\s@]+$',
      constraintDescription: 'InitialOwnerEmail must be a lowercase email address.',
      description: 'Canonical lowercase email address stored for the initial workspace owner.',
    });
    const initialOwnerUsername = new cdk.CfnParameter(this, 'InitialOwnerUsername', {
      type: 'String',
      minLength: 1,
      allowedPattern: '^\\S+$',
      constraintDescription: 'InitialOwnerUsername must not contain whitespace.',
      description: 'Cognito username targeted when bootstrapping the initial owner attributes.',
    });
    const cognitoUserPoolArn = cdk.Stack.of(this).formatArn({
      service: 'cognito-idp',
      resource: 'userpool',
      resourceName: cognitoUserPoolId.valueAsString,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    const legacyTasksTable = new dynamodb.Table(this, 'ProjectTasksTable', {
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    legacyTasksTable.addGlobalSecondaryIndex({
      indexName: 'ProjectSortOrderIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const workItemsTable = new dynamodb.Table(this, 'TeamIssuesTable', {
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'issueId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    workItemsTable.addGlobalSecondaryIndex({
      indexName: 'TeamIssueSortOrderIndex',
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    workItemsTable.addGlobalSecondaryIndex({
      indexName: 'AssignedProjectIssueIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const teamIssueEventsTable = new dynamodb.Table(this, 'TeamIssueEventsTable', {
      partitionKey: { name: 'directoryTeamIssueId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const projectDirectoryTable = new dynamodb.Table(this, 'ProjectDirectoryTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entryKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const auditEventsTable = new dynamodb.Table(this, 'AuditEventsTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'expiresAt',
    });

    for (const [id, partitionKey, sortKey] of [
      ['WorkspaceOccurredAtIndex', 'workspaceKey', 'workspaceEventKey'],
      ['EntityOccurredAtIndex', 'entityKey', 'entityEventKey'],
      ['ActorOccurredAtIndex', 'actorKey', 'actorEventKey'],
      ['TargetOccurredAtIndex', 'targetKey', 'targetEventKey'],
    ] as const) {
      auditEventsTable.addGlobalSecondaryIndex({
        indexName: id,
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    const processedAuditEventsTable = new dynamodb.Table(this, 'ProcessedAuditEventsTable', {
      partitionKey: { name: 'consumerName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const workspaceAccessTable = new dynamodb.Table(this, 'WorkspaceAccessTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const collaborationTable = new dynamodb.Table(this, 'WorkItemCollaborationTable', {
      partitionKey: { name: 'entityKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const workspaceSearchTable = new dynamodb.Table(this, 'WorkspaceSearchTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
      partitionKey: { name: 'recipientKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'notificationKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    notificationsTable.addGlobalSecondaryIndex({
      indexName: 'RecipientStatusIndex',
      partitionKey: { name: 'recipientStatusKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'notificationKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const realtimeSessionsTable = new dynamodb.Table(this, 'RealtimeSessionsTable', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    realtimeSessionsTable.addGlobalSecondaryIndex({
      indexName: 'ScopeConnectionsIndex',
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const apiFunction = new lambdaNodejs.NodejsFunction(this, 'ListProjectTasksFunction', {
      entry: path.join(__dirname, '../../server/src/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      depsLockFilePath: path.join(__dirname, '../../bun.lock'),
      projectRoot: path.join(__dirname, '../..'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      description: 'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        ALLOWED_ORIGINS: taskApiAllowedOrigins.valueAsString,
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_PROJECT_TASKS_TABLE: legacyTasksTable.tableName,
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        MUKUROJI_WORKSPACE_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
        NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
        NOTIFICATIONS_STATUS_INDEX_NAME: 'RecipientStatusIndex',
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TASKS_TABLE_NAME: legacyTasksTable.tableName,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    });

    legacyTasksTable.grantReadData(apiFunction);
    workItemsTable.grantReadWriteData(apiFunction);
    teamIssueEventsTable.grantReadWriteData(apiFunction);
    projectDirectoryTable.grantReadWriteData(apiFunction);
    auditEventsTable.grantReadWriteData(apiFunction);
    workspaceAccessTable.grantReadWriteData(apiFunction);
    collaborationTable.grantReadWriteData(apiFunction);
    notificationsTable.grantReadWriteData(apiFunction);
    workspaceSearchTable.grantReadWriteData(apiFunction);
    realtimeSessionsTable.grantWriteData(apiFunction);
    const apiTransactWritePolicy = new iam.Policy(this, 'ApiTransactWritePolicy', {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [
          workItemsTable.tableArn,
          teamIssueEventsTable.tableArn,
          projectDirectoryTable.tableArn,
          auditEventsTable.tableArn,
          workspaceAccessTable.tableArn,
          collaborationTable.tableArn,
          workspaceSearchTable.tableArn,
        ],
      })],
    });
    if (!apiFunction.role) {
      throw new Error('API Lambda execution role was not created.');
    }
    apiFunction.role.attachInlinePolicy(apiTransactWritePolicy);
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:GetUser',
          'cognito-idp:ListUsers',
        ],
        resources: [cognitoUserPoolArn],
      }),
    );

    const functionUrl = apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: taskApiAllowedOriginList,
        allowedMethods: [
          lambda.HttpMethod.GET,
          lambda.HttpMethod.POST,
          lambda.HttpMethod.PUT,
          lambda.HttpMethod.PATCH,
          lambda.HttpMethod.DELETE,
        ],
        allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
      },
    });
    const httpApi = new apigatewayv2.HttpApi(this, 'ProjectTasksHttpApi', {
      description: 'HTTP API backed by the same bundled Hono Lambda as the Function URL.',
      defaultIntegration: new apigatewayv2Integrations.HttpLambdaIntegration(
        'SharedHonoHandlerIntegration',
        apiFunction,
        {
          payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
          scopePermissionToRoute: false,
        },
      ),
      corsPreflight: {
        allowOrigins: taskApiAllowedOriginList,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
      },
    });

    const realtimeFunction = new lambdaNodejs.NodejsFunction(this, 'RealtimeHandlerFunction', {
      entry: path.join(__dirname, '../../server/src/realtime-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      depsLockFilePath: path.join(__dirname, '../../bun.lock'),
      projectRoot: path.join(__dirname, '../..'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description: 'Consumes one-time tickets and handles mukuroji WebSocket presence events.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        REALTIME_SESSION_TTL_SECONDS: '3600',
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    });
    const realtimeIntegration = new apigatewayv2Integrations.WebSocketLambdaIntegration(
      'RealtimeLambdaIntegration',
      realtimeFunction,
    );
    const realtimeWebSocketApi = new apigatewayv2.WebSocketApi(this, 'RealtimeWebSocketApi', {
      connectRouteOptions: { integration: realtimeIntegration },
      disconnectRouteOptions: { integration: realtimeIntegration },
      defaultRouteOptions: { integration: realtimeIntegration },
    });
    const realtimeWebSocketStage = new apigatewayv2.WebSocketStage(
      this,
      'RealtimeWebSocketStage',
      {
        webSocketApi: realtimeWebSocketApi,
        stageName: 'production',
        autoDeploy: true,
      },
    );

    realtimeSessionsTable.grantReadWriteData(realtimeFunction);
    projectDirectoryTable.grantReadData(realtimeFunction);
    workItemsTable.grantReadData(realtimeFunction);
    workspaceAccessTable.grantReadData(realtimeFunction);
    realtimeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [realtimeSessionsTable.tableArn],
      }),
    );
    realtimeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [cognitoUserPoolArn],
      }),
    );
    realtimeWebSocketStage.grantManagementApiAccess(realtimeFunction);

    apiFunction.addEnvironment('REALTIME_WEBSOCKET_URL', realtimeWebSocketStage.url);

    const collaborationProjectionDlq = new sqs.Queue(this, 'CollaborationProjectionDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const collaborationProjectionFunction = new lambdaNodejs.NodejsFunction(
      this,
      'CollaborationProjectionFunction',
      {
        entry: path.join(__dirname, '../../server/src/collaboration-projection-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        description: 'Projects audit outbox events into notifications and realtime invalidations.',
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          COLLABORATION_TABLE_NAME: collaborationTable.tableName,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
          NOTIFICATION_RETENTION_SECONDS: String(365 * 24 * 60 * 60),
          PROCESSED_AUDIT_EVENTS_TABLE_NAME: processedAuditEventsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
          WEBSOCKET_CALLBACK_ENDPOINT: realtimeWebSocketStage.callbackUrl,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        },
      },
    );

    collaborationProjectionFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(auditEventsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new lambdaEventSources.SqsDlq(collaborationProjectionDlq),
      }),
    );
    auditEventsTable.grantStreamRead(collaborationProjectionFunction);
    collaborationTable.grantReadData(collaborationProjectionFunction);
    notificationsTable.grantReadWriteData(collaborationProjectionFunction);
    processedAuditEventsTable.grantReadWriteData(collaborationProjectionFunction);
    projectDirectoryTable.grantReadData(collaborationProjectionFunction);
    realtimeSessionsTable.grantReadWriteData(collaborationProjectionFunction);
    workItemsTable.grantReadData(collaborationProjectionFunction);
    workspaceAccessTable.grantReadData(collaborationProjectionFunction);
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [notificationsTable.tableArn, processedAuditEventsTable.tableArn],
      }),
    );
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [cognitoUserPoolArn],
      }),
    );
    realtimeWebSocketStage.grantManagementApiAccess(collaborationProjectionFunction);

    const notificationScheduleDlq = new sqs.Queue(this, 'NotificationScheduleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const notificationScheduleFunction = new lambdaNodejs.NodejsFunction(
      this,
      'NotificationScheduleFunction',
      {
        entry: path.join(__dirname, '../../server/src/notification-schedule-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        description: 'Emits deterministic due and overdue Work Item notification events.',
        onFailure: new lambdaDestinations.SqsDestination(notificationScheduleDlq),
        retryAttempts: 2,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
          NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
          NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        },
      },
    );
    workItemsTable.grantReadData(notificationScheduleFunction);
    auditEventsTable.grantWriteData(notificationScheduleFunction);

    new cloudwatch.Alarm(this, 'NotificationScheduleDlqAlarm', {
      alarmDescription:
        'Detects notification schedule failures after asynchronous retries, including scan page limit exhaustion.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: notificationScheduleDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new events.Rule(this, 'NotificationScheduleRule', {
      description: 'Checks canonical Work Items for due and overdue notifications.',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new eventsTargets.LambdaFunction(notificationScheduleFunction)],
    });

    const cognitoPolicy = customResources.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:DescribeUserPoolClient',
        ],
        resources: [cognitoUserPoolArn],
      }),
    ]);
    const validateCognitoClientCall: customResources.AwsSdkCall = {
      service: 'CognitoIdentityServiceProvider',
      action: 'describeUserPoolClient',
      parameters: {
        UserPoolId: cognitoUserPoolId.valueAsString,
        ClientId: cognitoUserPoolClientId.valueAsString,
      },
      logging: customResources.Logging.withDataHidden(),
      physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-cognito-client-validation-v1'),
    };
    const validateCognitoClient = new customResources.AwsCustomResource(
      this,
      'ValidateCognitoUserPoolClient',
      createIdempotentAwsCustomResourceProps(validateCognitoClientCall, cognitoPolicy),
    );
    const updateInitialOwnerAttributesCall: customResources.AwsSdkCall = {
      service: 'CognitoIdentityServiceProvider',
      action: 'adminUpdateUserAttributes',
      parameters: {
        UserPoolId: cognitoUserPoolId.valueAsString,
        Username: initialOwnerUsername.valueAsString,
        UserAttributes: [
          {
            Name: 'custom:directory_id',
            Value: workspaceDirectoryId.valueAsString,
          },
          {
            Name: 'custom:workspace_id',
            Value: workspaceDirectoryId.valueAsString,
          },
        ],
      },
      logging: customResources.Logging.withDataHidden(),
      physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-initial-owner-attributes-v1'),
    };
    const updateInitialOwnerAttributes = new customResources.AwsCustomResource(
      this,
      'UpdateInitialOwnerAttributes',
      createIdempotentAwsCustomResourceProps(updateInitialOwnerAttributesCall, cognitoPolicy),
    );

    updateInitialOwnerAttributes.node.addDependency(validateCognitoClient);

    const seedCanonicalWorkItemsCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createCanonicalWorkItemTransactItems(
          workItemsTable.tableName,
          workspaceDirectoryId.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('canonical-work-items-seed-v1'),
    };
    const seedCanonicalWorkItems = new customResources.AwsCustomResource(this, 'SeedProjectTasks', {
      onCreate: seedCanonicalWorkItemsCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [workItemsTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [workItemsTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    });

    seedCanonicalWorkItems.node.addDependency(workItemsTable);

    const seedProjectDirectoryCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createProjectDirectoryTransactItems(
          projectDirectoryTable.tableName,
          workspaceDirectoryId.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('project-directory-seed-v3'),
    };
    const seedProjectDirectory = new customResources.AwsCustomResource(this, 'SeedProjectDirectory', {
      onCreate: seedProjectDirectoryCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [projectDirectoryTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [projectDirectoryTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    });

    seedProjectDirectory.node.addDependency(projectDirectoryTable);
    seedCanonicalWorkItems.node.addDependency(seedProjectDirectory);

    const seedWorkspaceAccessCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createWorkspaceAccessTransactItems(
          workspaceAccessTable.tableName,
          workspaceDirectoryId.valueAsString,
          initialOwnerEmail.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('workspace-access-seed-v2'),
    };
    const seedWorkspaceAccess = new customResources.AwsCustomResource(
      this,
      'SeedWorkspaceAccess',
      createIdempotentAwsCustomResourceProps(
        seedWorkspaceAccessCall,
        customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:TransactWriteItems'],
            resources: [workspaceAccessTable.tableArn],
          }),
          new iam.PolicyStatement({
            actions: ['dynamodb:UpdateItem'],
            resources: [workspaceAccessTable.tableArn],
            conditions: {
              'ForAnyValue:StringEquals': {
                'dynamodb:EnclosingOperation': ['TransactWriteItems'],
              },
            },
          }),
        ]),
      ),
    );
    seedWorkspaceAccess.node.addDependency(workspaceAccessTable);

    const bootstrapWorkspaceCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createWorkspaceBootstrapTransactItems(
          projectDirectoryTable.tableName,
          workspaceDirectoryId.valueAsString,
          initialOwnerEmail.valueAsString,
          initialOwnerUsername.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('workspace-bootstrap-v2'),
    };
    const bootstrapWorkspace = new customResources.AwsCustomResource(
      this,
      'BootstrapWorkspace',
      createIdempotentAwsCustomResourceProps(
        bootstrapWorkspaceCall,
        customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:TransactWriteItems'],
            resources: [projectDirectoryTable.tableArn],
          }),
          new iam.PolicyStatement({
            actions: ['dynamodb:UpdateItem'],
            resources: [projectDirectoryTable.tableArn],
            conditions: {
              'ForAnyValue:StringEquals': {
                'dynamodb:EnclosingOperation': ['TransactWriteItems'],
              },
            },
          }),
        ]),
      ),
    );

    bootstrapWorkspace.node.addDependency(seedProjectDirectory);
    bootstrapWorkspace.node.addDependency(updateInitialOwnerAttributes);

    const seedWorkspaceDemoMembersCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createWorkspaceDemoMemberTransactItems(
          workspaceAccessTable.tableName,
          workspaceDirectoryId.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of(
        'workspace-access-demo-members-seed-v2',
      ),
    };
    const seedWorkspaceDemoMembers = new customResources.AwsCustomResource(
      this,
      'SeedWorkspaceDemoMembers',
      createIdempotentAwsCustomResourceProps(
        seedWorkspaceDemoMembersCall,
        customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:TransactWriteItems'],
            resources: [workspaceAccessTable.tableArn],
          }),
          new iam.PolicyStatement({
            actions: ['dynamodb:UpdateItem'],
            resources: [workspaceAccessTable.tableArn],
            conditions: {
              'ForAnyValue:StringEquals': {
                'dynamodb:EnclosingOperation': ['TransactWriteItems'],
              },
            },
          }),
        ]),
      ),
    );

    seedWorkspaceDemoMembers.node.addDependency(seedWorkspaceAccess);

    new cdk.CfnOutput(this, 'ProjectTasksTableName', {
      value: legacyTasksTable.tableName,
    });
    new cdk.CfnOutput(this, 'ProjectDirectoryTableName', {
      value: projectDirectoryTable.tableName,
    });
    new cdk.CfnOutput(this, 'TeamIssuesTableName', {
      value: workItemsTable.tableName,
    });
    new cdk.CfnOutput(this, 'WorkItemsTableName', {
      value: workItemsTable.tableName,
    });
    new cdk.CfnOutput(this, 'TeamIssueEventsTableName', {
      value: teamIssueEventsTable.tableName,
    });
    const workspaceDirectoryIdOutput = new cdk.CfnOutput(this, 'WorkspaceDirectoryIdOutput', {
      value: workspaceDirectoryId.valueAsString,
    });
    workspaceDirectoryIdOutput.overrideLogicalId('WorkspaceDirectoryId');
    new cdk.CfnOutput(this, 'AuditEventsTableName', { value: auditEventsTable.tableName });
    new cdk.CfnOutput(this, 'AuditEventsStreamArn', { value: auditEventsTable.tableStreamArn! });
    new cdk.CfnOutput(this, 'ProcessedAuditEventsTableName', {
      value: processedAuditEventsTable.tableName,
    });
    new cdk.CfnOutput(this, 'WorkspaceAccessTableName', { value: workspaceAccessTable.tableName });
    new cdk.CfnOutput(this, 'WorkItemCollaborationTableName', {
      value: collaborationTable.tableName,
    });
    new cdk.CfnOutput(this, 'WorkspaceSearchTableName', {
      value: workspaceSearchTable.tableName,
    });
    new cdk.CfnOutput(this, 'NotificationsTableName', { value: notificationsTable.tableName });
    new cdk.CfnOutput(this, 'RealtimeSessionsTableName', {
      value: realtimeSessionsTable.tableName,
    });
    new cdk.CfnOutput(this, 'RealtimeWebSocketUrl', {
      value: realtimeWebSocketStage.url,
    });
    new cdk.CfnOutput(this, 'CollaborationProjectionDlqUrl', {
      value: collaborationProjectionDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'NotificationScheduleDlqUrl', {
      value: notificationScheduleDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'ProjectTasksApiUrl', {
      value: functionUrl.url,
      description: 'Backward-compatible alias for the Lambda Function URL.',
    });
    new cdk.CfnOutput(this, 'ProjectTasksFunctionUrl', {
      value: functionUrl.url,
    });
    new cdk.CfnOutput(this, 'ProjectTasksApiGatewayUrl', {
      value: httpApi.apiEndpoint,
    });
  }
}
