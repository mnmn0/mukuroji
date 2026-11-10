import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WORK_ITEM_TYPE } from '@mukuroji/contracts'
import { listTimeEntries, transitionTimeEntry, transitionTimesheet, updateTimeEntry } from '../src/features/time-tracking/api/timeEntries'
import { TimeTrackingApiError } from '../src/features/time-tracking/api/timeTrackingRequest'
import { getActiveTimer, stopTimer } from '../src/features/time-tracking/api/timers'
import { getTeamTimesheet } from '../src/features/time-tracking/api/teamTimesheet'
import { getTimeEstimate } from '../src/features/time-tracking/api/timeEstimates'
import {
  createTimeEntryFixture,
  timeTrackingFixtureEntries,
  timeTrackingFixtureEstimate,
  timeTrackingFixtureMemberNames,
  timeTrackingFixtureNow,
  timeTrackingFixtureRejectionReasons,
  timeTrackingFixtureTeamEntries,
  timeTrackingFixtureTeamTimesheet,
  timeTrackingFixtureTimer,
  timeTrackingFixtureWeekStart,
  timeTrackingFixtureWorkItems,
} from '../src/features/time-tracking/fixtures'
import {
  buildTimeEntryWeekRows,
  countTimeEntriesByStatus,
  groupTimeEntriesByMember,
  isTimerOverlong,
} from '../src/features/time-tracking/model/timeEntryLifecycle'
import {
  createWeekPeriod,
  formatElapsed,
  formatMinutes,
  parseHoursInput,
  resolveWeekStart,
  shiftWeek,
  toInstantFromLocal,
  toLocalDateKey,
} from '../src/features/time-tracking/model/timePeriod'
import { classifyTimeTrackingFailure, shouldRetainTimeTrackingMutation } from '../src/features/time-tracking/model/timeTrackingFailure'
import { PersonalTimesheet } from '../src/features/time-tracking/ui/PersonalTimesheet'
import { TimeApprovalQueue } from '../src/features/time-tracking/ui/TimeApprovalQueue'
import { WorkItemTimePanel } from '../src/features/time-tracking/ui/WorkItemTimePanel'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../src/shared/routing/paths'

const originalFetch = globalThis.fetch
// The local-date assertions below are written for Japan time; restore the zone for later files.
const originalTimeZone = process.env.TZ
process.env.TZ = 'Asia/Tokyo'
const t = createTranslator('en')
const formatters = createTimeTrackingFormatters('en')
const week = createWeekPeriod(timeTrackingFixtureWeekStart)
const workItemTitles = Object.fromEntries(timeTrackingFixtureWorkItems.map((item) => [item.id, item.title]))
const noop = async () => undefined

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimeZone
})

/** One request seen by the fetch mock. */
type RecordedRequest = { url: string; method: string; headers: Headers; body: unknown }

/**
 * Replaces fetch with one that answers every request with the same JSON body.
 *
 * @param body - Response body.
 * @param status - HTTP status.
 * @returns Requests seen by the mock.
 */
function respondWith(body: unknown, status = 200): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
  return requests
}

describe('time tracking periods', () => {
  test('builds a Monday-based local week and its instant range', () => {
    expect(resolveWeekStart('2026-11-12')).toBe('2026-11-09')
    expect(resolveWeekStart('2026-11-15')).toBe('2026-11-09')
    expect(resolveWeekStart('not-a-date', timeTrackingFixtureNow)).toBe('2026-11-09')
    expect(shiftWeek('2026-11-09', -1)).toBe('2026-11-02')
    expect(week.days).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'])
    expect(week.from).toBe('2026-11-08T15:00:00.000Z')
    expect(week.to).toBe('2026-11-15T15:00:00.000Z')
  })

  test('converts local inputs and formats durations', () => {
    expect(toInstantFromLocal('2026-11-10', '09:30')).toBe('2026-11-10T00:30:00.000Z')
    expect(toInstantFromLocal('2026-02-30', '09:30')).toBeUndefined()
    expect(toInstantFromLocal('2026-11-10', '24:00')).toBeUndefined()
    expect(toLocalDateKey('2026-11-09T15:30:00.000Z')).toBe('2026-11-10')
    expect(formatMinutes(90)).toBe('1:30')
    expect(formatMinutes(-5)).toBe('-0:05')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
    expect(parseHoursInput('1.5')).toBe(90)
    expect(parseHoursInput('2:15')).toBe(135)
    expect(parseHoursInput('-1')).toBeUndefined()
    expect(createTeamTimeTrackingPath('core team', 'approvals', '2026-11-09')).toBe('/teams/core%20team/timesheet?view=approvals&week=2026-11-09')
  })
})

