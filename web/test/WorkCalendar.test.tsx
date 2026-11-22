import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkCalendarChangeImpact, WorkCalendarResponse } from '@mukuroji/contracts'
import { getWorkCalendar, readWorkCalendarChangeImpact, readWorkCalendarResponse } from '../src/workspace/api/workCalendar'
import {
  addWorkCalendarHoliday,
  createWorkCalendarDraft,
  removeWorkCalendarHoliday,
  setWorkCalendarWeekday,
  toWorkCalendarOverrides,
} from '../src/workspace/model/workCalendarDraft'
import { WorkCalendarPanel } from '../src/workspace/ui/WorkCalendarPanel'
import { createTranslator } from '../src/shared/i18n/i18n'
import { replaceTaskDeadlineSchedule, unscheduleTaskSchedule } from '../src/tasks/model/taskSchedule'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Team calendar response that inherits everything but one company day off. */
const teamResponse: WorkCalendarResponse = {
  scope: { kind: 'team', teamId: 'core-team' },
  calendar: {
    scope: { kind: 'team', teamId: 'core-team' },
    additionalHolidays: ['2026-12-09'],
    changeAdjustment: 'keep-end-date',
    revision: 2,
    updatedAt: '2026-11-22T00:00:00.000Z',
    updatedBy: 'user#owner@example.com',
  },
  changeAdjustment: 'keep-end-date',
  resolvedPolicy: {
    workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    holidays: ['2026-12-09'],
    timeZone: 'Asia/Tokyo',
    calendarSource: 'shared',
  },
  inheritedPolicy: {
    workingWeekdays: ['saturday'],
    holidays: [],
    timeZone: 'Asia/Tokyo',
    calendarSource: 'shared',
  },
  canManage: true,
}

/** Impact of a change that moves one Work Item. */
const impact: WorkCalendarChangeImpact = {
  adjustment: 'keep-end-date',
  followingCount: 2,
  changedCount: 1,
  fallbackToKeepDurationCount: 0,
  examples: [{
    teamId: 'core-team',
    workItemId: 'item-1',
    title: 'Design review',
    before: { startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 5 },
    after: { startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 4 },
  }],
}

describe('Team and Project calendars', () => {
  test('reads a calendar and rejects responses of another shape', async () => {
    const urls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return Response.json(teamResponse)
      },
      { preconnect: originalFetch.preconnect },
    )
    expect(await getWorkCalendar('token', 'core-team', 'project 1')).toEqual(teamResponse)
    expect(urls[0]).toEndWith('/api/teams/core-team/work-calendar?projectId=project%201')

    expect(readWorkCalendarResponse({ ...teamResponse, changeAdjustment: 'stretch' })).toBeUndefined()
    expect(readWorkCalendarResponse({ ...teamResponse, canManage: 'yes' })).toBeUndefined()
    expect(readWorkCalendarChangeImpact(impact)).toEqual(impact)
    expect(readWorkCalendarChangeImpact({ ...impact, changedCount: -1 })).toBeUndefined()
  })

  test('edits the inherited and overridden rules of a calendar', () => {
    const draft = createWorkCalendarDraft(teamResponse)
    expect(draft).toMatchObject({ inheritWorkingWeekdays: true, publicHolidays: 'inherit', adjustment: 'keep-end-date' })
    expect(toWorkCalendarOverrides(draft)).toEqual({ additionalHolidays: ['2026-12-09'] })

    const fourDays = setWorkCalendarWeekday({ ...draft, inheritWorkingWeekdays: false }, 'friday', false)
    expect(fourDays && toWorkCalendarOverrides({ ...fourDays, publicHolidays: 'none' })).toEqual({
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday'],
      publicHolidays: 'none',
      additionalHolidays: ['2026-12-09'],
    })
    const onlyMonday = { ...draft, workingWeekdays: ['monday' as const] }
    expect(setWorkCalendarWeekday(onlyMonday, 'monday', false)).toBeUndefined()

    const added = addWorkCalendarHoliday(draft, '2026-12-01')
    expect(added?.additionalHolidays).toEqual(['2026-12-01', '2026-12-09'])
    expect(addWorkCalendarHoliday(draft, '2026-12-09')).toBeUndefined()
    expect(addWorkCalendarHoliday(draft, '2026-02-30')).toBeUndefined()
    expect(removeWorkCalendarHoliday(draft, '2026-12-09').additionalHolidays).toEqual([])
  })

  test('shows the previewed Work Items and keeps the form read-only for members who cannot manage it', () => {
    const t = createTranslator('en')
    const props = {
      scopeOptions: [{ value: 'core-team', label: 'Core' }],
      selectedScope: 'core-team',
      calendar: teamResponse,
      draft: createWorkCalendarDraft(teamResponse),
      isLoading: false,
      impact,
      result: undefined,
      isBusy: false,
      t,
      onScopeChange() {},
      onDraftChange() {},
      onPreview() {},
      onSave() {},
      onRetry() {},
    }
    const markup = renderToStaticMarkup(<WorkCalendarPanel {...props} />)
    expect(markup).toContain('Design review')
    expect(markup).toContain('2026-12-09')
    // Inherited weekdays show the parent calendar, not the scope's own override.
    expect(markup).toMatch(/data-testid="work-calendar-weekday-saturday"[^>]*checked=""/)
    expect(markup).not.toMatch(/data-testid="work-calendar-weekday-monday"[^>]*checked=""/)

    const readOnly = renderToStaticMarkup(
      <WorkCalendarPanel {...props} calendar={{ ...teamResponse, canManage: false }} impact={undefined} />,
    )
    expect(readOnly).toContain(t('workspace.workCalendar.readOnly'))
  })

  test('keeps a Work Item on the shared calendar through ordinary schedule edits', () => {
    const schedule = {
      mode: 'due-date' as const,
      dueDate: '2026-12-11',
      calendarPolicy: teamResponse.resolvedPolicy,
    }
    expect(unscheduleTaskSchedule(schedule).calendarPolicy.calendarSource).toBe('shared')
    expect(replaceTaskDeadlineSchedule(schedule, '2026-12-14').calendarPolicy.calendarSource).toBe('shared')
  })
})
