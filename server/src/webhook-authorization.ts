import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type { WebhookSubscription } from '@mukuroji/contracts'
import {
  createWebhookTeamGrantDirectoryId,
  createWebhookTeamGrantEntryKey,
  createWebhookTeamGrantEntryKeyPrefix,
  createWebhookTeamGrantItem,
} from './webhook-authorization-projection'
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

/** Webhook の Team selector に必要な current ACL state です。 */
export type WebhookTeamAuthorizationState = {
  /** Subscription creator が active Workspace member かどうかです。 */
  activeWorkspaceMember: boolean
  /** 対象 Team が active かどうかです。 */
  activeTeam: boolean
  /** 対象 Team の active Project に creator の viewer 以上の role があるかどうかです。 */
  hasActiveProjectRole: boolean
}

/** Management API と delivery worker が共有する Team Webhook ACL predicate です。 */
export function allowsWebhookTeamAccess(state: WebhookTeamAuthorizationState) {
  return state.activeWorkspaceMember &&
    state.activeTeam &&
    state.hasActiveProjectRole
}

/** 1 Lambda batch 内でのみ共有する ACL read-through cache です。 */
type WebhookAuthorizationBatchCache = {
  /** Base table locator ごとの強整合 ACL row です。 */
  authoritativeRows: Map<string, Promise<ProjectDirectoryAuthorizationRow>>
  /** Workspace user ごとの active membership snapshot です。 */
  activeMembers: Map<string, ReturnType<WorkspaceAccessClient['getActiveMember']>>
  /** Team/member ごとの pagewise grant 検証結果です。 */
  teamGrantAccess: Map<string, Promise<boolean>>
}

/** Team grant を1回の Query で検証する page size です。 */
const WEBHOOK_TEAM_GRANT_QUERY_PAGE_SIZE = 25

/** Project directory の current ACL を使う production authorizer です。 */
export class DynamoDbWebhookSubscriptionAuthorizer
implements WebhookSubscriptionAuthorizer {
  /** Workspace membership を強整合確認する client です。 */
  private readonly workspaceAccess: WorkspaceAccessClient
  /** Team / Project membership を読む DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Project directory table 名です。 */
  private readonly projectDirectoryTableName: string

  constructor(
    workspaceAccess: WorkspaceAccessClient = new DynamoDbWorkspaceAccessClient(),
    documentClient: DynamoDBDocumentClient = createDocumentClient(),
    projectDirectoryTableName = process.env.PROJECT_DIRECTORY_TABLE_NAME ??
      process.env.MUKUROJI_PROJECT_DIRECTORY_TABLE ??
      'mukuroji-project-directory-local',
  ) {
    this.workspaceAccess = workspaceAccess
    this.documentClient = documentClient
    this.projectDirectoryTableName = readIdentifier(
      projectDirectoryTableName,
      'Project directory table name',
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
      authoritativeRows: new Map(),
      activeMembers: new Map(),
      teamGrantAccess: new Map(),
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
    if (!member) {
      return allowsWebhookTeamAccess({
        activeWorkspaceMember: false,
        activeTeam: false,
        hasActiveProjectRole: false,
      })
    }
    const projectId = projectIdValue === undefined
      ? undefined
      : readIdentifier(projectIdValue, 'Webhook Project ID')
    const hasActiveProjectRole = await this.hasActiveTeamGrant(
      workspaceId,
      teamId,
      member.memberKey,
      projectId,
      cache,
    )
    return allowsWebhookTeamAccess({
      activeWorkspaceMember: true,
      activeTeam: hasActiveProjectRole,
      hasActiveProjectRole,
    })
  }

  private async hasActiveTeamGrant(
    workspaceId: string,
    teamId: string,
    memberKey: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const cacheKey = `${workspaceId}\0${teamId}\0${memberKey}\0${projectId ?? ''}`
    const cached = cache?.teamGrantAccess.get(cacheKey)
    if (cached) return await cached
    const pending = this.queryActiveTeamGrant(
      workspaceId,
      teamId,
      memberKey,
      projectId,
      cache,
    )
    cache?.teamGrantAccess.set(cacheKey, pending)
    return await pending
  }

  private async queryActiveTeamGrant(
    workspaceId: string,
    teamId: string,
    memberKey: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const grantDirectoryId =
      createWebhookTeamGrantDirectoryId(workspaceId, memberKey)
    if (projectId !== undefined) {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.projectDirectoryTableName,
        Key: {
          directoryId: grantDirectoryId,
          entryKey: createWebhookTeamGrantEntryKey(teamId, projectId),
        },
        ConsistentRead: true,
      }))
      const grant = readAuthorizationRow(response.Item ?? {})
      return isWebhookTeamGrant(grant, workspaceId, teamId, memberKey) &&
        await this.hasCurrentGrantSources(grant, memberKey, cache)
    }
    const grantEntryKeyPrefix = createWebhookTeamGrantEntryKeyPrefix(teamId)
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.projectDirectoryTableName,
        KeyConditionExpression:
          'directoryId = :grantDirectoryId AND ' +
          'begins_with(entryKey, :grantEntryKeyPrefix)',
        ExpressionAttributeValues: {
          ':grantDirectoryId': grantDirectoryId,
          ':grantEntryKeyPrefix': grantEntryKeyPrefix,
        },
        ConsistentRead: true,
        Limit: WEBHOOK_TEAM_GRANT_QUERY_PAGE_SIZE,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      const grantRows = (response.Items ?? []).map(readAuthorizationRow)
      const grants = grantRows.filter((row) =>
        isWebhookTeamGrant(row, workspaceId, teamId, memberKey)
      )
      const checks = await Promise.all(grants.map(async (grant) =>
        await this.hasCurrentGrantSources(grant, memberKey, cache)
      ))
      if (checks.some(Boolean)) return true
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return false
  }

  private async hasCurrentGrantSources(
    grant: ProjectDirectoryAuthorizationRow,
    memberKey: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const workspaceId = grant.workspaceId!
    const teamId = grant.teamId!
    const projectId = grant.projectId!
    const [memberRow, teamRow, projectRow] = await Promise.all([
      this.readAuthoritativeRow(workspaceId, grant.sourceEntryKey!, cache),
      this.readAuthoritativeRow(workspaceId, grant.teamSourceEntryKey!, cache),
      this.readAuthoritativeRow(workspaceId, grant.projectSourceEntryKey!, cache),
    ])
    return hasProjectRole([memberRow], memberKey, projectId) &&
      hasActiveTeam([teamRow], teamId) &&
      hasActiveProject([projectRow], teamId, projectId)
  }

  private async readAuthoritativeRow(
    directoryId: string,
    entryKey: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const cacheKey = `${directoryId}\0${entryKey}`
    const cached = cache?.authoritativeRows.get(cacheKey)
    if (cached) return await cached
    const pending = this.documentClient.send(new GetCommand({
      TableName: this.projectDirectoryTableName,
      Key: { directoryId, entryKey },
      ConsistentRead: true,
    })).then((response) => readAuthorizationRow(response.Item ?? {}))
    cache?.authoritativeRows.set(cacheKey, pending)
    return await pending
  }

}

