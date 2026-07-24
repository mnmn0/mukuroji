import * as customResources from 'aws-cdk-lib/custom-resources';

/**
 * Canonical owner Team for each Project, including Projects displayed under multiple Teams.
 */
const projectOwnerTeamIds = {
  refero: 'core-team',
  'product-roadmap': 'core-team',
  'shared-launch': 'core-team',
  'brand-refresh': 'design-team',
} as const;

/**
 * Refero demo records seeded into the canonical Work Item table.
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
 * Canonical category corresponding to each built-in workflow status ID.
 */
const canonicalWorkflowStatusCategories = {
  todo: 'unstarted',
  'in-progress': 'started',
  review: 'started',
  done: 'completed',
} as const;

/**
 * Deterministic timestamp used by canonical Work Item seed records.
 */
const canonicalWorkItemSeedTimestamp = '2026-06-01T00:00:00.000Z';

/**
 * Project IDs that register the initial owner as a manager.
 */
const ownerProjectIds = ['refero', 'product-roadmap', 'shared-launch', 'brand-refresh'] as const;

/**
 * Deterministic timestamp used by idempotent workspace bootstrap records.
 */
const workspaceBootstrapTimestamp = '2026-07-11T00:00:00.000Z';

/**
 * Creates the initial workspace metadata and owner transaction payload.
 *
 * @param tableName - Workspace access table name.
 * @param workspaceId - Canonical workspace identifier.
 * @param initialOwnerEmail - Lowercase email address of the initial owner.
 * @returns Idempotent DynamoDB transaction items.
 */
export function createWorkspaceAccessTransactItems(
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
 * Creates demo workspace members without replacing an existing role or status.
 *
 * @param tableName - Workspace access table name.
 * @param workspaceId - Canonical workspace identifier.
 * @returns Idempotent DynamoDB transaction items for demo members.
 */
export function createWorkspaceDemoMemberTransactItems(tableName: string, workspaceId: string) {
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
 * Demo members other than the owner seeded into the Refero Project.
 */
const projectMemberItems = [
  ['refero', 'sato@example.com', 'sato@example.com', '佐藤 花子', 'member'],
  ['refero', 'viewer@example.com', 'viewer@example.com', 'Viewer User', 'viewer'],
] as const;

/**
 * Returns the authoritative base-table sort key for a demo Team.
 *
 * @param teamId - Team identifier to locate.
 * @returns Stable directory entry key for the Team.
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
 * Creates the DynamoDB partition key for a Project.
 *
 * @param directoryId - Canonical workspace directory identifier.
 * @param projectId - Project identifier.
 * @returns Stable Project partition key.
 */
function createDirectoryProjectId(directoryId: string, projectId: string) {
  return `${directoryId}#project#${projectId}`;
}

/**
 * Creates the DynamoDB sort key for a Project member.
 *
 * @param projectId - Project identifier.
 * @param memberKey - Canonical member key.
 * @returns Stable Project member sort key.
 */
function createProjectMemberEntryKey(projectId: string, memberKey: string) {
  return `PROJECT_MEMBER#${projectId}#${memberKey}`;
}

/**
 * Creates materialized Put operations used to query Team-only Webhook access directly.
 *
 * @param tableName - Project directory table name.
 * @param workspaceId - Canonical workspace identifier.
 * @param teamId - Team identifier granting access.
 * @param projectId - Project identifier covered by the grant.
 * @param memberKey - Canonical member key receiving access.
 * @param teamSourceEntryKey - Authoritative Team directory entry key.
 * @param projectSourceEntryKey - Authoritative Project directory entry key.
 * @returns Materialized Webhook Team grant and cleanup records.
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
 * Creates the DynamoDB sort key for a workspace member.
 *
 * @param memberKey - Canonical member key.
 * @returns Stable workspace member sort key.
 */
function createWorkspaceMemberEntryKey(memberKey: string) {
  return `WORKSPACE_MEMBER#${memberKey}`;
}

/**
 * Creates the DynamoDB sort key for an email alias.
 *
 * @param email - Canonical lowercase email address.
 * @returns Stable email alias sort key.
 */
function createEmailAliasEntryKey(email: string) {
  return `EMAIL_ALIAS#${email}`;
}

/**
 * Creates the initial Team-owned canonical Work Item seed transaction.
 *
 * @param tableName - Canonical Work Item table name.
 * @param directoryId - Canonical workspace directory identifier.
 * @returns Conditional DynamoDB Put operations for demo Work Items.
 */
export function createCanonicalWorkItemTransactItems(tableName: string, directoryId: string) {
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
 * Creates the initial Team and Project directory seed transaction.
 *
 * @param tableName - Project directory table name.
 * @param directoryId - Canonical workspace directory identifier.
 * @returns Conditional DynamoDB Put operations for directory and Webhook grant records.
 */
export function createProjectDirectoryTransactItems(tableName: string, directoryId: string) {
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
 * Creates idempotent workspace metadata, owner, email alias, and Project permissions.
 *
 * @param tableName - Project directory table name.
 * @param directoryId - Canonical workspace directory identifier.
 * @param initialOwnerEmail - Lowercase email address of the initial owner.
 * @param initialOwnerUsername - Cognito username of the initial owner.
 * @returns Idempotent DynamoDB transaction items for workspace bootstrap.
 */
export function createWorkspaceBootstrapTransactItems(
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
 * Creates custom resource properties that run the same AWS SDK call on create and update.
 *
 * @param call - AWS SDK call shared by create and update lifecycle events.
 * @param policy - Least-privilege policy authorizing the SDK call.
 * @returns Idempotent AWS custom resource properties.
 */
export function createIdempotentAwsCustomResourceProps(
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
