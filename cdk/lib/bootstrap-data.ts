import * as customResources from 'aws-cdk-lib/custom-resources';

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
 * CDK demo data が参照する Workspace member を既存 role/status を上書きせず seed します。
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
export function createCanonicalWorkItemTransactItems(tableName: string, directoryId: string) {
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
export function createProjectDirectoryTransactItems(tableName: string, directoryId: string) {
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
        'SET #entryType = if_not_exists(#entryType, :entryType), projectId = if_not_exists(projectId, :projectId), memberKey = if_not_exists(memberKey, :memberKey), email = :email, #role = :role, createdAt = if_not_exists(createdAt, :timestamp), updatedAt = if_not_exists(updatedAt, :timestamp)',
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
