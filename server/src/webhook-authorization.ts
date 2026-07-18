import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
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
  /** Workspace ごとの索引化済み Project directory snapshot です。 */
  directorySnapshots: Map<string, Promise<WebhookAuthorizationDirectorySnapshot>>
  /** Workspace user ごとの active membership snapshot です。 */
  activeMembers: Map<string, ReturnType<WorkspaceAccessClient['getActiveMember']>>
}

/** Project directory を一度だけ走査して構築する ACL 索引です。 */
type WebhookAuthorizationDirectorySnapshot = {
  /** Archive されていない Team ID です。 */
  activeTeamIds: Set<string>
  /** Team ごとの archive されていない Project ID です。 */
  activeProjectIdsByTeam: Map<string, Set<string>>
  /** Webhook delivery を参照できる member ごとの Project ID です。 */
  accessibleProjectIdsByMember: Map<string, Set<string>>
}

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
      directorySnapshots: new Map(),
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
    const snapshotPromise = cache?.directorySnapshots.get(workspaceId) ??
      this.readDirectorySnapshot(workspaceId)
    cache?.directorySnapshots.set(workspaceId, snapshotPromise)
    const snapshot = await snapshotPromise
    if (!snapshot.activeTeamIds.has(teamId)) return false
    const projectId = projectIdValue === undefined
      ? undefined
      : readIdentifier(projectIdValue, 'Webhook Project ID')
    const activeProjectIds = snapshot.activeProjectIdsByTeam.get(teamId)
    if (!activeProjectIds) return false
    if (projectId !== undefined && !activeProjectIds.has(projectId)) return false
    const accessibleProjectIds = snapshot.accessibleProjectIdsByMember.get(
      member.memberKey,
    )
    if (!accessibleProjectIds) return false
    if (projectId !== undefined) return accessibleProjectIds.has(projectId)
    return setsOverlap(activeProjectIds, accessibleProjectIds)
  }

  private async readDirectorySnapshot(workspaceId: string) {
    const snapshot: WebhookAuthorizationDirectorySnapshot = {
      activeTeamIds: new Set(),
      activeProjectIdsByTeam: new Map(),
      accessibleProjectIdsByMember: new Map(),
    }
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.projectDirectoryTableName,
        KeyConditionExpression: 'directoryId = :directoryId',
        ExpressionAttributeValues: { ':directoryId': workspaceId },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        indexAuthorizationRow(snapshot, readAuthorizationRow(item))
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return snapshot
  }
}

/** ACL 判定に必要な Project directory row の最小 shape です。 */
type ProjectDirectoryAuthorizationRow = {
  /** Row discriminator です。 */
  entryType: string
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
    entryType: typeof value.entryType === 'string' ? value.entryType : '',
    ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.memberKey === 'string' ? { memberKey: value.memberKey } : {}),
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
    ...(typeof value.archivedAt === 'string' ? { archivedAt: value.archivedAt } : {}),
  } satisfies ProjectDirectoryAuthorizationRow
}

function indexAuthorizationRow(
  snapshot: WebhookAuthorizationDirectorySnapshot,
  row: ProjectDirectoryAuthorizationRow,
) {
  if (
    row.entryType === 'team' &&
    row.teamId !== undefined &&
    row.archivedAt === undefined
  ) {
    snapshot.activeTeamIds.add(row.teamId)
    return
  }
  if (
    row.entryType === 'project' &&
    row.teamId !== undefined &&
    row.projectId !== undefined &&
    row.archivedAt === undefined
  ) {
    addToSetMap(snapshot.activeProjectIdsByTeam, row.teamId, row.projectId)
    return
  }
  if (
    row.entryType === 'project-member' &&
    row.projectId !== undefined &&
    row.memberKey !== undefined &&
    (row.role === 'viewer' || row.role === 'member' || row.role === 'manager')
  ) {
    addToSetMap(
      snapshot.accessibleProjectIdsByMember,
      row.memberKey,
      row.projectId,
    )
  }
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string) {
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const [smaller, larger] = left.size <= right.size
    ? [left, right]
    : [right, left]
  for (const value of smaller) {
    if (larger.has(value)) return true
  }
  return false
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
