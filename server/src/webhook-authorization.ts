import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type { WebhookSubscription } from '@mukuroji/contracts'
import {
  DynamoDbWorkspaceAccessClient,
  type WorkspaceAccessClient,
} from './workspace-access'

/** Webhook subscription 作成者の現在 Team access を検証する境界です。 */
export interface WebhookSubscriptionAuthorizer {
  /** 作成者が現在も対象 Team を参照できる場合だけ true を返します。 */
  canDeliver(
    workspaceId: string,
    subscription: WebhookSubscription,
    teamId: string,
    projectId?: string,
  ): Promise<boolean>
  /** 1 Lambda batch 内だけ ACL snapshot を共有する authorizer を返します。 */
  createBatch?(): WebhookSubscriptionAuthorizer
}

/** 1 Lambda batch 内でのみ共有する ACL read-through cache です。 */
type WebhookAuthorizationBatchCache = {
  /** Target resource/member ごとの強整合 ACL row です。 */
  authorizationRows: Map<string, Promise<ProjectDirectoryAuthorizationRow[]>>
  /** Workspace user ごとの active membership snapshot です。 */
  activeMembers: Map<string, ReturnType<WorkspaceAccessClient['getActiveMember']>>
}

/** Webhook authorization 用 sparse GSI の既定名です。 */
const DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME = 'WebhookAuthorizationIndex'