describe('time tracking model', () => {
  test('builds the Work Item × day table and lifecycle counts', () => {
    const rows = buildTimeEntryWeekRows(timeTrackingFixtureEntries, week.days, toLocalDateKey)
    expect(rows).toEqual([
      { workItemId: 'onboarding', minutesByDate: { '2026-11-09': 90, '2026-11-10': 60, '2026-11-11': 45 }, totalMinutes: 195 },
      { workItemId: 'pricing', minutesByDate: { '2026-11-10': 120 }, totalMinutes: 120 },
    ])
    expect(countTimeEntriesByStatus(timeTrackingFixtureEntries)).toEqual({ draft: 1, submitted: 1, approved: 1, rejected: 1, locked: 0 })
  })

  test('groups submitted entries by member for approval', () => {
    const groups = groupTimeEntriesByMember(timeTrackingFixtureTeamEntries, 'submitted')
    expect(groups.map((group) => [group.userId, group.entries.map((entry) => entry.id), group.totalMinutes])).toEqual([
      ['aoi@example.com', ['entry-submitted'], 60],
      ['ren@example.com', ['entry-ren-submitted'], 180],
    ])
  })

  test('flags timers that are too long to record', () => {
    expect(isTimerOverlong('2026-11-01T00:00:00.000Z', timeTrackingFixtureNow)).toBe(true)
    expect(isTimerOverlong(timeTrackingFixtureTimer.startedAt, timeTrackingFixtureNow)).toBe(false)
  })

  test('keeps the idempotency key only for failures that may have been applied', () => {
    expect(classifyTimeTrackingFailure(new TimeTrackingApiError(0, 'offline', 'NetworkUnavailable'))).toBe('offline')
    expect(classifyTimeTrackingFailure(new TimeTrackingApiError(409, 'conflict', 'TimeEntryRevisionConflict'))).toBe('conflict')
    expect(classifyTimeTrackingFailure(new TimeTrackingApiError(403, 'denied'))).toBe('forbidden')
    expect(shouldRetainTimeTrackingMutation(new TimeTrackingApiError(0, 'offline'))).toBe(true)
    expect(shouldRetainTimeTrackingMutation(new TimeTrackingApiError(503, 'unavailable'))).toBe(true)
    expect(shouldRetainTimeTrackingMutation(new TimeTrackingApiError(409, 'busy', 'TimeTrackingMutationInProgress'))).toBe(true)
    expect(shouldRetainTimeTrackingMutation(new TimeTrackingApiError(409, 'conflict', 'TimeEntryRevisionConflict'))).toBe(false)
    expect(shouldRetainTimeTrackingMutation(new TimeTrackingApiError(400, 'invalid'))).toBe(false)
  })
})

