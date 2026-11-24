import { expect, test } from 'bun:test'
import { escapeText, foldLine, isCalendarFeedDate, renderCalendarFeed } from './icalendar'
import { calendarFeedName, toPlanningFeedEvent, toWorkItemFeedEvent } from './feed-events'

/** Calendar policy of the test schedules. */
const calendarPolicy = { timeZone: 'Asia/Tokyo', workingWeekdays: ['monday' as const], holidays: [] }

test('renders all-day events with an exclusive end date and CRLF lines', () => {
  const body = renderCalendarFeed({
    name: 'Mukuroji: 自分の予定',
    timeZone: 'Asia/Tokyo',
    refreshIntervalMinutes: 60,
    generatedAt: new Date('2026-11-24T01:02:03.456Z'),
    events: [
      { uid: 'a@mukuroji', startDate: '2026-12-31', endDate: '2026-12-31', summary: 'Year end', sequence: 3 },
      { uid: 'b@mukuroji', startDate: '2026-02-27', endDate: '2026-03-01', summary: 'Span' },
      // Invalid and reversed dates are left out.
      { uid: 'c@mukuroji', startDate: '2026-02-30', endDate: '2026-02-30', summary: 'Invalid' },
      { uid: 'd@mukuroji', startDate: '2026-03-02', endDate: '2026-03-01', summary: 'Reversed' },
    ],
  })
  expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true)
  expect(body.split('\r\n').every((line) => !line.includes('\n'))).toBe(true)
  expect(body).toContain('DTSTAMP:20261124T010203Z')
  expect(body).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101')
  expect(body).toContain('SEQUENCE:3')
  expect(body).toContain('DTSTART;VALUE=DATE:20260227\r\nDTEND;VALUE=DATE:20260302')
  expect(body).not.toContain('Invalid')
  expect(body).not.toContain('Reversed')
  expect(body).toContain('X-WR-TIMEZONE:Asia/Tokyo')
})

test('escapes text values and drops control characters', () => {
  expect(escapeText('a,b;c\\d\r\ne\u0007')).toBe(String.raw`a\,b\;c\\d\ne`)
})

test('folds long lines at 75 octets without splitting a character', () => {
  const line = `SUMMARY:${'あ'.repeat(40)}`
  const folded = foldLine(line)
  const parts = folded.split('\r\n')
  expect(parts.length).toBeGreaterThan(1)
  const encoder = new TextEncoder()
  for (const part of parts) expect(encoder.encode(part).length).toBeLessThanOrEqual(75)
  expect(parts.map((part, index) => index === 0 ? part : part.slice(1)).join('')).toBe(line)
  expect(foldLine('SHORT:x')).toBe('SHORT:x')
})

test('validates calendar dates', () => {
  expect(isCalendarFeedDate('2028-02-29')).toBe(true)
  expect(isCalendarFeedDate('2027-02-29')).toBe(false)
  expect(isCalendarFeedDate('2027-1-01')).toBe(false)
  expect(isCalendarFeedDate(undefined)).toBe(false)
})

test('maps each Work Item schedule mode and each Planning type to an event', () => {
  const base = { id: 'w1', teamId: 'core team', key: 'CORE-1', title: 'Ship', revision: 4 }
  expect(toWorkItemFeedEvent({ ...base, schedule: { mode: 'unscheduled', calendarPolicy } }, 'ja')).toBeUndefined()
  expect(toWorkItemFeedEvent({ ...base, schedule: { mode: 'due-date', dueDate: '2026-12-01', calendarPolicy } }, 'ja'))
    .toEqual({
      uid: 'work-item.core%20team.w1@mukuroji',
      sequence: 4,
      startDate: '2026-12-01',
      endDate: '2026-12-01',
      summary: '期限: CORE-1 Ship',
    })
  expect(toWorkItemFeedEvent({
    ...base,
    key: undefined,
    schedule: { mode: 'date-range', startDate: '2026-12-01', endDate: '2026-12-04', durationDays: 4, calendarPolicy },
  }, 'en')).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-04', summary: 'Ship' })
  expect(toWorkItemFeedEvent({
    ...base,
    schedule: { mode: 'milestone', startDate: '2026-12-05', endDate: '2026-12-05', durationDays: 0, calendarPolicy },
  }, 'en')).toMatchObject({ startDate: '2026-12-05', summary: '◆ CORE-1 Ship' })

  const range = { startDate: '2026-12-01', endDate: '2026-12-14' }
  expect(toPlanningFeedEvent({ id: 'm1', type: 'milestone', title: 'GA', forecast: range }, 'en'))
    .toEqual({ uid: 'planning.m1@mukuroji', startDate: '2026-12-14', endDate: '2026-12-14', summary: '◆ Milestone: GA' })
  expect(toPlanningFeedEvent({ id: 'c1', type: 'cycle', title: 'Sprint', forecast: range }, 'ja'))
    .toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-14', summary: 'Cycle: Sprint' })
  expect(toPlanningFeedEvent({ id: 'g1', type: 'goal', title: 'Goal', forecast: range }, 'ja')).toBeUndefined()

  expect(calendarFeedName('member', 'en')).toBe('Mukuroji: My schedule')
  expect(calendarFeedName('project', 'ja', 'Refero')).toBe('Mukuroji: Refero')
})
