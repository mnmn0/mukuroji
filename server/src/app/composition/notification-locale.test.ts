import { expect, test } from 'bun:test'
import { ProjectDataError } from '../../modules/directory'
import { createMemberNotificationLocaleReader } from './notification-locale'

const recipient = { workspaceId: 'workspace-1', memberKey: 'member@example.test' }

test('reads the recipient language from their own preferences and defaults to Japanese', async () => {
  const reads: string[] = []
  const reader = (locale?: 'ja' | 'en') => createMemberNotificationLocaleReader({
    async getMemberPreferences(directoryId, memberKey) {
      reads.push(`${directoryId}/${memberKey}`)
      return locale ? { locale, revision: 1 } : { revision: 0 }
    },
  })
  expect(await reader('en')(recipient)).toBe('en')
  expect(await reader('ja')(recipient)).toBe('ja')
  expect(await reader()(recipient)).toBe('ja')
  expect(reads).toEqual(Array.from({ length: 3 }, () => 'workspace-1/member@example.test'))
})

test('uses Japanese for an unreadable preference row and rethrows other failures for a retry', async () => {
  const failing = (error: Error) => createMemberNotificationLocaleReader({
    async getMemberPreferences() { throw error },
  })
  expect(await failing(new ProjectDataError(503, 'InvalidMemberPreferences', 'invalid'))(recipient)).toBe('ja')
  await expect(failing(new ProjectDataError(503, 'ProjectDataUnavailable', 'down'))(recipient)).rejects.toThrow('down')
  await expect(failing(new Error('network'))(recipient)).rejects.toThrow('network')
})
