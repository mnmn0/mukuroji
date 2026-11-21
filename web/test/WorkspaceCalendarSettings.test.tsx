import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TenantAdministrationSnapshot } from '@mukuroji/contracts'
import { getWorkspaceCalendarSettings } from '../src/workspace/api/tenantAdministration'
import { workspaceCalendarErrorMessageKey } from '../src/workspace/queries/useWorkspaceCalendarSettings'
import { createWorkspaceTaskScheduleCalendarPolicy } from '../src/tasks/model/taskSchedule'
import {
  addWorkspaceHoliday,
  removeWorkspaceHoliday,
  setWorkspaceWorkingWeekday,
} from '../src/workspace/model/workspaceWorkingCalendar'
import { TenantAdministrationPanel } from '../src/workspace/ui/TenantAdministrationPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one fixed JSON response and records the requested URLs.
 *
 * @param body - JSON body to return.
 * @param status - HTTP status to return.
 * @returns The URLs requested through the mock.
 */
function mockFetch(body: unknown, status = 200): string[] {
  const urls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return Response.json(body, { status })
    },
    { preconnect: originalFetch.preconnect },
  )
  return urls
}

const snapshot = {
  schemaVersion: 3,
  profile: {
    workspaceId: 'workspace-1',
    ownerMemberKey: 'owner@example.com',
    region: 'ap-northeast-1',
    locale: 'ja',
    defaultPolicy: { defaultMemberRole: 'member' },
    calendar: {
      fiscalYearStartMonth: 4,
      weekStartDay: 0,
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      holidays: ['2027-01-01', '2027-05-03'],
      publicHolidays: 'none',
    },
    status: 'active',
    revision: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  recentOperations: [],
  governance: {
    workspaceId: 'workspace-1',
    auditRetentionDays: 365,
    legalHold: false,
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedBy: 'owner@example.com',
  },
  governanceEnforcement: {
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
  },
} satisfies TenantAdministrationSnapshot

describe('Workspace calendar settings', () => {
  test('reads the settings every member uses and rejects a malformed response', async () => {
    const urls = mockFetch({
      fiscalYearStartMonth: 4,
      weekStartDay: 1,
      workingWeekdays: ['tuesday', 'monday'],
      holidays: ['2027-05-03', '2027-01-01'],
    })
    // Settings saved before national holidays existed use the Japanese ones.
    expect(await getWorkspaceCalendarSettings('token-1')).toEqual({
      fiscalYearStartMonth: 4,
      weekStartDay: 1,
      workingWeekdays: ['monday', 'tuesday'],
      holidays: ['2027-01-01', '2027-05-03'],
      publicHolidays: 'japan',
    })
    expect(urls[0]?.endsWith('/workspace/calendar-settings')).toBe(true)

    // The national holiday dates the server synced from the Cabinet Office come with the settings.
    mockFetch({
      fiscalYearStartMonth: 4,
      weekStartDay: 1,
      nationalHolidayDates: ['2028-01-10', '2028-01-01'],
    })
    expect((await getWorkspaceCalendarSettings('token-1')).nationalHolidayDates).toEqual(['2028-01-01', '2028-01-10'])
    // A malformed list is dropped so the bundled national holidays are used instead.
    mockFetch({ fiscalYearStartMonth: 4, weekStartDay: 1, nationalHolidayDates: ['2028-02-30'] })
    expect(await getWorkspaceCalendarSettings('token-1')).not.toHaveProperty('nationalHolidayDates')

    mockFetch({ fiscalYearStartMonth: 13, weekStartDay: 1 })
    await expect(getWorkspaceCalendarSettings('token-1')).rejects.toThrow()

    mockFetch({ fiscalYearStartMonth: 4, weekStartDay: 1, holidays: ['2027-13-01'] })
    await expect(getWorkspaceCalendarSettings('token-1')).rejects.toThrow()

    mockFetch({ fiscalYearStartMonth: 4, weekStartDay: 1, publicHolidays: 'us' })
    await expect(getWorkspaceCalendarSettings('token-1')).rejects.toThrow()
  })

  test('shows the stored fiscal year start month and week start day to administrators', () => {
    const noop = () => undefined
    const html = renderToStaticMarkup(
      <TenantAdministrationPanel
        actionError={undefined}
        activeOperation={undefined}
        closureConfirmation=""
        data={snapshot}
        exportFormat="jsonl"
        governance={snapshot.governance}
        isSaving={false}
        locale="ja"
        onChangeClosureConfirmation={noop}
        onChangeExportFormat={noop}
        onChangeGovernance={noop}
        onChangeProfile={noop}
        onPauseOperation={noop}
        onRequestClosure={noop}
        onRequestExport={noop}
        onResumeOperation={noop}
        onSaveGovernance={noop}
        onSaveProfile={noop}
        onVerifyClosure={noop}
        profile={snapshot.profile}
        t={createTranslator('ja')}
      />,
    )
    expect(html).toContain('会計年度の開始月')
    expect(html).toContain('<option value="4" selected="">4月</option>')
    expect(html).toContain('<option value="0" selected="">日曜日</option>')
    // Working weekdays and company holidays are edited next to the fiscal year settings.
    expect(html).toContain('稼働曜日')
    expect(html).toMatch(/data-testid="tenant-working-weekday-saturday"[^>]*checked/u)
    expect(html).not.toMatch(/data-testid="tenant-working-weekday-sunday"[^>]*checked/u)
    expect(html).toContain('<time dateTime="2027-01-01">2027-01-01</time>')
    expect(html).toContain('休日 2027-05-03 を削除')
    expect(html).toContain('日本の祝日を休日にする')
    expect(html).not.toMatch(/data-testid="tenant-public-holidays"[^>]*checked/u)
  })

  test('edits working weekdays and holidays without leaving the Workspace without working days', () => {
    const calendar = {
      fiscalYearStartMonth: 1,
      weekStartDay: 1 as const,
      workingWeekdays: ['tuesday' as const],
      holidays: ['2027-05-03'],
      publicHolidays: 'none' as const,
    }
    expect(setWorkspaceWorkingWeekday(calendar, 'monday', true)?.workingWeekdays)
      .toEqual(['monday', 'tuesday'])
    // Unchecking the only working weekday is refused.
    expect(setWorkspaceWorkingWeekday(calendar, 'tuesday', false)).toBeUndefined()

    expect(addWorkspaceHoliday(calendar, '2027-01-01')?.holidays).toEqual(['2027-01-01', '2027-05-03'])
    expect(addWorkspaceHoliday(calendar, '2027-05-03')).toBeUndefined()
    expect(addWorkspaceHoliday(calendar, '')).toBeUndefined()
    expect(addWorkspaceHoliday(calendar, '2027-02-30')).toBeUndefined()
    const full = {
      ...calendar,
      holidays: Array.from({ length: 512 }, (_, index) =>
        new Date(Date.UTC(2027, 0, 1 + index)).toISOString().slice(0, 10)),
    }
    expect(addWorkspaceHoliday(full, '2030-01-01')).toBeUndefined()

    expect(removeWorkspaceHoliday(calendar, '2027-05-03').holidays).toEqual([])
    // The edited copies never change the settings being edited.
    expect(calendar.holidays).toEqual(['2027-05-03'])
  })

  test('maps the Workspace calendar to the policy new Work Items use', () => {
    expect(createWorkspaceTaskScheduleCalendarPolicy(snapshot.profile.calendar)).toEqual({
      holidays: ['2027-01-01', '2027-05-03'],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    })
    // With the Japanese national holidays on, they are days off next to the company holidays.
    const withNationalHolidays = createWorkspaceTaskScheduleCalendarPolicy({
      ...snapshot.profile.calendar,
      publicHolidays: 'japan',
    })
    expect(withNationalHolidays.holidays).toContain('2027-01-01')
    expect(withNationalHolidays.holidays).toContain('2026-11-23')
    expect(withNationalHolidays.holidays).toContain('2027-05-03')
    expect(withNationalHolidays.holidays.filter((date) => date === '2027-05-03')).toHaveLength(1)
    // The synced national holiday dates replace the bundled ones.
    expect(createWorkspaceTaskScheduleCalendarPolicy({
      ...snapshot.profile.calendar,
      publicHolidays: 'japan',
      nationalHolidayDates: ['2028-01-01'],
    }).holidays).toEqual(['2027-01-01', '2027-05-03', '2028-01-01'])
    // Before the settings load, new Work Items keep the Monday-to-Friday default.
    expect(createWorkspaceTaskScheduleCalendarPolicy(undefined)).toEqual({
      holidays: [],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    })
  })

  test('names the calendar in use when a read fails', () => {
    expect(workspaceCalendarErrorMessageKey({ settings: undefined, error: undefined })).toBeUndefined()
    expect(workspaceCalendarErrorMessageKey({ settings: undefined, error: new Error('offline') }))
      .toBe('tasks.workspaceCalendar.error')
    // A failed reload keeps the settings read earlier, so the notice says so.
    expect(workspaceCalendarErrorMessageKey({ settings: snapshot.profile.calendar, error: new Error('offline') }))
      .toBe('tasks.workspaceCalendar.staleError')
  })
})
