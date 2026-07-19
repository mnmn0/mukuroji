import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
  ['refero', 'wireframe', 10, '新しいランディングページのワイヤーフレーム作成', 'sato@example.com', 'in-progress', '2026/06/03', 'high'],
  ['refero', 'brand-guideline', 20, 'ブランドガイドラインの更新', 'suzuki@example.com', 'review', '2026/06/05', 'medium'],
  ['refero', 'pricing-content', 30, '料金ページのコンテンツ作成', 'tanaka@example.com', 'in-progress', '2026/06/08', 'high'],
  ['refero', 'seo-research', 40, 'SEO キーワードリサーチ', 'yamamoto@example.com', 'todo', '2026/06/09', 'medium'],
  ['refero', 'hero-design', 50, 'ヒーロー画像のデザイン作成', 'sato@example.com', 'review', '2026/06/10', 'medium'],
  ['refero', 'analytics-tags', 60, 'アナリティクスタグの実装', 'suzuki@example.com', 'in-progress', '2026/06/11', 'low'],
  ['refero', 'competitor-report', 70, '競合サイトの分析レポート作成', 'tanaka@example.com', 'done', '2026/06/02', 'low'],
  ['refero', 'terms-page', 80, '利用規約ページの作成', 'yamamoto@example.com', 'todo', '2026/06/12', 'medium'],
  ['refero', 'faq-content', 90, 'FAQ セクションのコンテンツ作成', 'sato@example.com', 'todo', '2026/06/15', 'low'],
  ['refero', 'landing-release', 100, 'ランディングページの公開', 'suzuki@example.com', 'todo', '2026/06/16', 'high'],
] as const;

/**
 * Built-in workflow status ID に対応する canonical category です。
 */
const canonicalWorkflowStatusCategories = {
  todo: 'unstarted',
  'in-progress': 'started',
  review: 'started',
  done: 'completed',
} as const;

/**
 * Canonical Work Item seed に使用する決定的な timestamp です。
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
 * KMS grant を developer platform の envelope encryption context に限定します。
 */
function restrictKmsGrantToDeveloperPlatformPurpose(
  grant: iam.Grant,
  purpose: 'connector' | 'platform-state' | 'webhook',
) {
  for (const statement of [
    ...grant.principalStatements,
    ...grant.resourceStatements,
  ]) {
    statement.addConditions({
      StringEquals: {
        'kms:EncryptionContext:mukuroji:purpose': purpose,
        'kms:EncryptionContext:mukuroji:service': 'developer-platform',
      },
    });
  }
}

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
 * Demo Team の authoritative base-table sort key を返します。
 */
function findProjectDirectoryTeamEntryKey(teamId: string) {
  const team = projectDirectoryItems.find((entry) =>
    entry.entryType === 'team' && entry.teamId === teamId
  );
  if (!team) {
    throw new Error(`Project directory Team "${teamId}" was not found.`);
  }
  return team.entryKey;
}

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
 * Team-only Webhook ACL を直接引く materialized grant の Put を作成します。
 */
