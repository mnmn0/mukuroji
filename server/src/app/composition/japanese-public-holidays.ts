import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { loadServerDynamoDbResourceConfig } from '../../infrastructure/config/server-resource-config'
import {
  CABINET_OFFICE_HOLIDAYS_CSV_URL,
  DynamoDbJapanesePublicHolidayStore,
  createCabinetOfficeHolidaySource,
  createJapanesePublicHolidayDates,
  syncJapanesePublicHolidays,
  type JapanesePublicHolidayDates,
} from '../../modules/tenant-administration'

/** How long the API reuses a read of the synced national holidays. */
const NATIONAL_HOLIDAY_CACHE_MILLISECONDS = 60 * 60 * 1_000

/**
 * Creates the store of synced national holidays in the tenant administration table.
 *
 * @returns The configured store.
 */
function createProductionJapanesePublicHolidayStore(): DynamoDbJapanesePublicHolidayStore {
  return new DynamoDbJapanesePublicHolidayStore(
    loadServerDynamoDbResourceConfig().tenantAdministrationTableName,
    createDynamoDbDocumentClient(createDynamoDbClient()),
  )
}

/**
 * Creates the national holiday reader the API uses for new Work Items.
 *
 * @returns A reader that caches the synced list for an hour and falls back to the bundled one.
 */
export function createProductionJapanesePublicHolidayDates(): JapanesePublicHolidayDates {
  return createJapanesePublicHolidayDates({
    store: createProductionJapanesePublicHolidayStore(),
    cacheMilliseconds: NATIONAL_HOLIDAY_CACHE_MILLISECONDS,
    now: () => Date.now(),
    /**
     * Logs a failed read without the stored data.
     *
     * @param error - Failure of the store read.
     */
    logError(error) {
      console.error(JSON.stringify({
        message: 'Japanese national holidays could not be read; using the previous or bundled list',
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      }))
    },
  })
}

/**
 * Creates the scheduled job that fetches the Cabinet Office holiday list once a month.
 *
 * `JAPANESE_PUBLIC_HOLIDAYS_SOURCE_URL` replaces the Cabinet Office URL for an emulator test.
 *
 * @returns The job entrypoint.
 */
export function createProductionJapanesePublicHolidaySync() {
  const sourceUrl = loadServerConfig().environment.JAPANESE_PUBLIC_HOLIDAYS_SOURCE_URL?.trim() ||
    CABINET_OFFICE_HOLIDAYS_CSV_URL
  const store = createProductionJapanesePublicHolidayStore()
  const source = createCabinetOfficeHolidaySource({ url: sourceUrl })
  return async () => await syncJapanesePublicHolidays({ store, source, now: () => new Date() })
}