/** ACL 判定に必要な Project directory row の最小 shape です。 */
type ProjectDirectoryAuthorizationRow = {
  /** Workspace ID です。 */
  directoryId?: string
  /** Projection row が参照する Workspace ID です。 */
  workspaceId?: string
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
  /** Materialized grant が参照する authoritative member sort key です。 */
  sourceEntryKey?: string
  /** Materialized grant が参照する authoritative Team sort key です。 */
  teamSourceEntryKey?: string
  /** Materialized grant が参照する authoritative Project sort key です。 */
  projectSourceEntryKey?: string
  /** Archive timestamp です。 */
  archivedAt?: string
}

function readAuthorizationRow(value: Record<string, unknown>) {
  return {
    ...(typeof value.directoryId === 'string' ? { directoryId: value.directoryId } : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
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
    ...(typeof value.sourceEntryKey === 'string'
      ? { sourceEntryKey: value.sourceEntryKey }
      : {}),
    ...(typeof value.teamSourceEntryKey === 'string'
      ? { teamSourceEntryKey: value.teamSourceEntryKey }
      : {}),
    ...(typeof value.projectSourceEntryKey === 'string'
      ? { projectSourceEntryKey: value.projectSourceEntryKey }
      : {}),
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
    row.archivedAt === undefined &&
    (projectId === undefined || row.projectId === projectId) &&
    (row.role === 'viewer' || row.role === 'member' || row.role === 'manager')
  )
}

function isWebhookTeamGrant(
  row: ProjectDirectoryAuthorizationRow,
  workspaceId: string,
  teamId: string,
  memberKey: string,
) {
  if (
    row.entryType !== 'webhook-team-grant' ||
    row.workspaceId !== workspaceId ||
    row.teamId !== teamId ||
    row.memberKey !== memberKey ||
    typeof row.projectId !== 'string' ||
    typeof row.teamSourceEntryKey !== 'string' ||
    typeof row.projectSourceEntryKey !== 'string'
  ) {
    return false
  }
  const expected = createWebhookTeamGrantItem({
    workspaceId,
    teamId,
    projectId: row.projectId,
    memberKey,
    teamSourceEntryKey: row.teamSourceEntryKey,
    projectSourceEntryKey: row.projectSourceEntryKey,
  })
  return row.directoryId === expected.directoryId &&
    row.entryKey === expected.entryKey &&
    row.sourceEntryKey === expected.sourceEntryKey &&
    row.teamSourceEntryKey === expected.teamSourceEntryKey &&
    row.projectSourceEntryKey === expected.projectSourceEntryKey &&
    row.webhookAuthorizationKey === expected.webhookAuthorizationKey &&
    row.webhookAuthorizationSortKey === expected.webhookAuthorizationSortKey
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
