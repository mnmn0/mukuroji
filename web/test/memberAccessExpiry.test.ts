import { expect, test } from 'bun:test'
import {
  formatAccessExpiryLastDay,
  hasMemberAccessExpired,
  readAccessExpiryFromLastDay,
} from '../src/workspace/model/memberAccessExpiry'

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
