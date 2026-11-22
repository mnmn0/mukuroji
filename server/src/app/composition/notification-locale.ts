import type { MemberPreferences } from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import type { NotificationLocaleReader } from '../../modules/notifications'

/** Directory read the locale reader needs. */
export type MemberPreferencesReader = {
  /**
   * Reads one member's display preferences.
   *
   * @param directoryId - Workspace directory ID.
   * @param memberKey - Member key that owns the preferences.
   * @returns The stored preferences or the revision-zero default.
   */
  getMemberPreferences(directoryId: string, memberKey: string): Promise<MemberPreferences>
}

/**
 * Creates a reader for the language a recipient chose in their display preferences.
 *
 * @param directory - Directory that stores member preferences.
 * @returns English only when the member chose it, otherwise Japanese. A row that cannot be read
 *   as preferences also gives Japanese, so a broken row does not hold deliveries forever;
 *   other failures reject so the delivery is retried.
 */
export function createMemberNotificationLocaleReader(directory: MemberPreferencesReader): NotificationLocaleReader {
  return async (recipient) => {
    try {
      const preferences = await directory.getMemberPreferences(recipient.workspaceId, recipient.memberKey)
      return preferences.locale === 'en' ? 'en' : 'ja'
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'InvalidMemberPreferences') return 'ja'
      throw error
    }
  }
}