describe('time tracking API', () => {
  const context = { idempotencyKey: 'key-1', correlationId: 'key-1' }

  test('lists entries for a period and validates them', async () => {
    const requests = respondWith({ entries: timeTrackingFixtureEntries })
    const entries = await listTimeEntries('token', 'core team', { from: week.from, to: week.to, userId: 'aoi@example.com' })
    expect(entries).toHaveLength(4)
    const url = new URL(requests[0]?.url ?? '', 'http://localhost')
    expect(url.pathname).toBe('/api/teams/core%20team/time-entries')
    expect(url.searchParams.get('userId')).toBe('aoi@example.com')
    expect(url.searchParams.get('from')).toBe(week.from)
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer token')
    respondWith({ entries: [{ id: 'broken' }] })
    await expect(listTimeEntries('token', 'core-team', week)).rejects.toMatchObject({ status: 502 })
  })

  test('sends the expected revision and idempotency key when editing and submitting', async () => {
    const entry = timeTrackingFixtureEntries[1] ?? createTimeEntryFixture({ id: 'missing' })
    let requests = respondWith({ entry: { ...entry, revision: 4, status: 'draft' } })
    await updateTimeEntry('token', entry, {
      workItemId: 'pricing',
      startAt: entry.startAt,
      endAt: entry.endAt,
      description: '  ',
      billable: true,
    }, context)
    expect(requests[0]?.method).toBe('PATCH')
    expect(requests[0]?.headers.get('Idempotency-Key')).toBe('key-1')
    expect(requests[0]?.body).toMatchObject({ expectedRevision: 3, description: null, billable: true })
    requests = respondWith({ entry: { ...entry, revision: 5, status: 'submitted' } })
    const submitted = await transitionTimeEntry('token', { ...entry, revision: 4 }, 'submit', context)
    expect(submitted.status).toBe('submitted')
    expect(requests[0]?.url).toEndWith('/time-entries/entry-rejected/submit')
    expect(requests[0]?.body).toEqual({ expectedRevision: 4 })
  })

  test('reports the entries a period-wide action could not change', async () => {
    const requests = respondWith({ count: 1, failedEntryIds: ['entry-ren-submitted'], partialFailure: true, entries: [timeTrackingFixtureEntries[2]] })
    const result = await transitionTimesheet('token', 'core-team', 'approve', week, context)
    expect(result).toMatchObject({ count: 1, failedEntryIds: ['entry-ren-submitted'], partialFailure: true })
    expect(requests[0]?.url).toEndWith('/teams/core-team/timesheet/approve')
    expect(requests[0]?.body).toEqual({ from: week.from, to: week.to })
  })

  test('recovers the running timer and stops it into a draft', async () => {
    respondWith({ timer: timeTrackingFixtureTimer })
    expect(await getActiveTimer('token')).toEqual(timeTrackingFixtureTimer)
    respondWith({ timer: null })
    expect(await getActiveTimer('token')).toBeNull()
    const requests = respondWith({ entry: createTimeEntryFixture({ id: 'from-timer', source: 'timer' }) })
    expect((await stopTimer('token', 'timer-1', context)).source).toBe('timer')
    expect(requests[0]?.url).toEndWith('/time-tracking/timers/timer-1/stop')
  })

  test('reads estimates and the manager signal of the Team timesheet', async () => {
    respondWith({ estimate: timeTrackingFixtureEstimate })
    expect(await getTimeEstimate('token', 'core-team', 'onboarding')).toEqual(timeTrackingFixtureEstimate)
    const requests = respondWith({ ...timeTrackingFixtureTeamTimesheet, costsRedacted: true })
    expect((await getTeamTimesheet('token', 'core-team', { ...week, timeZone: 'Asia/Tokyo' })).costsRedacted).toBe(true)
    expect(new URL(requests[0]?.url ?? '', 'http://localhost').searchParams.get('timeZone')).toBe('Asia/Tokyo')
  })

  test('reports a request that never reached the API as offline', async () => {
    globalThis.fetch = Object.assign(async () => {
      throw new TypeError('Failed to fetch')
    }, { preconnect: originalFetch.preconnect })
    await expect(getActiveTimer('token')).rejects.toMatchObject({ status: 0, code: 'NetworkUnavailable' })
  })
})

