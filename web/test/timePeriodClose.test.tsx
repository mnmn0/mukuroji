import { afterEach, describe, expect, test } from 'bun:test'
import type { TimePeriodClose } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  closeWorkspaceTimePeriod,
  getTeamTimePeriods,
  getWorkspaceTimePeriod,
  reopenTeamTimePeriod,
} from '../src/features/time-tracking/api/timePeriods'
import { TimePeriodClosePanel, type TimePeriodClosePanelProps } from '../src/features/time-tracking/ui/TimePeriodClosePanel'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch
const t = createTranslator('en')

const julyClose: TimePeriodClose = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  month: '2026-07',
  timeZone: 'Asia/Tokyo',
  closedBy: 'manager-1',
  closedAt: '2026-08-02T03:00:00.000Z',
}

/** One request seen by the fetch mock. */
type RecordedRequest = {
  /** Requested URL. */
  url: string
  /** HTTP method. */
  method: string
  /** Parsed JSON body, when one was sent. */
  body: unknown
}

/**
 * Replaces fetch with a mock that records requests and answers with one body.
 *
 * @param body - Response body.
 * @returns Requests seen by the mock.
 */
function respondWith(body: unknown): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(body), { status: 200 })
  }, { preconnect: originalFetch.preconnect })
  return requests
}

/**
 * Renders the month close view with defaults that tests override.
 *
 * @param overrides - Props to change.
 * @returns Static markup.
 */
function renderPanel(overrides: Partial<TimePeriodClosePanelProps>): string {
  const reject = async () => { throw new Error('not called') }
  return renderToStaticMarkup(
    <TimePeriodClosePanel
      defaultMonth="2026-07"
      formatMonth={(month) => `M:${month}`}
      formatters={createTimeTrackingFormatters('en')}
      onCloseMonth={reject}
      onCloseWorkspaceMonth={reject}
      onReopenMonth={reject}
      onReopenWorkspaceMonth={reject}
      onRetry={() => undefined}
      onRetryWorkspace={() => undefined}
      onWorkspaceMonthChange={() => undefined}
      t={t}
      teamNames={{ 'team-1': 'Growth', 'team-2': 'Platform' }}
      timeZone="Asia/Tokyo"
      workspaceMonth="2026-07"
      {...overrides}
    />,
  )
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('month close API', () => {
  test('reads a Team list with its permissions and rejects a malformed close', async () => {
    respondWith({ closedPeriods: [julyClose], canManagePeriods: true, canManageWorkspacePeriods: false })
    expect(await getTeamTimePeriods('token', 'team-1')).toEqual({
      closedPeriods: [julyClose],
      canManagePeriods: true,
      canManageWorkspacePeriods: false,
    })
    respondWith({ closedPeriods: [{ ...julyClose, month: 7 }] })
    await expect(getTeamTimePeriods('token', 'team-1')).rejects.toThrow()
  })

  test('sends the reopen reason and the Workspace close timezone', async () => {
    const reopenRequests = respondWith({ period: julyClose })
    await reopenTeamTimePeriod('token', 'team-1', '2026-07', 'Late corrections')
    expect(reopenRequests[0]).toMatchObject({
      method: 'POST',
      body: { reason: 'Late corrections' },
    })
    expect(reopenRequests[0]?.url.endsWith('/teams/team-1/time-periods/2026-07/reopen')).toBe(true)

    const closeRequests = respondWith({
      month: '2026-07',
      results: [{ teamId: 'team-1', status: 'closed' }, { teamId: 'team-2', status: 'already-closed' }],
      partialFailure: false,
    })
    expect(await closeWorkspaceTimePeriod('token', '2026-07', 'Asia/Tokyo')).toEqual({
      month: '2026-07',
      results: [{ teamId: 'team-1', status: 'closed' }, { teamId: 'team-2', status: 'already-closed' }],
      partialFailure: false,
    })
    expect(closeRequests[0]?.url.endsWith('/time-periods/2026-07/close')).toBe(true)
    expect(closeRequests[0]?.body).toEqual({ timeZone: 'Asia/Tokyo' })

    respondWith({ month: '2026-07', results: [{ teamId: 'team-1', status: 'unknown' }], partialFailure: false })
    await expect(closeWorkspaceTimePeriod('token', '2026-07', 'UTC')).rejects.toThrow()
  })

  test('reads each Team of a Workspace month', async () => {
    respondWith({ month: '2026-07', teams: [{ teamId: 'team-1', close: julyClose }, { teamId: 'team-2' }] })
    expect(await getWorkspaceTimePeriod('token', '2026-07')).toEqual({
      month: '2026-07',
      teams: [{ teamId: 'team-1', close: julyClose }, { teamId: 'team-2' }],
    })
  })
})

describe('month close view', () => {
  test('a whole-Team manager sees the close form and a reopen action for each closed month', () => {
    const markup = renderPanel({ periods: { closedPeriods: [julyClose], canManagePeriods: true, canManageWorkspacePeriods: false } })
    expect(markup).toContain('Close this month')
    expect(markup).toContain('type="month"')
    expect(markup).toContain('M:2026-07')
    expect(markup).toContain('aria-label="Reopen M:2026-07"')
    expect(markup).toContain('Month boundaries use Asia/Tokyo')
    expect(markup).not.toContain('data-testid="workspace-time-period"')
  })

  test('another member sees the closed months without actions', () => {
    const markup = renderPanel({ periods: { closedPeriods: [julyClose], canManagePeriods: false, canManageWorkspacePeriods: false } })
    expect(markup).toContain('Only a manager of the whole Team can close and reopen months.')
    expect(markup).toContain('M:2026-07')
    expect(markup).not.toContain('Close this month')
    expect(markup).not.toContain('Reopen M:2026-07')
  })

  test('a Workspace administrator sees every Team of the month', () => {
    const markup = renderPanel({
      periods: { closedPeriods: [], canManagePeriods: false, canManageWorkspacePeriods: true },
      workspaceState: { month: '2026-07', teams: [{ teamId: 'team-1', close: julyClose }, { teamId: 'team-2' }] },
    })
    expect(markup).toContain('Close for every Team')
    expect(markup).toContain('Reopen for every Team')
    expect(markup).toContain('1 of 2 Teams closed')
    expect(markup).toContain('Growth')
    expect(markup).toContain('Platform')
  })

  test('a failed read shows a retry instead of an empty list', () => {
    const markup = renderPanel({ hasLoadError: true })
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Closed months could not be loaded.')
    expect(markup).not.toContain('No month is closed.')
  })
})