function createWebhookTeamGrantPuts(
  tableName: string,
  workspaceId: string,
  teamId: string,
  projectId: string,
  memberKey: string,
  teamSourceEntryKey: string,
  projectSourceEntryKey: string,
) {
  return [
    {
      Put: {
        TableName: tableName,
        Item: {
          directoryId: { S: `WEBHOOK_TEAM_GRANT#${workspaceId}#${memberKey}` },
          entryKey: { S: `TEAM#${teamId}#PROJECT#${projectId}` },
          entryType: { S: 'webhook-team-grant' },
          workspaceId: { S: workspaceId },
          teamId: { S: teamId },
          projectId: { S: projectId },
          memberKey: { S: memberKey },
          sourceEntryKey: {
            S: createProjectMemberEntryKey(projectId, memberKey),
          },
          teamSourceEntryKey: { S: teamSourceEntryKey },
          projectSourceEntryKey: { S: projectSourceEntryKey },
          webhookAuthorizationKey: {
            S: `WEBHOOK_ACL#TEAM_MEMBER#${workspaceId}#${teamId}#${memberKey}`,
          },
          webhookAuthorizationSortKey: { S: `PROJECT#${projectId}` },
        },
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          directoryId: {
            S: `WEBHOOK_GRANT_CLEANUP#${workspaceId}#${teamId}`,
          },
          entryKey: { S: `PROJECT#${projectId}#MEMBER#${memberKey}` },
          entryType: { S: 'webhook-team-grant-cleanup' },
          workspaceId: { S: workspaceId },
          teamId: { S: teamId },
          projectId: { S: projectId },
          memberKey: { S: memberKey },
          grantDirectoryId: {
            S: `WEBHOOK_TEAM_GRANT#${workspaceId}#${memberKey}`,
          },
          grantEntryKey: { S: `TEAM#${teamId}#PROJECT#${projectId}` },
        },
      },
    },
  ];
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
    title,
    assigneeUserId,
    workflowStatusId,
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
          schemaVersion: { N: '1' },
          revision: { N: '1' },
          sortOrder: { N: String(sortOrder) },
          title: { S: title },
          assigneeUserId: { S: assigneeUserId },
          creatorMemberKey: { S: assigneeUserId },
          workflowSchemaVersion: { N: '1' },
          workflowStatusId: { S: workflowStatusId },
          statusCategory: { S: canonicalWorkflowStatusCategories[workflowStatusId] },
          customFieldValues: { M: {} },
          relationIds: { L: [] },
          dueDate: { S: dueDate },
          priority: { S: priority },
          createdAt: { S: canonicalWorkItemSeedTimestamp },
          updatedAt: { S: canonicalWorkItemSeedTimestamp },
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
        webhookAuthorizationKey: { S: `WEBHOOK_ACL#RESOURCE#${directoryId}` },
        webhookAuthorizationSortKey: {
          S: entry.entryType === 'team'
            ? `TEAM#${entry.teamId}`
            : `PROJECT#${entry.projectId}`,
        },
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
        webhookAuthorizationKey: {
          S: `WEBHOOK_ACL#MEMBER#${directoryId}#${memberKey}`,
        },
        webhookAuthorizationSortKey: { S: `PROJECT#${projectId}` },
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
  const teamGrantItems = projectMemberItems.flatMap(([projectId, memberKey]) =>
    projectDirectoryItems
      .filter((entry) =>
        entry.entryType === 'project' && entry.projectId === projectId
      )
      .flatMap((entry) =>
        createWebhookTeamGrantPuts(
          tableName,
          directoryId,
          entry.teamId,
          projectId,
          memberKey,
          findProjectDirectoryTeamEntryKey(entry.teamId),
          entry.entryKey,
        )
      )
  );

  return [...directoryItems, ...memberItems, ...teamGrantItems];
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
        'SET #entryType = if_not_exists(#entryType, :entryType), projectId = if_not_exists(projectId, :projectId), memberKey = if_not_exists(memberKey, :memberKey), webhookAuthorizationKey = :webhookAuthorizationKey, webhookAuthorizationSortKey = :webhookAuthorizationSortKey, email = :email, #role = if_not_exists(#role, :role), createdAt = if_not_exists(createdAt, :timestamp), updatedAt = if_not_exists(updatedAt, :timestamp)',
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
        ':webhookAuthorizationKey': {
          S: `WEBHOOK_ACL#MEMBER#${directoryId}#${initialOwnerEmail}`,
        },
        ':webhookAuthorizationSortKey': { S: `PROJECT#${projectId}` },
        ':email': { S: initialOwnerEmail },
        ':role': { S: 'manager' },
        ':timestamp': { S: workspaceBootstrapTimestamp },
      },
    },
  }));
  const ownerTeamGrantItems = ownerProjectIds.flatMap((projectId) =>
    projectDirectoryItems
      .filter((entry) =>
        entry.entryType === 'project' && entry.projectId === projectId
      )
      .flatMap((entry) =>
        createWebhookTeamGrantPuts(
          tableName,
          directoryId,
          entry.teamId,
          projectId,
          initialOwnerEmail,
          findProjectDirectoryTeamEntryKey(entry.teamId),
          entry.entryKey,
        )
      )
  );

  return [
    workspaceMetadataItem,
    workspaceOwnerItem,
    emailAliasItem,
    ...ownerProjectMemberItems,
    ...ownerTeamGrantItems,
  ];
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
    const taskApiExposedHeaders = [
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
    const automationWebhookSecretPrefix = 'mukuroji/automation-webhooks';
    const automationWebhookSecretArn = this.formatArn({
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: `${automationWebhookSecretPrefix}/*`,
    });
    const automationInboundWebhookSecretPrefix = 'mukuroji/automation-inbound-webhooks';
    const automationInboundWebhookSecretArn = this.formatArn({
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: `${automationInboundWebhookSecretPrefix}/*`,
    });
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
    const connectorRuntimeConfiguration = new cdk.CfnParameter(
      this,
      'ConnectorRuntimeConfiguration',
      {
        type: 'String',
        default: '{}',
        noEcho: true,
        description:
          'Secret JSON object whose string properties are loaded as connector runtime environment variables.',
      },
    );
    const workspaceAuditPseudonymKey = new cdk.CfnParameter(
      this,
      'WorkspaceAuditPseudonymKey',
      {
        type: 'String',
        noEcho: true,
        allowedPattern: '^[0-9a-f]{64}$',
        constraintDescription:
          'WorkspaceAuditPseudonymKey must be exactly 64 lowercase hexadecimal characters.',
        description:
          'Stable 32-byte random HMAC key encoded as lowercase hexadecimal for non-PII Workspace member and invitation audit identifiers.',
      },
    );
    const requestRateLimitPerHour = new cdk.CfnParameter(this, 'RequestRateLimitPerHour', {
      type: 'Number',
      default: 10,
      minValue: 1,
      maxValue: 10_000,
      description: 'Maximum anonymous request submissions accepted per capability and hour.',
    });
    const requestEmailWebhookSecret = new cdk.CfnParameter(this, 'RequestEmailWebhookSecret', {
      type: 'String',
      minLength: 32,
      maxLength: 256,
      noEcho: true,
      description: 'Secret used to authenticate request intake email envelopes.',
    });
    const requestTokenHashSecret = new cdk.CfnParameter(this, 'RequestTokenHashSecret', {
      type: 'String',
      minLength: 32,
      maxLength: 256,
      noEcho: true,
      description: 'Secret used to hash public request and reply capability tokens.',
    });
    const fileRetentionDays = new cdk.CfnParameter(this, 'FileRetentionDays', {
      type: 'Number',
      default: 30,
      minValue: 1,
      description:
        'Number of days deleted file metadata and noncurrent S3 object versions are retained.',
    });
    const fileUploadUrlTtlSeconds = new cdk.CfnParameter(this, 'FileUploadUrlTtlSeconds', {
      type: 'Number',
      default: 600,
      minValue: 60,
      maxValue: 3600,
      description: 'Lifetime in seconds for direct-to-S3 upload URLs.',
    });
    const fileDownloadUrlTtlSeconds = new cdk.CfnParameter(this, 'FileDownloadUrlTtlSeconds', {
      type: 'Number',
      default: 300,
      minValue: 60,
      maxValue: 3600,
      description: 'Lifetime in seconds for clean-file download URLs.',
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
      indexName: 'TeamIssueUpdatedAtIndex',
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    workItemsTable.addGlobalSecondaryIndex({
      indexName: 'AssignedProjectIssueIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const workItemConfigurationTable = new dynamodb.Table(this, 'WorkItemConfigurationTable', {
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAtEpochSeconds',
    });

    const automationTable = new dynamodb.Table(this, 'AutomationTable', {
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    automationTable.addGlobalSecondaryIndex({
      indexName: 'ScheduleDueIndex',
      partitionKey: { name: 'scheduleShard', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'nextRunAtRecordKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    automationTable.addGlobalSecondaryIndex({
      indexName: 'RuleExecutionIndex',
      partitionKey: { name: 'ruleExecutionKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAtExecutionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    automationTable.addGlobalSecondaryIndex({
      indexName: 'WorkspaceExecutionIndex',
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAtExecutionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const planningTable = new dynamodb.Table(this, 'PlanningTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const developerPlatformTable = new dynamodb.Table(this, 'DeveloperPlatformTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    analyticsTable.addGlobalSecondaryIndex({
      indexName: 'ScheduleDueIndex',
      partitionKey: { name: 'scheduleShard', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'nextDeliveryAtRecordKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    const requestIntakeTable = new dynamodb.Table(this, 'RequestIntakeTable', {
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    developerPlatformTable.addGlobalSecondaryIndex({
      indexName: 'LookupKeyIndex',
      partitionKey: { name: 'lookupKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lookupSortKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    const developerPlatformWebhookKey = new kms.Key(
      this,
      'DeveloperPlatformWebhookKey',
      {
        description: 'Envelope key for developer platform Webhook signing secrets.',
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const developerPlatformConnectorKey = new kms.Key(
      this,
      'DeveloperPlatformConnectorKey',
      {
        description: 'Envelope key for developer platform connector credentials.',
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const developerPlatformStateKey = new kms.Key(
      this,
      'DeveloperPlatformStateKey',
      {
        description: 'Envelope key for developer platform cursors and idempotency state.',
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const connectorRuntimeConfigurationKey = new kms.Key(
      this,
      'ConnectorRuntimeConfigurationKey',
      {
        description: 'Encryption key for connector provider runtime configuration.',
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const connectorRuntimeSecret = new secretsmanager.Secret(
      this,
      'ConnectorRuntimeSecret',
      {
        description:
          'Provider configuration and signing secrets loaded only by connector runtimes.',
        encryptionKey: connectorRuntimeConfigurationKey,
        secretStringValue: cdk.SecretValue.cfnParameter(connectorRuntimeConfiguration),
      },
    );
    connectorRuntimeSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    requestIntakeTable.addGlobalSecondaryIndex({
      indexName: 'RequestQueueIndex',
      partitionKey: { name: 'queueKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'queueRecordKey', type: dynamodb.AttributeType.STRING },
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
    projectDirectoryTable.addGlobalSecondaryIndex({
      indexName: 'WebhookAuthorizationIndex',
      partitionKey: {
        name: 'webhookAuthorizationKey',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'webhookAuthorizationSortKey',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
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

    const documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAtEpoch',
    });
    const documentPublicShareTokenSecret = new secretsmanager.Secret(
      this,
      'DocumentPublicShareTokenSecret',
      {
        description:
          'Server-only HMAC key for idempotent mukuroji public document links.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
      },
    );
    documentPublicShareTokenSecret.applyRemovalPolicy(
      cdk.RemovalPolicy.RETAIN,
    );

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

    const fileProofingTable = new dynamodb.Table(this, 'FileProofingTable', {
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const fileBucket = new s3.Bucket(this, 'FileBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [{
        allowedHeaders: [
          'content-length',
          'content-type',
          'if-none-match',
          'x-amz-checksum-*',
          'x-amz-meta-*',
          'x-amz-server-side-encryption',
          'x-amz-tagging',
        ],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
        allowedOrigins: taskApiAllowedOriginList,
        exposedHeaders: ['ETag', 'x-amz-checksum-sha256', 'x-amz-version-id'],
        maxAge: 600,
      }],
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      eventBridgeEnabled: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
          id: 'AbortIncompleteUploads',
        },
        {
          expiration: cdk.Duration.days(1),
          id: 'ExpireAbandonedUploads',
          tagFilters: { 'mukuroji-upload': 'pending' },
        },
        {
          expiration: cdk.Duration.days(1),
          id: 'ExpireDeletedCurrentObjects',
          tagFilters: { 'mukuroji-deleted': 'true' },
        },
        {
          id: 'ExpireDeletedFileVersions',
          noncurrentVersionExpiration: cdk.Duration.days(fileRetentionDays.valueAsNumber),
        },
        {
          expiredObjectDeleteMarker: true,
          id: 'DeleteExpiredMarkers',
        },
      ],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    });

    const workItemImportAccessLogsBucket = new s3.Bucket(
      this,
      'WorkItemImportAccessLogsBucket',
      {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        lifecycleRules: [{
          expiration: cdk.Duration.days(90),
          id: 'ExpireImportAccessLogs',
          noncurrentVersionExpiration: cdk.Duration.days(90),
        }],
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        versioned: true,
      },
    );
    const workItemImportBucket = new s3.Bucket(this, 'WorkItemImportBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
          id: 'AbortIncompleteImportSources',
        },
        {
          expiration: cdk.Duration.days(15),
          id: 'ExpireImportSources',
          noncurrentVersionExpiration: cdk.Duration.days(15),
        },
        {
          expiredObjectDeleteMarker: true,
          id: 'DeleteExpiredImportSourceMarkers',
        },
      ],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: workItemImportAccessLogsBucket,
      serverAccessLogsPrefix: 'work-item-import/',
      versioned: true,
    });

    const malwareProtectionRole = new iam.Role(this, 'FileMalwareProtectionRole', {
      assumedBy: new iam.ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com'),
      description: 'Allows GuardDuty Malware Protection to scan and tag mukuroji files.',
    });
    const guardDutyManagedRuleArn = cdk.Stack.of(this).formatArn({
      service: 'events',
      resource: 'rule',
      resourceName: 'DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*',
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const malwareProtectionPolicy = new iam.Policy(this, 'FileMalwareProtectionPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['events:DeleteRule', 'events:PutRule', 'events:PutTargets', 'events:RemoveTargets'],
          resources: [guardDutyManagedRuleArn],
          conditions: {
            StringLike: {
              'events:ManagedBy': 'malware-protection-plan.guardduty.amazonaws.com',
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
          resources: [guardDutyManagedRuleArn],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:GetObjectTagging',
            's3:GetObjectVersionTagging',
            's3:PutObjectTagging',
            's3:PutObjectVersionTagging',
          ],
          resources: [
            fileBucket.arnForObjects('malware-protection-resource-validation-object'),
            fileBucket.arnForObjects('workspaces/*'),
          ],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetBucketNotification', 's3:PutBucketNotification'],
          resources: [fileBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [fileBucket.arnForObjects('malware-protection-resource-validation-object')],
        }),
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [fileBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetObjectVersion'],
          resources: [
            fileBucket.arnForObjects('malware-protection-resource-validation-object'),
            fileBucket.arnForObjects('workspaces/*'),
          ],
        }),
      ],
    });
    malwareProtectionRole.attachInlinePolicy(malwareProtectionPolicy);

    const malwareProtectionPlan = new guardduty.CfnMalwareProtectionPlan(
      this,
      'FileMalwareProtectionPlan',
      {
        actions: {
          tagging: {
            status: 'ENABLED',
          },
        },
        protectedResource: {
          s3Bucket: {
            bucketName: fileBucket.bucketName,
            objectPrefixes: ['workspaces/'],
          },
        },
        role: malwareProtectionRole.roleArn,
      },
    );
    malwareProtectionPlan.node.addDependency(fileBucket);
    malwareProtectionPlan.node.addDependency(malwareProtectionPolicy);

    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyGuardDutyCanUploadScanStatus',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        ArnNotEquals: {
          'aws:PrincipalArn': malwareProtectionRole.roleArn,
        },
        'ForAnyValue:StringEquals': {
          's3:RequestObjectTagKeys': 'GuardDutyMalwareScanStatus',
        },
      },
    }));
    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyGuardDutyCanSetScanStatus',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        ArnNotEquals: {
          'aws:PrincipalArn': malwareProtectionRole.roleArn,
        },
        Null: {
          's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'true',
          's3:RequestObjectTag/GuardDutyMalwareScanStatus': 'false',
        },
      },
    }));
    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'GuardDutyScanStatusCannotBeChanged',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        ArnNotEquals: {
          'aws:PrincipalArn': malwareProtectionRole.roleArn,
        },
        Null: {
          's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'false',
        },
        StringNotEquals: {
          's3:RequestObjectTag/GuardDutyMalwareScanStatus':
            '${s3:ExistingObjectTag/GuardDutyMalwareScanStatus}',
        },
      },
    }));
    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'RejectStalePresignedFileUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        NumericGreaterThan: {
          's3:signatureAge': cdk.Fn.join('', [fileUploadUrlTtlSeconds.valueAsString, '000']),
        },
      },
    }));
    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'RejectStalePresignedFileDownloads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        NumericGreaterThan: {
          's3:signatureAge': cdk.Fn.join('', [fileDownloadUrlTtlSeconds.valueAsString, '000']),
        },
      },
    }));

    realtimeSessionsTable.addGlobalSecondaryIndex({
      indexName: 'ScopeConnectionsIndex',
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const webhookDeliveryDlq = new sqs.Queue(this, 'WebhookDeliveryDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    });
    const webhookDeliveryQueue = new sqs.Queue(this, 'WebhookDeliveryQueue', {
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: webhookDeliveryDlq,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(3),
    });
    const workItemImportDlq = new sqs.Queue(this, 'WorkItemImportDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    });
    const workItemImportQueue = new sqs.Queue(this, 'WorkItemImportQueue', {
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: workItemImportDlq,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(90),
    });
    const connectorSyncDlq = new sqs.Queue(this, 'ConnectorSyncDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    });
    const connectorPollDlq = new sqs.Queue(this, 'ConnectorPollDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    });
    const connectorSyncQueue = new sqs.Queue(this, 'ConnectorSyncQueue', {
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: connectorSyncDlq,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(30),
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
        ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
        ANALYTICS_TABLE_NAME: analyticsTable.tableName,
        AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: automationInboundWebhookSecretPrefix,
        AUTOMATION_TABLE_NAME: automationTable.tableName,
        AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET:
          documentPublicShareTokenSecret.secretValue.unsafeUnwrap(),
        COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN:
          connectorRuntimeSecret.secretArn,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID:
          developerPlatformConnectorKey.keyArn,
        DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
        DEVELOPER_PLATFORM_STATE_KMS_KEY_ID:
          developerPlatformStateKey.keyArn,
        DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
        DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID:
          developerPlatformWebhookKey.keyArn,
        FILE_BUCKET_NAME: fileBucket.bucketName,
        FILE_DOWNLOAD_URL_TTL_SECONDS: fileDownloadUrlTtlSeconds.valueAsString,
        FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
        FILE_RETENTION_DAYS: fileRetentionDays.valueAsString,
        FILE_UPLOAD_URL_TTL_SECONDS: fileUploadUrlTtlSeconds.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_PROJECT_TASKS_TABLE: legacyTasksTable.tableName,
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
        MUKUROJI_DOCUMENTS_TABLE: documentsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        MUKUROJI_WORKSPACE_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
        MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:
          workspaceAuditPseudonymKey.valueAsString,
        NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
        NOTIFICATIONS_STATUS_INDEX_NAME: 'RecipientStatusIndex',
        PLANNING_TABLE_NAME: planningTable.tableName,
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
        REQUEST_QUEUE_INDEX_NAME: 'RequestQueueIndex',
        REQUEST_RATE_LIMIT_PER_HOUR: requestRateLimitPerHour.valueAsString,
        REQUEST_TOKEN_HASH_SECRET: requestTokenHashSecret.valueAsString,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TASKS_TABLE_NAME: legacyTasksTable.tableName,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
        WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
        WORK_ITEM_IMPORT_BUCKET_NAME: workItemImportBucket.bucketName,
        WORK_ITEM_IMPORT_QUEUE_URL: workItemImportQueue.queueUrl,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    });

    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'NoReadUnlessGuardDutyClean',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        ArnNotEquals: {
          'aws:PrincipalArn': [malwareProtectionRole.roleArn, apiFunction.role!.roleArn],
        },
        StringNotEquals: {
          's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'NO_THREATS_FOUND',
        },
      },
    }));
    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DeletedObjectsCannotBeRead',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        StringEquals: {
          's3:ExistingObjectTag/mukuroji-deleted': 'true',
        },
      },
    }));
    fileBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DeletedObjectQuarantineCannotBeRemoved',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
      resources: [fileBucket.arnForObjects('workspaces/*')],
      conditions: {
        StringEquals: {
          's3:ExistingObjectTag/mukuroji-deleted': 'true',
        },
        StringNotEquals: {
          's3:RequestObjectTag/mukuroji-deleted': 'true',
        },
      },
    }));

    legacyTasksTable.grants.readData(apiFunction);
    workItemsTable.grants.readWriteData(apiFunction);
    teamIssueEventsTable.grants.readWriteData(apiFunction);
    projectDirectoryTable.grants.readWriteData(apiFunction);
    auditEventsTable.grants.readWriteData(apiFunction);
    workspaceAccessTable.grants.readWriteData(apiFunction);
    documentsTable.grants.readWriteData(apiFunction);
    collaborationTable.grants.readWriteData(apiFunction);
    fileProofingTable.grants.readWriteData(apiFunction);
    notificationsTable.grants.readWriteData(apiFunction);
    workspaceSearchTable.grants.readWriteData(apiFunction);
    realtimeSessionsTable.grants.writeData(apiFunction);
    const apiAutomationDataPolicy = new iam.Policy(
      this,
      'ApiAutomationDataPolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: [
            'dynamodb:ConditionCheckItem',
            'dynamodb:DeleteItem',
            'dynamodb:DescribeTable',
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:Query',
            'dynamodb:Scan',
            'dynamodb:UpdateItem',
          ],
          resources: [automationTable.tableArn, `${automationTable.tableArn}/index/*`],
        })],
      },
    );
    const apiWorkItemConfigurationDataPolicy = new iam.Policy(
      this,
      'ApiWorkItemConfigurationDataPolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: [
            'dynamodb:ConditionCheckItem',
            'dynamodb:DeleteItem',
            'dynamodb:DescribeTable',
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:Query',
            'dynamodb:UpdateItem',
          ],
          resources: [workItemConfigurationTable.tableArn],
        })],
      },
    );
    const apiRequestIntakeDataPolicy = new iam.Policy(this, 'ApiRequestIntakeDataPolicy', {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [requestIntakeTable.tableArn, `${requestIntakeTable.tableArn}/index/*`],
      })],
    });
    const apiTransactWritePolicy = new iam.Policy(this, 'ApiTransactWritePolicy', {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [
          automationTable.tableArn,
          workItemsTable.tableArn,
          workItemConfigurationTable.tableArn,
          planningTable.tableArn,
          teamIssueEventsTable.tableArn,
          projectDirectoryTable.tableArn,
          auditEventsTable.tableArn,
          workspaceAccessTable.tableArn,
          collaborationTable.tableArn,
          fileProofingTable.tableArn,
          workspaceSearchTable.tableArn,
          analyticsTable.tableArn,
        ],
      })],
    });
    const apiDeveloperPlatformDataPolicy = new iam.Policy(
      this,
      'ApiDeveloperPlatformDataPolicy',
      {
        statements: [
          new iam.PolicyStatement({
            actions: [
              'dynamodb:ConditionCheckItem',
              'dynamodb:DeleteItem',
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:Query',
              'dynamodb:UpdateItem',
            ],
            resources: [developerPlatformTable.tableArn],
          }),
          new iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [
              `${developerPlatformTable.tableArn}/index/LookupKeyIndex`,
            ],
          }),
          new iam.PolicyStatement({
            actions: ['sqs:SendMessage'],
            resources: [
              webhookDeliveryQueue.queueArn,
              workItemImportQueue.queueArn,
            ],
          }),
        ],
      },
    );
    if (!apiFunction.role) {
      throw new Error('API Lambda execution role was not created.');
    }
    apiFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'ApiDeveloperPlatformKmsPolicy',
      {
        statements: [
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resources: [developerPlatformWebhookKey.keyArn],
            conditions: {
              StringEquals: {
                'kms:EncryptionContext:mukuroji:purpose': 'webhook',
                'kms:EncryptionContext:mukuroji:service':
                  'developer-platform',
              },
            },
          }),
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resources: [developerPlatformConnectorKey.keyArn],
            conditions: {
              StringEquals: {
                'kms:EncryptionContext:mukuroji:purpose': 'connector',
                'kms:EncryptionContext:mukuroji:service':
                  'developer-platform',
              },
            },
          }),
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resources: [developerPlatformStateKey.keyArn],
            conditions: {
              StringEquals: {
                'kms:EncryptionContext:mukuroji:purpose': 'platform-state',
                'kms:EncryptionContext:mukuroji:service':
                  'developer-platform',
              },
            },
          }),
        ],
      },
    ));
    const apiPlanningDataPolicy = new iam.Policy(this, 'ApiPlanningDataPolicy', {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:ConditionCheckItem',
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [planningTable.tableArn],
      })],
    });
    const apiAnalyticsDataPolicy = new iam.Policy(this, 'ApiAnalyticsDataPolicy', {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [analyticsTable.tableArn],
      })],
    });
    apiFunction.role.attachInlinePolicy(apiAutomationDataPolicy);
    apiFunction.role.attachInlinePolicy(apiWorkItemConfigurationDataPolicy);
    apiFunction.role.attachInlinePolicy(apiDeveloperPlatformDataPolicy);
    apiFunction.role.attachInlinePolicy(apiPlanningDataPolicy);
    apiFunction.role.attachInlinePolicy(apiAnalyticsDataPolicy);
    apiFunction.role.attachInlinePolicy(apiRequestIntakeDataPolicy);
    apiFunction.role.attachInlinePolicy(apiTransactWritePolicy);
    connectorRuntimeSecret.grantRead(apiFunction);
    apiFunction.role.attachInlinePolicy(new iam.Policy(this, 'ApiAutomationWebhookSecretPolicy', {
      statements: [new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [automationWebhookSecretArn],
      })],
    }));
    apiFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'ApiAutomationInboundWebhookSecretPolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:DeleteSecret',
            'secretsmanager:DescribeSecret',
            'secretsmanager:GetSecretValue',
            'secretsmanager:PutSecretValue',
          ],
          resources: [automationInboundWebhookSecretArn],
        })],
      },
    ));
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectAttributes',
          's3:GetObjectVersion',
          's3:GetObjectVersionTagging',
          's3:PutObject',
          's3:PutObjectVersionTagging',
        ],
        resources: [fileBucket.arnForObjects('workspaces/*')],
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3:DeleteObjectVersion',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        resources: [workItemImportBucket.arnForObjects('work-item-imports/*')],
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDeleteUserAttributes',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:GetUser',
          'cognito-idp:ListUsers',
        ],
        resources: [cognitoUserPoolArn],
      }),
    );

    const workItemImportLogGroup = new logs.LogGroup(
      this,
      'WorkItemImportLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const workItemImportFunction = new lambdaNodejs.NodejsFunction(
      this,
      'WorkItemImportFunction',
      {
        entry: path.join(__dirname, '../../server/src/index.ts'),
        handler: 'workItemImportHandler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(15),
        memorySize: 1024,
        description: 'Processes durable Work Item imports with resumable row receipts.',
        logGroup: workItemImportLogGroup,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
          MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
          MUKUROJI_RUNTIME_ROLE: 'work-item-import-worker',
          MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
          MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
            'WebhookAuthorizationIndex',
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
          WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
          WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
          WORK_ITEM_IMPORT_BUCKET_NAME: workItemImportBucket.bucketName,
          WORK_ITEM_IMPORT_QUEUE_URL: workItemImportQueue.queueUrl,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        },
      },
    );
    workItemImportFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(workItemImportQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    workItemImportQueue.grants.consumeMessages(workItemImportFunction);
    developerPlatformTable.grants.readWriteData(workItemImportFunction);
    workItemsTable.grants.readWriteData(workItemImportFunction);
    teamIssueEventsTable.grants.readWriteData(workItemImportFunction);
    auditEventsTable.grants.readWriteData(workItemImportFunction);
    projectDirectoryTable.grants.readData(workItemImportFunction);
    workspaceAccessTable.grants.readData(workItemImportFunction);
    workItemConfigurationTable.grants.readData(workItemImportFunction);
    workspaceSearchTable.grants.readWriteData(workItemImportFunction);
    workItemImportFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:DeleteObjectVersion',
        's3:GetObject',
        's3:GetObjectVersion',
      ],
      resources: [workItemImportBucket.arnForObjects('work-item-imports/*')],
    }));
    workItemImportFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
      ],
      resources: [cognitoUserPoolArn],
    }));

    new cloudwatch.Alarm(this, 'WorkItemImportDlqAlarm', {
      alarmDescription: 'Detects Work Item imports that exhausted resumable queue attempts.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workItemImportDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

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
        allowedHeaders: [
          'authorization',
          'content-type',
          'idempotency-key',
          'x-correlation-id',
          'x-request-id',
        ],
        exposedHeaders: taskApiExposedHeaders,
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
        allowHeaders: [
          'authorization',
          'content-type',
          'idempotency-key',
          'x-correlation-id',
          'x-request-id',
        ],
        exposeHeaders: taskApiExposedHeaders,
      },
    });
    apiFunction.addEnvironment('AUTOMATION_INBOUND_WEBHOOK_BASE_URL', httpApi.apiEndpoint);

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

    realtimeSessionsTable.grants.readWriteData(realtimeFunction);
    projectDirectoryTable.grants.readData(realtimeFunction);
    workItemsTable.grants.readData(realtimeFunction);
    workspaceAccessTable.grants.readData(realtimeFunction);
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
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const collaborationProjectionFunction = new lambdaNodejs.NodejsFunction(
      this,
      'CollaborationProjectionFunction',
      {
        entry: path.join(__dirname, '../../server/src/audit-projection-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        description:
          'Projects audit outbox events into collaboration, Webhook, and connector deliveries.',
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          COLLABORATION_TABLE_NAME: collaborationTable.tableName,
          CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          FILE_BUCKET_NAME: fileBucket.bucketName,
          FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
          NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
          NOTIFICATION_RETENTION_SECONDS: String(365 * 24 * 60 * 60),
          PROCESSED_AUDIT_EVENTS_TABLE_NAME: processedAuditEventsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
            'WebhookAuthorizationIndex',
          REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_RUNTIME_ROLE: 'audit-projection',
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
          WEBSOCKET_CALLBACK_ENDPOINT: realtimeWebSocketStage.callbackUrl,
          WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
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
    new cloudwatch.Alarm(this, 'CollaborationProjectionDlqAlarm', {
      alarmDescription:
        'Detects audit projection records that exhausted collaboration, Webhook, or connector stream retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: collaborationProjectionDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    auditEventsTable.grantStreamRead(collaborationProjectionFunction);
    collaborationTable.grants.readData(collaborationProjectionFunction);
    notificationsTable.grants.readWriteData(collaborationProjectionFunction);
    processedAuditEventsTable.grants.readWriteData(collaborationProjectionFunction);
    projectDirectoryTable.grants.readData(collaborationProjectionFunction);
    realtimeSessionsTable.grants.readWriteData(collaborationProjectionFunction);
    workItemsTable.grants.readData(collaborationProjectionFunction);
    workspaceAccessTable.grants.readData(collaborationProjectionFunction);
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [fileProofingTable.tableArn],
      }),
    );
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [fileProofingTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': ['scopeKey', 'recordKey', 'expiresAt', 'retentionUntil'],
          },
        },
      }),
    );
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObjectVersionTagging'],
        resources: [fileBucket.arnForObjects('workspaces/*')],
      }),
    );
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObjectVersionTagging'],
        resources: [fileBucket.arnForObjects('workspaces/*')],
        conditions: {
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
      }),
    );
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
    connectorSyncQueue.grants.sendMessages(collaborationProjectionFunction);
    webhookDeliveryQueue.grants.sendMessages(collaborationProjectionFunction);
    realtimeWebSocketStage.grantManagementApiAccess(collaborationProjectionFunction);

    const automationEventDlq = new sqs.Queue(this, 'AutomationEventDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const automationEventFunction = new lambdaNodejs.NodejsFunction(
      this,
      'AutomationEventFunction',
      {
        entry: path.join(__dirname, '../../server/src/automation-event-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        description: 'Executes versioned automation rules from durable audit outbox events.',
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUTOMATION_TABLE_NAME: automationTable.tableName,
          AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
          COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
          MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
          MUKUROJI_RUNTIME_ROLE: 'automation-event-worker',
          MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
          WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
        },
      },
    );
    automationEventFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(auditEventsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new lambdaEventSources.SqsDlq(automationEventDlq),
      }),
    );
    auditEventsTable.grantStreamRead(automationEventFunction);
    automationTable.grants.readWriteData(automationEventFunction);
    auditEventsTable.grants.readWriteData(automationEventFunction);
    fileProofingTable.grants.readWriteData(automationEventFunction);
    projectDirectoryTable.grants.readData(automationEventFunction);
    teamIssueEventsTable.grants.readWriteData(automationEventFunction);
    workItemsTable.grants.readWriteData(automationEventFunction);
    workspaceSearchTable.grants.readWriteData(automationEventFunction);
    workItemConfigurationTable.grants.readData(automationEventFunction);
    workspaceAccessTable.grants.readData(automationEventFunction);
    if (!automationEventFunction.role) {
      throw new Error('Automation event Lambda execution role was not created.');
    }
    automationEventFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'AutomationEventTransactWritePolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [
            automationTable.tableArn,
            auditEventsTable.tableArn,
            fileProofingTable.tableArn,
            teamIssueEventsTable.tableArn,
            workItemConfigurationTable.tableArn,
            workItemsTable.tableArn,
          ],
        })],
      },
    ));
    automationEventFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
      ],
      resources: [cognitoUserPoolArn],
    }));
    automationEventFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'AutomationEventWebhookSecretPolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [automationWebhookSecretArn],
        })],
      },
    ));

    new cloudwatch.Alarm(this, 'AutomationEventDlqAlarm', {
      alarmDescription: 'Detects automation outbox records that exhausted stream retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: automationEventDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const automationScheduleDlq = new sqs.Queue(this, 'AutomationScheduleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const automationScheduleFunction = new lambdaNodejs.NodejsFunction(
      this,
      'AutomationScheduleFunction',
      {
        entry: path.join(__dirname, '../../server/src/automation-schedule-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        description: 'Materializes timezone-aware recurring Work Items with durable receipts.',
        onFailure: new lambdaDestinations.SqsDestination(automationScheduleDlq),
        retryAttempts: 2,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: automationInboundWebhookSecretPrefix,
          AUTOMATION_TABLE_NAME: automationTable.tableName,
          AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
          COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
          MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
          MUKUROJI_RUNTIME_ROLE: 'automation-schedule-worker',
          MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
          WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
        },
      },
    );
    automationTable.grants.readWriteData(automationScheduleFunction);
    auditEventsTable.grants.readWriteData(automationScheduleFunction);
    fileProofingTable.grants.readWriteData(automationScheduleFunction);
    projectDirectoryTable.grants.readData(automationScheduleFunction);
    teamIssueEventsTable.grants.readWriteData(automationScheduleFunction);
    workItemsTable.grants.readWriteData(automationScheduleFunction);
    workspaceSearchTable.grants.readWriteData(automationScheduleFunction);
    workItemConfigurationTable.grants.readData(automationScheduleFunction);
    workspaceAccessTable.grants.readData(automationScheduleFunction);
    if (!automationScheduleFunction.role) {
      throw new Error('Automation schedule Lambda execution role was not created.');
    }
    automationScheduleFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'AutomationScheduleTransactWritePolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [
            automationTable.tableArn,
            auditEventsTable.tableArn,
            fileProofingTable.tableArn,
            teamIssueEventsTable.tableArn,
            workItemConfigurationTable.tableArn,
            workItemsTable.tableArn,
          ],
        })],
      },
    ));
    automationScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
      ],
      resources: [cognitoUserPoolArn],
    }));
    automationScheduleFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'AutomationScheduleWebhookSecretPolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [automationWebhookSecretArn],
        })],
      },
    ));
    automationScheduleFunction.role.attachInlinePolicy(new iam.Policy(
      this,
      'AutomationScheduleInboundWebhookSecretCleanupPolicy',
      {
        statements: [new iam.PolicyStatement({
          actions: ['secretsmanager:DeleteSecret'],
          resources: [automationInboundWebhookSecretArn],
        })],
      },
    ));

    new cloudwatch.Alarm(this, 'AutomationScheduleDlqAlarm', {
      alarmDescription:
        'Detects recurring Work materialization failures after asynchronous retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: automationScheduleDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new events.Rule(this, 'AutomationScheduleRule', {
      description: 'Checks timezone-aware recurring Work definitions every minute.',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(automationScheduleFunction)],
    });

    const webhookAuthorizationBackfillLogGroup = new logs.LogGroup(
      this,
      'WebhookAuthorizationBackfillLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const webhookAuthorizationBackfillFunction = new lambdaNodejs.NodejsFunction(
      this,
      'WebhookAuthorizationBackfillFunction',
      {
        entry: path.join(
          __dirname,
          '../../server/src/webhook-authorization-backfill-handler.ts',
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        description:
          'Starts the API, projection, and delivery drain before Webhook backfill.',
        logGroup: webhookAuthorizationBackfillLogGroup,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
            'WebhookAuthorizationIndex',
        },
      },
    );
    projectDirectoryTable.grants.readWriteData(webhookAuthorizationBackfillFunction);
    developerPlatformTable.grants.readWriteData(
      webhookAuthorizationBackfillFunction,
    );
    const webhookAuthorizationBackfillProgressLogGroup = new logs.LogGroup(
      this,
      'WebhookAuthorizationBackfillProgressLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const webhookAuthorizationBackfillProgressFunction =
      new lambdaNodejs.NodejsFunction(
        this,
        'WebhookAuthorizationBackfillProgressFunction',
        {
          entry: path.join(
            __dirname,
            '../../server/src/webhook-authorization-backfill-handler.ts',
          ),
          handler: 'isCompleteHandler',
          runtime: lambda.Runtime.NODEJS_22_X,
          depsLockFilePath: path.join(__dirname, '../../bun.lock'),
          projectRoot: path.join(__dirname, '../..'),
          timeout: cdk.Duration.minutes(5),
          memorySize: 1024,
          description:
            'Drains old Webhook runtimes and processes checkpointed migration pages.',
          logGroup: webhookAuthorizationBackfillProgressLogGroup,
          bundling: {
            bundleAwsSDK: true,
            minify: true,
            sourceMap: true,
            target: 'node22',
          },
          environment: {
            DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
            PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
            PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
              'WebhookAuthorizationIndex',
          },
        },
      );
    projectDirectoryTable.grants.readWriteData(
      webhookAuthorizationBackfillProgressFunction,
    );
    developerPlatformTable.grants.readWriteData(
      webhookAuthorizationBackfillProgressFunction,
    );
    const webhookAuthorizationBackfillProviderLogGroup = new logs.LogGroup(
      this,
      'WebhookAuthorizationBackfillProviderLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const webhookAuthorizationBackfillProvider = new customResources.Provider(
      this,
      'WebhookAuthorizationBackfillProvider',
      {
        onEventHandler: webhookAuthorizationBackfillFunction,
        isCompleteHandler: webhookAuthorizationBackfillProgressFunction,
        logGroup: webhookAuthorizationBackfillProviderLogGroup,
        queryInterval: cdk.Duration.seconds(1),
        totalTimeout: cdk.Duration.hours(1),
      },
    );
    const webhookAuthorizationBackfill = new cdk.CustomResource(
      this,
      'WebhookAuthorizationBackfill',
      {
        serviceToken: webhookAuthorizationBackfillProvider.serviceToken,
        properties: {
          DeveloperPlatformTableName: developerPlatformTable.tableName,
          MigrationVersion: 'v3',
          ProjectDirectoryTableName: projectDirectoryTable.tableName,
        },
      },
    );

    const webhookDeliveryLogGroup = new logs.LogGroup(
      this,
      'WebhookDeliveryLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const webhookDeliveryFunction = new lambdaNodejs.NodejsFunction(
      this,
      'WebhookDeliveryFunction',
      {
        entry: path.join(__dirname, '../../server/src/webhook-handler.ts'),
        handler: 'deliveryHandler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        description: 'Delivers signed Webhooks from the durable SQS queue.',
        logGroup: webhookDeliveryLogGroup,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
          DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
          DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID:
            developerPlatformWebhookKey.keyArn,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        },
      },
    );
    // First deploy the compatibility writer and dual-read consumers. The v3
    // resource drains old runtimes, backfills primary locators, cuts over,
    // drains compatibility writes, and only then removes legacy lookup keys.
    // Its Delete path reverses the locator migration before dependency rollback.
    webhookAuthorizationBackfill.node.addDependency(
      apiFunction,
      collaborationProjectionFunction,
      webhookDeliveryFunction,
    );

    webhookDeliveryFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(webhookDeliveryQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    webhookDeliveryFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [
        auditEventsTable.tableArn,
        developerPlatformTable.tableArn,
        projectDirectoryTable.tableArn,
        workspaceAccessTable.tableArn,
      ],
    }));
    webhookDeliveryFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [
        `${developerPlatformTable.tableArn}/index/LookupKeyIndex`,
        projectDirectoryTable.tableArn,
      ],
    }));
    webhookDeliveryFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:DeleteItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      resources: [developerPlatformTable.tableArn],
    }));
    webhookDeliveryFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:DeleteItem'],
      resources: [projectDirectoryTable.tableArn],
    }));
    restrictKmsGrantToDeveloperPlatformPurpose(
      developerPlatformWebhookKey.grants.decrypt(webhookDeliveryFunction),
      'webhook',
    );
    webhookDeliveryQueue.grants.consumeMessages(webhookDeliveryFunction);
    webhookDeliveryQueue.grants.sendMessages(webhookDeliveryFunction);

    new cloudwatch.Alarm(this, 'WebhookDeliveryDlqAlarm', {
      alarmDescription:
        'Detects signed Webhook deliveries that exhausted queue redrive attempts.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: webhookDeliveryDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const connectorSyncLogGroup = new logs.LogGroup(
      this,
      'ConnectorSyncLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const connectorSyncFunction = new lambdaNodejs.NodejsFunction(
      this,
      'ConnectorSyncFunction',
      {
        entry: path.join(__dirname, '../../server/src/connector-handler.ts'),
        handler: 'queueHandler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        description:
          'Processes provider-neutral connector synchronization jobs with current Work Item RBAC.',
        logGroup: connectorSyncLogGroup,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN:
            connectorRuntimeSecret.secretArn,
          CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl,
          DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID:
            developerPlatformConnectorKey.keyArn,
          DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
          DEVELOPER_PLATFORM_STATE_KMS_KEY_ID:
            developerPlatformStateKey.keyArn,
          DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
          MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
          MUKUROJI_RUNTIME_ROLE: 'connector-queue-worker',
          MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
          MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
          WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
          WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        },
      },
    );
    connectorSyncFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(connectorSyncQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    connectorSyncQueue.grants.consumeMessages(connectorSyncFunction);
    connectorSyncQueue.grants.sendMessages(connectorSyncFunction);
    connectorRuntimeSecret.grantRead(connectorSyncFunction);
    developerPlatformTable.grants.readWriteData(connectorSyncFunction);
    workItemsTable.grants.readWriteData(connectorSyncFunction);
    teamIssueEventsTable.grants.readWriteData(connectorSyncFunction);
    auditEventsTable.grants.readWriteData(connectorSyncFunction);
    projectDirectoryTable.grants.readData(connectorSyncFunction);
    workspaceAccessTable.grants.readData(connectorSyncFunction);
    workItemConfigurationTable.grants.readData(connectorSyncFunction);
    workspaceSearchTable.grants.readWriteData(connectorSyncFunction);
    restrictKmsGrantToDeveloperPlatformPurpose(
      developerPlatformConnectorKey.grants.actions(
        connectorSyncFunction,
        'kms:Decrypt',
        'kms:GenerateDataKey',
      ),
      'connector',
    );
    restrictKmsGrantToDeveloperPlatformPurpose(
      developerPlatformStateKey.grants.actions(
        connectorSyncFunction,
        'kms:Decrypt',
        'kms:GenerateDataKey',
      ),
      'platform-state',
    );
    connectorSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
      ],
      resources: [cognitoUserPoolArn],
    }));

    const connectorPollLogGroup = new logs.LogGroup(
      this,
      'ConnectorPollLogGroup',
      {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.THREE_MONTHS,
      },
    );
    const connectorPollFunction = new lambdaNodejs.NodejsFunction(
      this,
      'ConnectorPollFunction',
      {
        entry: path.join(__dirname, '../../server/src/connector-handler.ts'),
        handler: 'pollHandler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        description: 'Schedules bounded polling jobs for connected provider installations.',
        logGroup: connectorPollLogGroup,
        onFailure: new lambdaDestinations.SqsDestination(connectorPollDlq),
        retryAttempts: 2,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl,
          DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
          DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
          MUKUROJI_RUNTIME_ROLE: 'connector-poll',
        },
      },
    );
    connectorPollFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
      ],
      resources: [developerPlatformTable.tableArn],
    }));
    connectorPollFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${developerPlatformTable.tableArn}/index/LookupKeyIndex`],
    }));
    connectorSyncQueue.grants.sendMessages(connectorPollFunction);

    // EventBridge delivery failures and exhausted Lambda async invocations share this
    // operator-inspected DLQ. It has no automatic consumer, so both envelope formats
    // remain intact for diagnosis and the alarm below covers either failure path.
    new events.Rule(this, 'ConnectorPollRule', {
      description: 'Schedules bounded connector polling for providers without push events.',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new eventsTargets.LambdaFunction(connectorPollFunction, {
          deadLetterQueue: connectorPollDlq,
          maxEventAge: cdk.Duration.hours(1),
          retryAttempts: 2,
        }),
      ],
    });

    new cloudwatch.Alarm(this, 'ConnectorSyncDlqAlarm', {
      alarmDescription:
        'Detects connector projection or sync jobs that exhausted queue redrive retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: connectorSyncDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'ConnectorPollDlqAlarm', {
      alarmDescription:
        'Detects scheduled connector polling invocations that exhausted EventBridge retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: connectorPollDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'ConnectorSyncQueueAgeAlarm', {
      alarmDescription: 'Detects connector synchronization jobs delayed for 15 minutes.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: connectorSyncQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: cdk.Duration.minutes(15).toSeconds(),
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const analyticsScheduleDlq = new sqs.Queue(this, 'AnalyticsScheduleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const analyticsScheduleFunction = new lambdaNodejs.NodejsFunction(
      this,
      'AnalyticsScheduleFunction',
      {
        entry: path.join(__dirname, '../../server/src/analytics-schedule-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        description:
          'Creates permission-safe in-app analytics snapshot delivery receipts on deterministic schedule occurrences.',
        onFailure: new lambdaDestinations.SqsDestination(analyticsScheduleDlq),
        retryAttempts: 2,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
          ANALYTICS_TABLE_NAME: analyticsTable.tableName,
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        },
      },
    );
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [analyticsTable.tableArn],
    }));
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${analyticsTable.tableArn}/index/ScheduleDueIndex`],
    }));
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:TransactWriteItems'],
      resources: [analyticsTable.tableArn],
    }));
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminListGroupsForUser'],
      resources: [cognitoUserPoolArn],
    }));
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${auditEventsTable.tableArn}/index/EntityOccurredAtIndex`],
    }));
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [projectDirectoryTable.tableArn, workItemsTable.tableArn],
    }));
    analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [workspaceAccessTable.tableArn],
    }));

    new cloudwatch.Alarm(this, 'AnalyticsScheduleDlqAlarm', {
      alarmDescription:
        'Detects analytics snapshot delivery failures after asynchronous retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: analyticsScheduleDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'AnalyticsScheduleDestinationFailureAlarm', {
      alarmDescription:
        'Detects failures while Lambda delivers analytics schedule failures to the DLQ.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: analyticsScheduleFunction.metric('DestinationDeliveryFailures', {
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new events.Rule(this, 'AnalyticsScheduleRule', {
      description: 'Checks due saved analytics reports every five minutes.',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(analyticsScheduleFunction)],
    });

    const notificationScheduleDlq = new sqs.Queue(this, 'NotificationScheduleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
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
    workItemsTable.grants.readData(notificationScheduleFunction);
    auditEventsTable.grants.writeData(notificationScheduleFunction);

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

    const requestEmailIngestionDlq = new sqs.Queue(this, 'RequestEmailIngestionDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    });
    const requestEmailIngestionFunction = new lambdaNodejs.NodejsFunction(
      this,
      'RequestEmailIngestionFunction',
      {
        entry: path.join(__dirname, '../../server/src/request-intake-email-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        description: 'Validates signed email envelopes and appends them to request intake threads.',
        onFailure: new lambdaDestinations.SqsDestination(requestEmailIngestionDlq),
        retryAttempts: 2,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          REQUEST_EMAIL_WEBHOOK_SECRET: requestEmailWebhookSecret.valueAsString,
          REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
          REQUEST_TOKEN_HASH_SECRET: requestTokenHashSecret.valueAsString,
        },
      },
    );
    requestEmailIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [requestIntakeTable.tableArn],
      }),
    );
    requestEmailIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [requestIntakeTable.tableArn],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      }),
    );

    new cloudwatch.Alarm(this, 'RequestEmailIngestionDlqAlarm', {
      alarmDescription: 'Detects request intake email envelopes that exhausted asynchronous retries.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: requestEmailIngestionDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'RequestEmailIngestionDestinationFailureAlarm', {
      alarmDescription: 'Detects failures while Lambda delivers request intake email failures to the DLQ.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: requestEmailIngestionFunction.metric('DestinationDeliveryFailures', {
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
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
    new cdk.CfnOutput(this, 'WorkItemConfigurationTableName', {
      value: workItemConfigurationTable.tableName,
    });
    new cdk.CfnOutput(this, 'AutomationTableName', {
      value: automationTable.tableName,
    });
    new cdk.CfnOutput(this, 'PlanningTableName', {
      value: planningTable.tableName,
    });
    new cdk.CfnOutput(this, 'DeveloperPlatformTableName', {
      value: developerPlatformTable.tableName,
    });
    new cdk.CfnOutput(this, 'DeveloperPlatformLookupIndexName', {
      value: 'LookupKeyIndex',
    });
    new cdk.CfnOutput(this, 'AnalyticsTableName', {
      value: analyticsTable.tableName,
    });
    new cdk.CfnOutput(this, 'RequestIntakeTableName', {
      value: requestIntakeTable.tableName,
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
    new cdk.CfnOutput(this, 'DocumentsTableName', { value: documentsTable.tableName });
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
    new cdk.CfnOutput(this, 'FileProofingTableName', {
      value: fileProofingTable.tableName,
    });
    new cdk.CfnOutput(this, 'FileBucketName', {
      value: fileBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'FileMalwareProtectionPlanId', {
      value: malwareProtectionPlan.attrMalwareProtectionPlanId,
    });
    new cdk.CfnOutput(this, 'RealtimeWebSocketUrl', {
      value: realtimeWebSocketStage.url,
    });
    new cdk.CfnOutput(this, 'CollaborationProjectionDlqUrl', {
      value: collaborationProjectionDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'WebhookDeliveryQueueUrl', {
      value: webhookDeliveryQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'WebhookDeliveryDlqUrl', {
      value: webhookDeliveryDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'WorkItemImportBucketName', {
      value: workItemImportBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'WorkItemImportQueueUrl', {
      value: workItemImportQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'WorkItemImportDlqUrl', {
      value: workItemImportDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'ConnectorRuntimeSecretArn', {
      value: connectorRuntimeSecret.secretArn,
    });
    new cdk.CfnOutput(this, 'ConnectorSyncQueueUrl', {
      value: connectorSyncQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'ConnectorSyncDlqUrl', {
      value: connectorSyncDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'ConnectorPollDlqUrl', {
      value: connectorPollDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'AutomationEventDlqUrl', {
      value: automationEventDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'AutomationScheduleDlqUrl', {
      value: automationScheduleDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'AnalyticsScheduleDlqUrl', {
      value: analyticsScheduleDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'NotificationScheduleDlqUrl', {
      value: notificationScheduleDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'RequestEmailIngestionFunctionName', {
      value: requestEmailIngestionFunction.functionName,
    });
    new cdk.CfnOutput(this, 'RequestEmailIngestionDlqUrl', {
      value: requestEmailIngestionDlq.queueUrl,
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
