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
    const workspaceId = readIdentifier(workspaceIdValue, 'Webhook Workspace ID')
    const teamId = readIdentifier(teamIdValue, 'Webhook Team ID')
    if (!subscription.teamIds.includes(teamId)) return false
    const member = await this.workspaceAccess.getActiveMember(
      workspaceId,
      subscription.createdByUserId,
    )
    if (!member) return false
    const rows = await this.readDirectoryRows(workspaceId)
    const teamIsActive = rows.some((row) =>
      row.entryType === 'team' &&
      row.teamId === teamId &&
      row.archivedAt === undefined
    )
    if (!teamIsActive) return false
    const projectId = projectIdValue === undefined
      ? undefined
      : readIdentifier(projectIdValue, 'Webhook Project ID')
    const activeProjectIds = new Set(rows
      .filter((row) =>
        row.entryType === 'project' &&
        row.teamId === teamId &&
        row.archivedAt === undefined &&
        typeof row.projectId === 'string' &&
        (projectId === undefined || row.projectId === projectId)
      )
      .map((row) => row.projectId as string))
    if (projectId !== undefined && !activeProjectIds.has(projectId)) return false
    return rows.some((row) =>
      row.entryType === 'project-member' &&
      row.memberKey === member.memberKey &&
      typeof row.projectId === 'string' &&
      activeProjectIds.has(row.projectId) &&
      (row.role === 'viewer' || row.role === 'member' || row.role === 'manager')
    )
  }

  private async readDirectoryRows(workspaceId: string) {
    const rows: ProjectDirectoryAuthorizationRow[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.projectDirectoryTableName,
        KeyConditionExpression: 'directoryId = :directoryId',
        ExpressionAttributeValues: { ':directoryId': workspaceId },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      rows.push(...(response.Items ?? []).map(readAuthorizationRow))
      if (rows.length > 10_000) {
        throw new TypeError('Project directory authorization read limit was exceeded.')
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return rows
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
