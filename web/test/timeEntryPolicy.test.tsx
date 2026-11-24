import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_TEAM_TIME_ENTRY_POLICY } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTimeEntry } from '../src/features/time-tracking/api/timeEntries'
import { getTeamTimeEntryPolicy, readTeamTimeEntryPolicyView, saveTeamTimeEntryPolicy } from '../src/features/time-tracking/api/timeEntryPolicy'
import { TimeTrackingApiError } from '../src/features/time-tracking/api/timeTrackingRequest'
import { createTimeEntryFixture } from '../src/features/time-tracking/fixtures'
import { classifyTimeTrackingFailure } from '../src/features/time-tracking/model/timeTrackingFailure'
import { parseDailyLimitHours } from '../src/features/time-tracking/model/timeEntryPolicy'
import { TimeEntryPolicyPanel } from '../src/features/time-tracking/ui/TimeEntryPolicyPanel'
import {
  createTimeTrackingFormatters,
  describeSavedTimeEntry,
  describeTimeTrackingFailure,
} from '../src/features/time-tracking/ui/timeTrackingText'

const t = createTranslator('en')
const formatters = createTimeTrackingFormatters('en')
const originalFetch = globalThis.fetch
const context = { idempotencyKey: 'key-1' }

/** One request the stubbed fetch received. */
type RecordedRequest = {
  /** Request URL. */
  url: string
  /** HTTP method. */
  method: string
  /** Parsed JSON body. */
  body: unknown
}

/**
 * Replaces fetch with one that records requests and answers with a fixed JSON body.
 *
 * @param body - Response body.
 * @param status - Response status.
 * @returns Requests received.
 */
function respondWith(body: unknown, status = 200): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
  return requests
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

const policyRecord = { ...DEFAULT_TEAM_TIME_ENTRY_POLICY, teamId: 'core-team', revision: 0 }

describe('Team time entry checks', () => {
  test('reads and saves the policy with its revision', async () => {
    let requests = respondWith({ policy: policyRecord, canEdit: true })
    expect(await getTeamTimeEntryPolicy('token', 'core-team')).toEqual({ policy: policyRecord, canEdit: true })
    expect(requests[0]?.url).toEndWith('/teams/core-team/time-entry-policy')

    const saved = { overlap: 'reject', dailyLimit: 'warn', dailyLimitMinutes: 480, teamId: 'core-team', revision: 1, updatedAt: '2026-11-22T00:00:00.000Z' } as const
    requests = respondWith({ policy: saved, canEdit: true })
    expect((await saveTeamTimeEntryPolicy('token', 'core-team', { overlap: 'reject', dailyLimit: 'warn', dailyLimitMinutes: 480, expectedRevision: 0 })).policy).toEqual(saved)
    expect(requests[0]).toMatchObject({ method: 'PUT', body: { overlap: 'reject', dailyLimit: 'warn', dailyLimitMinutes: 480, expectedRevision: 0 } })
  })

  test('rejects a malformed policy response', async () => {
    expect(readTeamTimeEntryPolicyView({ policy: { ...policyRecord, overlap: 'sometimes' }, canEdit: true })).toBeUndefined()
    expect(readTeamTimeEntryPolicyView({ policy: policyRecord })).toBeUndefined()
    respondWith({ policy: { ...policyRecord, dailyLimitMinutes: 2000 }, canEdit: false })
    await expect(getTeamTimeEntryPolicy('token', 'core-team')).rejects.toMatchObject({ status: 502 })
  })

  test('returns warnings with a saved entry and drops unknown kinds', async () => {
    const entry = createTimeEntryFixture({ id: 'entry-new' })
    respondWith({
      entry,
      warnings: [
        { code: 'TimeEntryOverlap', entryIds: ['entry-old'] },
        { code: 'TimeEntryDailyLimitExceeded', date: '2026-11-10', minutes: 660, limitMinutes: 600 },
        { code: 'SomethingNew' },
      ],
    })
    const saved = await createTimeEntry('token', 'core-team', {
      workItemId: 'item-1', startAt: '2026-11-10T00:00:00.000Z', endAt: '2026-11-10T01:00:00.000Z', description: '', billable: false,
    }, context)
    expect(saved.entry.id).toBe('entry-new')
    expect(saved.warnings.map((warning) => warning.code)).toEqual(['TimeEntryOverlap', 'TimeEntryDailyLimitExceeded'])
    const text = describeSavedTimeEntry(t, formatters, t('timeTracking.entry.created'), saved)
    expect(text).toStartWith(t('timeTracking.entry.created'))
    expect(text).toContain(t('timeTracking.warning.overlap'))
    expect(text).toContain('11:00')
    expect(describeSavedTimeEntry(t, formatters, 'Saved.', { entry, warnings: [] })).toBe('Saved.')
  })

  test('explains a rejected save', () => {
    const overlap = new TimeTrackingApiError(409, 'Overlaps.', 'TimeEntryOverlap')
    const daily = new TimeTrackingApiError(409, 'Too long.', 'TimeEntryDailyLimitExceeded')
    expect(classifyTimeTrackingFailure(overlap)).toBe('overlap')
    expect(classifyTimeTrackingFailure(daily)).toBe('dailyLimit')
    expect(describeTimeTrackingFailure(t, overlap)).toBe(t('timeTracking.error.overlap'))
    expect(describeTimeTrackingFailure(t, daily)).toBe(t('timeTracking.error.dailyLimit'))
  })

  test('reads the daily limit in hours', () => {
    expect(parseDailyLimitHours('7.5')).toBe(450)
    expect(parseDailyLimitHours(' 24 ')).toBe(1440)
    expect(parseDailyLimitHours('24.5')).toBeUndefined()
    expect(parseDailyLimitHours('0')).toBeUndefined()
    expect(parseDailyLimitHours('-1')).toBeUndefined()
    expect(parseDailyLimitHours('ten')).toBeUndefined()
  })

  test('shows the checks read-only to a member who does not manage the whole Team', () => {
    const noop = async () => undefined
    const editable = renderToStaticMarkup(<TimeEntryPolicyPanel onRetry={() => undefined} onSave={noop} t={t} view={{ policy: policyRecord, canEdit: true }} />)
    expect(editable).toContain(t('timeTracking.policy.save'))
    const readOnly = renderToStaticMarkup(<TimeEntryPolicyPanel onRetry={() => undefined} onSave={noop} t={t} view={{ policy: policyRecord, canEdit: false }} />)
    expect(readOnly).not.toContain(t('timeTracking.policy.save'))
    expect(readOnly).toContain(t('timeTracking.policy.readOnly'))
    expect(readOnly).toContain('disabled')
  })
})
