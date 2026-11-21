import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { JapanesePublicHolidayStore } from '../../application/japanese-public-holiday-sync'
import {
  InvalidStoredJapanesePublicHolidaysError,
  readStoredJapanesePublicHolidays,
  type StoredJapanesePublicHolidays,
} from '../../domain/japanese-public-holidays'

/**
 * Partition of the tenant administration table that holds data shared by every Workspace. It can
 * never equal a Workspace ID, which is a directory ID such as `user#…` or a tenant UUID.
 */
export const SHARED_REFERENCE_DATA_PARTITION = 'system#public-holidays'

/** Sort key of the Japanese national holiday list. */
export const JAPANESE_PUBLIC_HOLIDAYS_RECORD_KEY = 'JAPAN'

/** Entry type that tells the row apart from tenant records. */
const ENTRY_TYPE = 'japanese-public-holidays'

/**
 * Keeps the synced Japanese national holidays in one row of the tenant administration table.
 */
export class DynamoDbJapanesePublicHolidayStore implements JapanesePublicHolidayStore {
  /** Tenant administration table. */
  private readonly tableName: string
  /** DynamoDB document client. */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * @param tableName - Tenant administration table.
   * @param documentClient - DynamoDB document client.
   */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient) {
    this.tableName = tableName
    this.documentClient = documentClient
  }

  /**
   * Reads the stored list.
   *
   * @returns The list, or undefined before the first sync.
   * @throws InvalidStoredJapanesePublicHolidaysError when the stored row is malformed, so it is
   *   never used silently.
   */
  async get(): Promise<StoredJapanesePublicHolidays | undefined> {
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId: SHARED_REFERENCE_DATA_PARTITION, recordKey: JAPANESE_PUBLIC_HOLIDAYS_RECORD_KEY },
    }))
    if (!result.Item) return undefined
    const stored = result.Item.entryType === ENTRY_TYPE
      ? readStoredJapanesePublicHolidays(result.Item)
      : undefined
    if (!stored) throw new InvalidStoredJapanesePublicHolidaysError()
    return stored
  }

  /**
   * Replaces the stored list.
   *
   * @param holidays - List to store.
   */
  async put(holidays: StoredJapanesePublicHolidays): Promise<void> {
    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        workspaceId: SHARED_REFERENCE_DATA_PARTITION,
        recordKey: JAPANESE_PUBLIC_HOLIDAYS_RECORD_KEY,
        entryType: ENTRY_TYPE,
        holidays: holidays.holidays.map((holiday) => ({ date: holiday.date, name: holiday.name })),
        fetchedAt: holidays.fetchedAt,
        fetchedMonth: holidays.fetchedMonth,
        sourceSha256: holidays.sourceSha256,
      },
    }))
  }
}
