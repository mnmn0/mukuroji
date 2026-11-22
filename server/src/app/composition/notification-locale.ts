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
 *   other failures, and a read still pending when the caller's deadline passes, reject so the
 *   delivery is retried.
 */
export function createMemberNotificationLocaleReader(directory: MemberPreferencesReader): NotificationLocaleReader {
  return async (recipient, signal) => {
    try {
      const preferences = await untilAborted(directory.getMemberPreferences(recipient.workspaceId, recipient.memberKey), signal)
      return preferences.locale === 'en' ? 'en' : 'ja'
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'InvalidMemberPreferences') return 'ja'
      throw error
    }
  }
}

/**
 * Settles with a read, or rejects as soon as the caller's deadline passes, so a stalled read can
 * never let a sender go on after its delivery lease ends.
 *
 * @param read - Pending read.
 * @param signal - Caller's deadline, if any.
 * @returns The read's value when it settles first.
 */
async function untilAborted<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await read
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([read, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
