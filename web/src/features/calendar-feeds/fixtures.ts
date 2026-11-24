import type { CalendarFeed } from '@mukuroji/contracts'
import type { CalendarFeedTeamOption } from './ui/CalendarFeedsPanel'

/** Teams offered for a Project feed in stories and tests. */
export const calendarFeedTeamsFixture: CalendarFeedTeamOption[] = [
  {
    id: 'core-team',
    name: 'Core',
    projects: [
      { id: 'refero', name: 'Refero' },
      { id: 'billing', name: '請求基盤の刷新' },
    ],
  },
]

/** Feeds of a member who has issued the member feed and one Project feed. */
export const calendarFeedsFixture: CalendarFeed[] = [
  {
    id: 'feed-member',
    kind: 'member',
    locale: 'ja',
    issuedAt: '2026-11-20T01:00:00.000Z',
    createdAt: '2026-11-01T01:00:00.000Z',
  },
  {
    id: 'feed-refero',
    kind: 'project',
    teamId: 'core-team',
    projectId: 'refero',
    locale: 'ja',
    issuedAt: '2026-11-22T03:30:00.000Z',
    createdAt: '2026-11-22T03:30:00.000Z',
  },
]

/** URL shown right after a feed is issued. */
export const issuedCalendarFeedUrlFixture =
  'https://mukuroji.example.com/api/public/calendar-feeds/dXNlciNkZW1v.Fu1M8Vb6AP_PiQEG4zxSNPMe5YR5ceY3QDHXSLTXIi0.ics'