/** Project directory の current ACL を使う production authorizer です。 */
export class DynamoDbWebhookSubscriptionAuthorizer
implements WebhookSubscriptionAuthorizer {
  /** Workspace membership を強整合確認する client です。 */
  private readonly workspaceAccess: WorkspaceAccessClient
  /** Team / Project membership を読む DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Project directory table 名です。 */
  private readonly projectDirectoryTableName: string
  /** Webhook authorization sparse GSI 名です。 */
  private readonly webhookAuthorizationIndexName: string

  constructor(
    workspaceAccess: WorkspaceAccessClient = new DynamoDbWorkspaceAccessClient(),
    documentClient: DynamoDBDocumentClient = createDocumentClient(),
    projectDirectoryTableName = process.env.PROJECT_DIRECTORY_TABLE_NAME ??
      process.env.MUKUROJI_PROJECT_DIRECTORY_TABLE ??
      'mukuroji-project-directory-local',
    webhookAuthorizationIndexName =
      process.env.PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME ??
      DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME,
  ) {
    this.workspaceAccess = workspaceAccess
    this.documentClient = documentClient
    this.projectDirectoryTableName = readIdentifier(
      projectDirectoryTableName,
      'Project directory table name',
    )
    this.webhookAuthorizationIndexName = readIdentifier(
      webhookAuthorizationIndexName,
      'Webhook authorization index name',
    )
  }

  /** Active creator と active Project role を delivery ごとに再評価します。 */
  async canDeliver(
    workspaceIdValue: string,
    subscription: WebhookSubscription,
    teamIdValue: string,
    projectIdValue?: string,
  ) {
    return await this.canDeliverWithCache(
      workspaceIdValue,
      subscription,
      teamIdValue,
      projectIdValue,
    )
  }

  /** 同じ Lambda batch の subscription 判定で directory/member read を再利用します。 */
  createBatch(): WebhookSubscriptionAuthorizer {
    const cache: WebhookAuthorizationBatchCache = {
      authorizationRows: new Map(),
      activeMembers: new Map(),
    }
    return {
      canDeliver: async (workspaceId, subscription, teamId, projectId) =>
        await this.canDeliverWithCache(
          workspaceId,
          subscription,
          teamId,
          projectId,
          cache,
        ),
    }
  }

  private async canDeliverWithCache(
    workspaceIdValue: string,
    subscription: WebhookSubscription,
    teamIdValue: string,
    projectIdValue?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Webhook Workspace ID')
    const teamId = readIdentifier(teamIdValue, 'Webhook Team ID')
    if (!subscription.teamIds.includes(teamId)) return false
    const memberCacheKey = `${workspaceId}\0${subscription.createdByUserId}`
    const memberPromise = cache?.activeMembers.get(memberCacheKey) ??
      this.workspaceAccess.getActiveMember(workspaceId, subscription.createdByUserId)
    cache?.activeMembers.set(memberCacheKey, memberPromise)
    const member = await memberPromise
    if (!member) return false
    const projectId = projectIdValue === undefined
      ? undefined
      : readIdentifier(projectIdValue, 'Webhook Project ID')
    const teamPromise = this.readAuthorizationRows(
      workspaceId,
      createResourceAuthorizationKey(workspaceId),
      createTeamAuthorizationSortKey(teamId),
      cache,
    )
    if (projectId !== undefined) {
      const [teamRows, projectRows, memberRows] = await Promise.all([
        teamPromise,
        this.readAuthorizationRows(
          workspaceId,
          createResourceAuthorizationKey(workspaceId),
          createProjectAuthorizationSortKey(projectId),
          cache,
        ),
        this.readAuthorizationRows(
          workspaceId,
          createMemberAuthorizationKey(workspaceId, member.memberKey),
          createProjectAuthorizationSortKey(projectId),
          cache,
        ),
      ])
      return hasActiveTeam(teamRows, teamId) &&
        hasActiveProject(projectRows, teamId, projectId) &&
        hasProjectRole(memberRows, member.memberKey, projectId)
    }

    const [teamRows, memberRows] = await Promise.all([
      teamPromise,
      this.readAuthorizationRows(
        workspaceId,
        createMemberAuthorizationKey(workspaceId, member.memberKey),
        undefined,
        cache,
      ),
    ])
    if (!hasActiveTeam(teamRows, teamId)) return false
    const accessibleProjectIds = new Set(
      memberRows
        .filter((row) => hasProjectRole([row], member.memberKey, row.projectId))
        .flatMap((row) => row.projectId ? [row.projectId] : []),
    )
    const projectIds = [...accessibleProjectIds]
    const projects = await Promise.all(projectIds.map(async (
      accessibleProjectId,
    ) =>
      await this.readAuthorizationRows(
        workspaceId,
        createResourceAuthorizationKey(workspaceId),
        createProjectAuthorizationSortKey(accessibleProjectId),
        cache,
      )
    ))
    return projects.some((rows, index) =>
      hasActiveProject(rows, teamId, projectIds[index]!)
    )
  }

  private async readAuthorizationRows(
    workspaceId: string,
    authorizationKey: string,
    authorizationSortKey: string | undefined,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const cacheKey = `${workspaceId}\0${authorizationKey}\0${authorizationSortKey ?? ''}`
    const cached = cache?.authorizationRows.get(cacheKey)
    if (cached) return await cached
    const pending = this.queryAuthorizationRows(
      workspaceId,
      authorizationKey,
      authorizationSortKey,
    )
    cache?.authorizationRows.set(cacheKey, pending)
    return await pending
  }

  private async queryAuthorizationRows(
    workspaceId: string,
    authorizationKey: string,
    authorizationSortKey?: string,
  ) {
    const locators: Array<{ directoryId: string; entryKey: string }> = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.projectDirectoryTableName,
        IndexName: this.webhookAuthorizationIndexName,
        KeyConditionExpression: authorizationSortKey
          ? 'webhookAuthorizationKey = :authorizationKey AND ' +
            'webhookAuthorizationSortKey = :authorizationSortKey'
          : 'webhookAuthorizationKey = :authorizationKey',
        ExpressionAttributeValues: {
          ':authorizationKey': authorizationKey,
          ...(authorizationSortKey
            ? { ':authorizationSortKey': authorizationSortKey }
            : {}),
        },
        ProjectionExpression: 'directoryId, entryKey',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        if (
          item.directoryId === workspaceId &&
          typeof item.entryKey === 'string'
        ) {
          locators.push({ directoryId: workspaceId, entryKey: item.entryKey })
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return await Promise.all(locators.map(async (locator) => {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.projectDirectoryTableName,
        Key: locator,
        ConsistentRead: true,
      }))
      return readAuthorizationRow(response.Item ?? {})
    })).then((rows) => rows.filter((row) =>
      row.directoryId === workspaceId &&
      row.webhookAuthorizationKey === authorizationKey &&
      (
        authorizationSortKey === undefined ||
        row.webhookAuthorizationSortKey === authorizationSortKey
      )
    ))
  }
}