describe('time tracking views', () => {
  test('the Work Item panel shows estimate against actual and the running timer', () => {
    const html = renderToStaticMarkup(
      <WorkItemTimePanel
        actualMinutes={540}
        entries={timeTrackingFixtureEntries.filter((entry) => entry.workItemId === 'onboarding')}
        estimate={timeTrackingFixtureEstimate}
        formatters={formatters}
        now={timeTrackingFixtureNow}
        onCreateEntry={noop}
        onDiscardTimer={noop}
        onRetry={() => undefined}
        onSaveEstimate={noop}
        onStartTimer={noop}
        onStopTimer={noop}
        onSubmitEntry={noop}
        onUpdateEntry={noop}
        t={t}
        timer={timeTrackingFixtureTimer}
        timesheetHref="/teams/core-team/timesheet"
        workItemId="onboarding"
      />,
    )
    expect(html).toContain('8:00')
    expect(html).toContain('9:00')
    expect(html).toContain('Over')
    expect(html).toContain('0:45:00')
    expect(html).toContain('Stop and record')
    expect(html).not.toContain('Start timer')
    expect(html).toContain('href="/teams/core-team/timesheet"')
  })

  test('a timer on another Work Item blocks starting a second one', () => {
    const html = renderToStaticMarkup(
      <WorkItemTimePanel
        actualMinutes={0}
        entries={[]}
        estimate={null}
        formatters={formatters}
        now={timeTrackingFixtureNow}
        onCreateEntry={noop}
        onDiscardTimer={noop}
        onRetry={() => undefined}
        onSaveEstimate={noop}
        onStartTimer={noop}
        onStopTimer={noop}
        onSubmitEntry={noop}
        onUpdateEntry={noop}
        t={t}
        timer={timeTrackingFixtureTimer}
        workItemId="pricing"
      />,
    )
    expect(html).toContain(t('timeTracking.timer.runningElsewhere'))
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit">Start timer<\/button>/u)
    expect(html).toContain('Not set')
  })

  test('the timesheet lists the week, rejection reasons, and the week-wide submit', () => {
    const html = renderToStaticMarkup(
      <PersonalTimesheet
        entries={timeTrackingFixtureEntries}
        formatters={formatters}
        onCreateEntry={noop}
        onMoveWeek={() => undefined}
        onRetry={() => undefined}
        onSubmitEntry={noop}
        onSubmitWeek={async () => ({ count: 0, failedEntryIds: [], partialFailure: false, entries: [] })}
        onUpdateEntry={noop}
        rejectionReasons={timeTrackingFixtureRejectionReasons}
        t={t}
        today="2026-11-10"
        week={week}
        workItemOptions={timeTrackingFixtureWorkItems}
        workItemTitles={workItemTitles}
      />,
    )
    expect(html).toContain('data-testid="timesheet-week-table"')
    expect(html).toContain('Submit drafts (2)')
    expect(html).toContain('Split the pricing work from the onboarding interview.')
    expect(html).toContain('>Resubmit<')
    expect(html).toContain('Week total 5:15')
    // Approved entries are no longer editable.
    expect(html.match(/>Edit</gu)).toHaveLength(2)
  })

  test('the approval queue hides everything but a notice from non-managers', () => {
    const html = renderToStaticMarkup(
      <TimeApprovalQueue
        canManage={false}
        entries={[]}
        formatters={formatters}
        memberNames={timeTrackingFixtureMemberNames}
        onMoveWeek={() => undefined}
        onRetry={() => undefined}
        onTransitionEntry={noop}
        onTransitionWeek={async () => ({ count: 0, failedEntryIds: [], partialFailure: false, entries: [] })}
        t={t}
        week={week}
        workItemTitles={workItemTitles}
      />,
    )
    expect(html).toContain(t('timeTracking.approval.permissionDenied'))
    expect(html).not.toContain('Approve all submitted this week')
  })

  test('the approval queue groups submitted entries by member without showing costs', () => {
    const html = renderToStaticMarkup(
      <TimeApprovalQueue
        canManage
        entries={timeTrackingFixtureTeamEntries}
        formatters={formatters}
        memberNames={timeTrackingFixtureMemberNames}
        onMoveWeek={() => undefined}
        onRetry={() => undefined}
        onTransitionEntry={noop}
        onTransitionWeek={async () => ({ count: 0, failedEntryIds: [], partialFailure: false, entries: [] })}
        t={t}
        teamTimesheet={timeTrackingFixtureTeamTimesheet}
        week={week}
        workItemTitles={workItemTitles}
      />,
    )
    expect(html).toContain('Awaiting approval (2)')
    expect(html).toContain('Aoi Tanaka')
    expect(html).toContain('Ren Sato')
    expect(html).toContain('Approved, not locked (1)')
    expect(html).toContain('Locked this week: 1')
    expect(html).toContain('data-testid="team-timesheet-table"')
    expect(html).not.toContain('27000')
    expect(html).not.toContain('9000')
  })

  test('the default Work Item type includes the time section before activity', () => {
    const sections = DEFAULT_WORK_ITEM_TYPE.detailSections
    expect(sections.indexOf('time')).toBe(sections.indexOf('activity') - 1)
  })
})
