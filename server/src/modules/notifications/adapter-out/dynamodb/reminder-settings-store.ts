import { createHash } from 'node:crypto'
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
  TeamReminderSettingsReceipt,
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

/** Item type stored on the receipt of a settings update sent with an idempotency key. */
const teamReminderReceiptItemType = 'team-reminder-settings-receipt'

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
    return parseTeamReminderRow(response.Item, workspaceId, teamId)
  }

  /** @inheritdoc */
  async getMutationReceipt(
    workspaceId: string,
    teamId: string,
    idempotencyKey: string,
  ): Promise<TeamReminderSettingsReceipt | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createTeamReminderReceiptKey(workspaceId, teamId, idempotencyKey),
      ConsistentRead: true,
    }))
    return parseTeamReminderReceipt(response.Item, workspaceId, teamId)
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
    }
    const authorizationChecks = input.authorizationConditionChecks ?? []
    const receiptPuts = input.mutation
      ? [{
          Put: {
            TableName: this.tableName,
            Item: {
              ...createTeamReminderReceiptKey(input.workspaceId, input.teamId, input.mutation.idempotencyKey),
              itemType: teamReminderReceiptItemType,
              workspaceId: input.workspaceId,
              teamId: input.teamId,
              requestFingerprint: input.mutation.requestFingerprint,
              days: next.days,
              revision: next.revision,
              updatedAt: next.updatedAt,
            },
            // The key was unused when the use case read it; a concurrent use cancels this save.
            ConditionExpression: 'attribute_not_exists(recipientKey)',
          },
        }]
      : []
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
          ...receiptPuts,
          ...authorizationChecks,
          ...(input.auditPut ? [input.auditPut] : []),
        ],
      }))
    } catch (error) {
      const failed = readFailedConditionIndexes(error)
      if (!failed) throw error
      const authorizationStart = 1 + receiptPuts.length
      const authorizationChanged = failed.some((index) =>
        index >= authorizationStart && index < authorizationStart + authorizationChecks.length)
      if (authorizationChanged && !failed.some((index) => index < authorizationStart)) {
        throw new NotificationError(
          409,
          'TeamReminderSettingsAuthorizationChanged',
          'Team permissions changed before this update was saved. Reload and try again.',
        )
      }
      throw new NotificationError(
        409,
        'NotificationReminderSettingsConflict',
        'Team reminder settings changed before this update was saved.',
      )
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
    // Strict: a corrupt row fails the run instead of silently using the Team or default days.
    return parseStoredNotificationPreferences(response.Item, true).reminderDays
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
 * Builds the NotificationsTable key of the receipt of an update sent with an idempotency key.
 *
 * The key is hashed so a client-chosen value never shapes the sort key.
 *
 * @param workspaceId - Canonical Workspace ID.
 * @param teamId - Team ID.
 * @param idempotencyKey - `Idempotency-Key` the client sent.
 * @returns Partition and sort key in the Team reminder partition.
 */
function createTeamReminderReceiptKey(workspaceId: string, teamId: string, idempotencyKey: string) {
  const key = createTeamReminderKey(workspaceId, teamId)
  const digest = createHash('sha256').update(idempotencyKey).digest('hex')
  return { ...key, notificationKey: `${key.notificationKey}#MUTATION#${digest}` }
}

/**
 * Validates a stored Team reminder row.
 *
 * @param value - Stored row, or undefined when none exists.
 * @param workspaceId - Workspace ID the row was read for.
 * @param teamId - Team ID the row was read for.
 * @returns The parsed record.
 * @throws Error when the row is corrupt or belongs to another scope, so the schedule retries
 * instead of using defaults.
 */
function parseTeamReminderRow(
  value: Record<string, unknown> | undefined,
  workspaceId: string,
  teamId: string,
): TeamReminderSettingsRecord {
  if (!value) return { days: {}, revision: 0 }
  if (value.itemType !== teamReminderItemType) {
    throw new Error('Stored Team reminder settings are invalid.')
  }
  return parseStoredRecord(value, workspaceId, teamId)
}

/**
 * Validates a stored update receipt.
 *
 * @param value - Stored receipt, or undefined when none exists.
 * @param workspaceId - Workspace ID the receipt was read for.
 * @param teamId - Team ID the receipt was read for.
 * @returns The parsed receipt, or undefined when none exists.
 * @throws Error when the receipt is corrupt or belongs to another scope.
 */
function parseTeamReminderReceipt(
  value: Record<string, unknown> | undefined,
  workspaceId: string,
  teamId: string,
): TeamReminderSettingsReceipt | undefined {
  if (!value) return undefined
  const requestFingerprint = value.requestFingerprint
  if (
    value.itemType !== teamReminderReceiptItemType ||
    typeof requestFingerprint !== 'string' ||
    !requestFingerprint
  ) {
    throw new Error('Stored Team reminder settings receipt is invalid.')
  }
  return { requestFingerprint, record: parseStoredRecord(value, workspaceId, teamId) }
}

/**
 * Validates the scope, revision, overrides, and save time shared by settings rows and receipts.
 *
 * @param value - Stored row.
 * @param workspaceId - Workspace ID the row was read for.
 * @param teamId - Team ID the row was read for.
 * @returns The parsed record.
 * @throws Error when a field is invalid or the stored IDs differ from the requested scope.
 */
function parseStoredRecord(
  value: Record<string, unknown>,
  workspaceId: string,
  teamId: string,
): TeamReminderSettingsRecord {
  const revision = value.revision
  if (
    value.workspaceId !== workspaceId.trim() ||
    value.teamId !== teamId.trim() ||
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
  return {
    days,
    revision,
    ...(updatedAt ? { updatedAt } : {}),
  }
}

/**
 * Lists the transaction items whose condition did not hold.
 *
 * @param error - Error thrown by the transaction.
 * @returns Indexes of the failed conditions, or undefined when the error is not a conditional cancellation.
 */
function readFailedConditionIndexes(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return undefined
  const failed = reasons.flatMap((reason: unknown, index) =>
    typeof reason === 'object' && reason !== null &&
      Reflect.get(reason, 'Code') === 'ConditionalCheckFailed'
      ? [index]
      : [])
  return failed.length > 0 ? failed : undefined
}