/** ACL 判定に必要な Project directory row の最小 shape です。 */
type ProjectDirectoryAuthorizationRow = {
  /** Workspace ID です。 */
  directoryId?: string
  /** Base table sort key です。 */
  entryKey?: string
  /** Row discriminator です。 */
  entryType: string
  /** Sparse GSI partition key です。 */
  webhookAuthorizationKey?: string
  /** Sparse GSI sort key です。 */
  webhookAuthorizationSortKey?: string
  /** Team ID です。 */
  teamId?: string
  /** Project ID です。 */
  projectId?: string
  /** Project member key です。 */
  memberKey?: string
  /** Project role です。 */
  role?: string
  /** Archive timestamp です。 */
  archivedAt?: string
}

function readAuthorizationRow(value: Record<string, unknown>) {
  return {
    ...(typeof value.directoryId === 'string' ? { directoryId: value.directoryId } : {}),
    ...(typeof value.entryKey === 'string' ? { entryKey: value.entryKey } : {}),
    entryType: typeof value.entryType === 'string' ? value.entryType : '',
    ...(typeof value.webhookAuthorizationKey === 'string'
      ? { webhookAuthorizationKey: value.webhookAuthorizationKey }
      : {}),
    ...(typeof value.webhookAuthorizationSortKey === 'string'
      ? { webhookAuthorizationSortKey: value.webhookAuthorizationSortKey }
      : {}),
    ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.memberKey === 'string' ? { memberKey: value.memberKey } : {}),
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
    ...(typeof value.archivedAt === 'string' ? { archivedAt: value.archivedAt } : {}),
  } satisfies ProjectDirectoryAuthorizationRow
}

function hasActiveTeam(rows: ProjectDirectoryAuthorizationRow[], teamId: string) {
  return rows.some((row) =>
    row.entryType === 'team' &&
    row.teamId === teamId &&
    row.archivedAt === undefined
  )
}

function hasActiveProject(
  rows: ProjectDirectoryAuthorizationRow[],
  teamId: string,
  projectId: string,
) {
  return rows.some((row) =>
    row.entryType === 'project' &&
    row.teamId === teamId &&
    row.projectId === projectId &&
    row.archivedAt === undefined
  )
}

function hasProjectRole(
  rows: ProjectDirectoryAuthorizationRow[],
  memberKey: string,
  projectId?: string,
) {
  return rows.some((row) =>
    row.entryType === 'project-member' &&
    row.memberKey === memberKey &&
    (projectId === undefined || row.projectId === projectId) &&
    (row.role === 'viewer' || row.role === 'member' || row.role === 'manager')
  )
}

function createResourceAuthorizationKey(workspaceId: string) {
  return `WEBHOOK_ACL#RESOURCE#${workspaceId}`
}

function createMemberAuthorizationKey(workspaceId: string, memberKey: string) {
  return `WEBHOOK_ACL#MEMBER#${workspaceId}#${memberKey}`
}

function createTeamAuthorizationSortKey(teamId: string) {
  return `TEAM#${teamId}`
}

function createProjectAuthorizationSortKey(projectId: string) {
  return `PROJECT#${projectId}`
}

function createDocumentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_DYNAMODB ??
    process.env.AWS_ENDPOINT_URL
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function readIdentifier(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 255 || /\p{Cc}/u.test(normalized)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return normalized
}
