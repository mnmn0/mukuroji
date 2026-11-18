import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type {
  PersonalNotificationReminderDays,
  TeamNotificationReminderDays,
} from '@mukuroji/contracts'
import type {
  SaveTeamReminderSettingsInput,
  ScheduledReminderSettingsReader,
  TeamReminderSettingsRecord,
  TeamReminderSettingsStore,
} from '../../application/ports/reminder-settings-reader'
import { NotificationError } from '../../domain/notification-error'
import { normalizeTeamReminderDays } from '../../domain/reminder-days'
import {
  NOTIFICATION_PREFERENCES_KEY,
  createNotificationRecipientKey,
  parseStoredNotificationPreferences,
} from '../../notifications'

/**
 * Partition suffix of the Workspace's Team reminder rows. Every member key is an email address
 * with an `@`, so the partition never collides with a member's notification partition, and the `<workspaceId>#`
 * prefix keeps the rows inside the Workspace's tenant deletion and export range.
 */
const teamReminderPartitionSuffix = '!team-reminder-settings'

/** Item type stored on Team reminder rows. */
const teamReminderItemType = 'team-reminder-settings'

/** DynamoDB store for Team reminder overrides and the schedule's view of personal overrides. */
export class DynamoDbReminderSettingsStore
  implements ScheduledReminderSettingsReader, TeamReminderSettingsStore {
  /** DocumentClient used for reads and transactions. */
  private readonly documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** NotificationsTable name. */
  private readonly tableName: string

  /**
   * Creates the store.
   *
   * @param documentClient - DocumentClient bound to the NotificationsTable region.
   * @param tableName - NotificationsTable name.
   */
  constructor(documentClient: Pick<DynamoDBDocumentClient, 'send'>, tableName: string) {
    const name = tableName.trim()
    if (!name) throw new Error('Notifications table name is required.')
    this.documentClient = documentClient
    this.tableName = name
  }

  /**
   * Reads a Team's saved overrides.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param teamId - Team ID.
   * @returns The saved overrides, or an empty revision-0 record when none are saved.
   * @throws Error when the stored row is corrupt.
   */
  async getTeamSettings(workspaceId: string, teamId: string): Promise<TeamReminderSettingsRecord> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createTeamReminderKey(workspaceId, teamId),
      ConsistentRead: true,
    }))
    return parseTeamReminderRow(response.Item)
  }

  /**
   * Replaces a Team's overrides when the stored revision still matches.
   *
   * @param input - Workspace, Team, overrides, expected revision, and audit put.
   * @returns The saved record.
   * @throws NotificationError (409) when another save won.
   */
  async saveTeamSettings(input: SaveTeamReminderSettingsInput): Promise<TeamReminderSettingsRecord> {
    const next: TeamReminderSettingsRecord = {
      days: input.days,
      revision: input.expectedRevision + 1,
      updatedAt: input.now.toISOString(),
      ...(input.mutation ? { lastMutation: input.mutation } : {}),
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...createTeamReminderKey(input.workspaceId, input.teamId),
                itemType: teamReminderItemType,
                workspaceId: input.workspaceId,
                teamId: input.teamId,
                days: next.days,
                revision: next.revision,
                updatedAt: next.updatedAt,
                ...(input.mutation
                  ? {
                      lastIdempotencyKey: input.mutation.idempotencyKey,
                      lastRequestFingerprint: input.mutation.requestFingerprint,
                    }
                  : {}),
              },
              ...(input.expectedRevision === 0
                ? { ConditionExpression: 'attribute_not_exists(recipientKey)' }
                : {
                    ConditionExpression: '#revision = :revision',
                    ExpressionAttributeNames: { '#revision': 'revision' },
                    ExpressionAttributeValues: { ':revision': input.expectedRevision },
                  }),
            },
          },
          ...(input.auditPut ? [input.auditPut] : []),
        ],
      }))
    } catch (error) {
      if (isConditionalTransactionFailure(error)) {
        throw new NotificationError(
          409,
          'NotificationReminderSettingsConflict',
          'Team reminder settings changed before this update was saved.',
        )
      }
      throw error
    }
    return next
  }

  /** @inheritdoc */
  async readTeamReminderDays(
    workspaceId: string,
    teamId: string,
  ): Promise<TeamNotificationReminderDays | undefined> {
    const settings = await this.getTeamSettings(workspaceId, teamId)
    return settings.revision > 0 ? settings.days : undefined
  }

  /** @inheritdoc */
  async readPersonalReminderDays(
    workspaceId: string,
    memberKey: string,
  ): Promise<PersonalNotificationReminderDays | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        recipientKey: createNotificationRecipientKey(workspaceId, memberKey),
        notificationKey: NOTIFICATION_PREFERENCES_KEY,
      },
      ConsistentRead: true,
    }))
    return parseStoredNotificationPreferences(response.Item).reminderDays
  }
}

/**
 * Builds the NotificationsTable key of a Team's reminder row.
 *
 * @param workspaceId - Canonical Workspace ID.
 * @param teamId - Team ID.
 * @returns Partition and sort key.
 */
function createTeamReminderKey(workspaceId: string, teamId: string) {
  const workspace = workspaceId.trim()
  const team = teamId.trim()
  if (!workspace || !team) throw new Error('Workspace and Team IDs are required.')
  return {
    recipientKey: `${workspace}#${teamReminderPartitionSuffix}`,
    notificationKey: `TEAM#${team}`,
  }
}

/**
 * Validates a stored Team reminder row.
 *
 * @param value - Stored row, or undefined when none exists.
 * @returns The parsed record.
 * @throws Error when the row is corrupt, so the schedule retries instead of using defaults.
 */
function parseTeamReminderRow(value: Record<string, unknown> | undefined): TeamReminderSettingsRecord {
  if (!value) return { days: {}, revision: 0 }
  const revision = value.revision
  if (
    value.itemType !== teamReminderItemType ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error('Stored Team reminder settings are invalid.')
  }
  let days: TeamNotificationReminderDays
  try {
    days = normalizeTeamReminderDays(value.days)
  } catch {
    throw new Error('Stored Team reminder settings are invalid.')
  }
  const updatedAt = typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    ? value.updatedAt
    : undefined
  const lastMutation = typeof value.lastIdempotencyKey === 'string' &&
    typeof value.lastRequestFingerprint === 'string'
    ? { idempotencyKey: value.lastIdempotencyKey, requestFingerprint: value.lastRequestFingerprint }
    : undefined
  return {
    days,
    revision,
    ...(updatedAt ? { updatedAt } : {}),
    ...(lastMutation ? { lastMutation } : {}),
  }
}

/**
 * Reports whether a transaction failed because a condition did not hold.
 *
 * @param error - Error thrown by the transaction.
 * @returns Whether a conditional check cancelled the transaction.
 */
function isConditionalTransactionFailure(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  return Array.isArray(reasons) && reasons.some((reason: unknown) =>
    typeof reason === 'object' && reason !== null &&
    Reflect.get(reason, 'Code') === 'ConditionalCheckFailed')
}
