import { describe, expect, test } from 'bun:test'
import {
  getNextRecurringOccurrence,
  getRecurringOccurrences,
  selectCatchUpOccurrences,
  validateRecurringSchedule,
} from './recurring-schedule'

describe('Automation recurring schedule domain', () => {
  test('validates and normalizes weekly input without AWS or Hono', () => {
    expect(validateRecurringSchedule({
      frequency: 'weekly',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:30',
      startDate: '2026-07-01',
      daysOfWeek: [5, 1],
      catchUpPolicy: 'latest',
    })).toEqual({
      frequency: 'weekly',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:30',
      startDate: '2026-07-01',
      daysOfWeek: [1, 5],
      catchUpPolicy: 'latest',
    })
  })

  test('calculates a next local-time occurrence as UTC', () => {
    const next = getNextRecurringOccurrence({
      frequency: 'daily',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:00',
      startDate: '2026-07-01',
      catchUpPolicy: 'all',
    }, new Date('2026-07-21T23:59:59.000Z'))

    expect(next?.toISOString()).toBe('2026-07-22T00:00:00.000Z')
  })

  test('handles DST gaps and catch-up selection deterministically', () => {
    const occurrences = getRecurringOccurrences({
      frequency: 'daily',
      interval: 1,
      timeZone: 'America/New_York',
      localTime: '02:30',
      startDate: '2026-03-07',
      catchUpPolicy: 'all',
    }, new Date('2026-03-07T00:00:00.000Z'), new Date('2026-03-10T23:59:59.000Z'))

    expect(occurrences.map((value) => value.toISOString())).toContain(
      '2026-03-08T07:00:00.000Z',
    )
    expect(selectCatchUpOccurrences(occurrences, 'latest')).toEqual([
      occurrences[occurrences.length - 1],
    ])
  })
})
