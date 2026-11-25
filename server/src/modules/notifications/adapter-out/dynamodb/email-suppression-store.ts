import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { EmailSuppressionRecorder } from '../../application/email-feedback'
import { EMAIL_SUPPRESSION_ITEM_TYPE, EMAIL_SUPPRESSION_KEY, type EmailSuppression } from '../../domain/email-suppression'
import { NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences } from '../../notifications'

/** Minimal DynamoDB command boundary used by the suppression store. */
type SuppressionDocumentClient = {
  /** Sends one strong read or conditional write. */
  send(command: GetCommand | UpdateCommand, options?: { abortSignal?: AbortSignal }): Promise<{
    /** Strongly read row. */
    Item?: Record<string, unknown>
  }>
}

/** Bounce and complaint suppressions stored beside each recipient's notification preferences. */
export class DynamoDbEmailSuppressionStore implements EmailSuppressionRecorder {
  /** Document client configured by the composition root. */
  readonly #client: SuppressionDocumentClient
  /** Notifications table name. */
  readonly #tableName: string

  /**
   * Creates the store on the existing Notifications table.
   * @param client - Document client configured by the composition root.
   * @param tableName - Notifications table name.
   */
  constructor(client: SuppressionDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /** Writes the suppression unless a newer one is already stored. */
  async record(recipientKey: string, suppression: EmailSuppression): Promise<void> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: { recipientKey, notificationKey: EMAIL_SUPPRESSION_KEY },
        ConditionExpression: 'attribute_not_exists(suppressedAt) OR suppressedAt <= :suppressedAt',
        UpdateExpression: 'SET itemType = :itemType, addressHash = :addressHash, reason = :reason, suppressedAt = :suppressedAt',
        ExpressionAttributeValues: {
          ':itemType': EMAIL_SUPPRESSION_ITEM_TYPE, ':addressHash': suppression.addressHash,
          ':reason': suppression.reason, ':suppressedAt': suppression.suppressedAt,
        },
      }))
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw error
    }
  }

  /**
   * Reads the recipient's suppression while it still applies. Turning Email off and on again
   * after the feedback starts a new opt-in period, which lifts the suppression.
   * @param recipientKey - Recipient partition.
   * @param signal - Deadline signal.
   * @returns The active suppression, or undefined.
   */
  async readActive(recipientKey: string, signal?: AbortSignal): Promise<EmailSuppression | undefined> {
    const row = (await this.#client.send(new GetCommand({
      TableName: this.#tableName, ConsistentRead: true, Key: { recipientKey, notificationKey: EMAIL_SUPPRESSION_KEY },
    }), { abortSignal: signal })).Item
    if (!row) return undefined
    const suppression = parseSuppression(row, recipientKey)
    const preferences = parseStoredNotificationPreferences((await this.#client.send(new GetCommand({
      TableName: this.#tableName, ConsistentRead: true, Key: { recipientKey, notificationKey: NOTIFICATION_PREFERENCES_KEY },
    }), { abortSignal: signal })).Item, true)
    const enabledAt = preferences.emailEnabledAt ?? preferences.updatedAt
    return enabledAt && enabledAt > suppression.suppressedAt ? undefined : suppression
  }
}

/**
 * Validates a stored suppression row.
 * @param row - Strongly read row.
 * @param recipientKey - Expected partition.
 * @returns The suppression; a corrupt row throws so the delivery is retried, never sent.
 */
function parseSuppression(row: Record<string, unknown>, recipientKey: string): EmailSuppression {
  if (
    row.recipientKey !== recipientKey || row.notificationKey !== EMAIL_SUPPRESSION_KEY || row.itemType !== EMAIL_SUPPRESSION_ITEM_TYPE ||
    typeof row.addressHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.addressHash) ||
    (row.reason !== 'bounce' && row.reason !== 'complaint') ||
    // Only the canonical UTC form compares correctly as text with the opt-in time.
    typeof row.suppressedAt !== 'string' || !isCanonicalTimestamp(row.suppressedAt)
  ) throw new Error('Invalid Email suppression row.')
  return { addressHash: row.addressHash, reason: row.reason, suppressedAt: row.suppressedAt }
}

/**
 * Returns whether a timestamp is in the canonical UTC form `toISOString` writes.
 * @param value - Stored timestamp.
 * @returns Whether it round-trips unchanged.
 */
function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
