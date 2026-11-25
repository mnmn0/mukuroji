import { expect, test } from 'bun:test'
import {
  followAccessExpiryDraft,
  formatAccessExpiryLastDay,
  hasMemberAccessExpired,
  listOffboardingSuccessors,
  readAccessExpiryFromLastDay,
} from '../src/workspace/model/memberAccessExpiry'
import type { WorkspaceMember } from '../src/workspace/api/access'

test('ends access when the chosen last day ends, and shows that day again', () => {
  const accessExpiresAt = readAccessExpiryFromLastDay('2026-12-24')

  expect(accessExpiresAt).toBe(new Date(2026, 11, 25).toISOString())
  expect(formatAccessExpiryLastDay(accessExpiresAt)).toBe('2026-12-24')
  expect(readAccessExpiryFromLastDay('2026-12-31')).toBe(new Date(2027, 0, 1).toISOString())
})

test('refuses values that are not calendar days', () => {
  expect(readAccessExpiryFromLastDay('')).toBeUndefined()
  expect(readAccessExpiryFromLastDay('2026-02-31')).toBeUndefined()
  expect(readAccessExpiryFromLastDay('2026-12-24T00:00')).toBeUndefined()
  expect(formatAccessExpiryLastDay(undefined)).toBe('')
  expect(formatAccessExpiryLastDay('not a date')).toBe('')
})

test('treats a passed or unreadable expiry as expired', () => {
  const now = new Date('2026-11-24T00:00:00.000Z')

  expect(hasMemberAccessExpired(undefined, now)).toBe(false)
  expect(hasMemberAccessExpired('2026-11-25T00:00:00.000Z', now)).toBe(false)
  expect(hasMemberAccessExpired('2026-11-24T00:00:00.000Z', now)).toBe(true)
  expect(hasMemberAccessExpired('garbage', now)).toBe(true)
})

/**
 * Builds a Workspace member for the successor list.
 *
 * @param memberKey - Member key and email.
 * @param fields - Role, status, and expiry to override.
 * @returns A Workspace member.
 */
function member(memberKey: string, fields: Partial<Pick<WorkspaceMember, 'role' | 'status' | 'accessExpiresAt'>> = {}): WorkspaceMember {
  return {
    id: memberKey,
    memberKey,
    email: memberKey,
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...fields,
  }
}

test('offers only active, unexpired non-guest members other than the leaver as successors', () => {
  const now = new Date('2026-11-24T00:00:00.000Z')
  const members = [
    member('leaver@example.com'),
    member('admin@example.com', { role: 'admin' }),
    member('later@example.com', { accessExpiresAt: '2026-12-01T00:00:00.000Z' }),
    // Expired members keep an active row until their own handover, but cannot be promoted.
    member('expired@example.com', { accessExpiresAt: '2026-11-23T00:00:00.000Z' }),
    member('guest@example.com', { role: 'guest' }),
    member('gone@example.com', { status: 'deactivated' }),
  ]

  expect(listOffboardingSuccessors('leaver@example.com', members, now).map((candidate) => candidate.memberKey))
    .toEqual(['admin@example.com', 'later@example.com'])
})

test('keeps an edited last day on the version it was based on, and refills an unedited one', () => {
  const base = { version: 3, lastDay: '2026-12-01' }
  const newer = { version: 4, accessExpiresAt: '2026-12-10T15:00:00.000Z' }

  // Unedited: the field follows the newer expiry and version.
  expect(followAccessExpiryDraft(base, '2026-12-01', newer)).toEqual({
    version: 4,
    lastDay: formatAccessExpiryLastDay(newer.accessExpiresAt),
  })
  // Edited: saving sends version 3, so the server reports the other administrator's change.
  expect(followAccessExpiryDraft(base, '2026-12-24', newer)).toBeUndefined()
  // Same version: nothing to follow.
  expect(followAccessExpiryDraft(base, '2026-12-01', { version: 3 })).toBeUndefined()
  // A refused save marks the base stale, so the next render refills the field.
  expect(followAccessExpiryDraft({ version: Number.NaN, lastDay: '2026-12-24' }, '2026-12-24', newer)?.version).toBe(4)
})
