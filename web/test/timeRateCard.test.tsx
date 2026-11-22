import { afterEach, describe, expect, test } from 'bun:test'
import type { TimeRateCard } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { getTimeRateCard, getTimeTrackingTeamSettings, saveTimeRateCard } from '../src/features/time-tracking/api/timeRateCard'
import { createTimeRateCardDraft, toSaveTimeRateCardRequest } from '../src/features/time-tracking/model/timeRateCard'
import { TimeRateCardPanel } from '../src/features/time-tracking/ui/TimeRateCardPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch
const t = createTranslator('en')

const storedCard: TimeRateCard = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  currency: 'JPY',
  memberRates: [
    { userId: 'member-1', jobRoleId: 'role-engineer' },
    { userId: 'member-2', hourlyRateMinor: 9_000 },
  ],
  jobRoleRates: [{ jobRoleId: 'role-engineer', hourlyRateMinor: 6_000 }],
  revision: 3,
  updatedAt: '2026-11-22T00:00:00.000Z',
  updatedBy: 'manager-1',
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

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('time rate card model', () => {
  test('round-trips a stored card through the editable draft', () => {
    const draft = createTimeRateCardDraft(storedCard)
    expect(draft).toEqual({
      currency: 'JPY',
      jobRoleRates: { 'role-engineer': '6000' },
      memberRates: {
        'member-1': { rate: '', jobRoleId: 'role-engineer' },
        'member-2': { rate: '9000', jobRoleId: '' },
      },
    })
    expect(toSaveTimeRateCardRequest(draft, 3)).toEqual({
      ok: true,
      request: {
        currency: 'JPY',
        memberRates: [
          { userId: 'member-1', jobRoleId: 'role-engineer' },
          { userId: 'member-2', hourlyRateMinor: 9_000 },
        ],
        jobRoleRates: [{ jobRoleId: 'role-engineer', hourlyRateMinor: 6_000 }],
        expectedRevision: 3,
      },
    })
  })

  test('drops cleared rows and rejects amounts the currency cannot hold', () => {
    const cleared = toSaveTimeRateCardRequest({
      currency: 'usd',
      jobRoleRates: { 'role-engineer': '' },
      memberRates: { 'member-1': { rate: '', jobRoleId: '' }, 'member-2': { rate: '45.50', jobRoleId: '' } },
    }, 0)
    expect(cleared).toEqual({
      ok: true,
      request: { currency: 'USD', memberRates: [{ userId: 'member-2', hourlyRateMinor: 4_550 }], jobRoleRates: [], expectedRevision: 0 },
    })
    expect(toSaveTimeRateCardRequest({ currency: 'JPY', jobRoleRates: { a: '12.5' }, memberRates: {} }, 0))
      .toEqual({ ok: false, reason: 'amount' })
    expect(toSaveTimeRateCardRequest({ currency: 'JP', jobRoleRates: {}, memberRates: {} }, 0))
      .toEqual({ ok: false, reason: 'currency' })
  })
})

describe('time rate card API', () => {
  test('reads settings and the card, and saves the whole card', async () => {
    respondWith({ defaultCurrency: 'JPY', canManageRateCard: true })
    expect(await getTimeTrackingTeamSettings('token', 'team-1')).toEqual({ defaultCurrency: 'JPY', canManageRateCard: true })

    const reads = respondWith({ rateCard: storedCard })
    expect(await getTimeRateCard('token', 'team-1')).toEqual(storedCard)
    expect(reads[0]?.url).toEndWith('/teams/team-1/time-rate-card')

    const writes = respondWith({ rateCard: { ...storedCard, revision: 4 } })
    const request = { currency: 'JPY', memberRates: [], jobRoleRates: [], expectedRevision: 3 }
    expect(await saveTimeRateCard('token', 'team-1', request)).toMatchObject({ revision: 4 })
    expect(writes[0]).toMatchObject({ method: 'PUT', body: request })
  })

  test('rejects a malformed card', async () => {
    respondWith({ rateCard: { ...storedCard, jobRoleRates: [{ jobRoleId: 'role-engineer', hourlyRateMinor: -1 }] } })
    await expect(getTimeRateCard('token', 'team-1')).rejects.toThrow()
  })
})

describe('time rate card panel', () => {
  test('lists job roles and members, and keeps rows for roles that are no longer offered', () => {
    const markup = renderToStaticMarkup(
      <TimeRateCardPanel
        jobRoles={[{ id: 'role-designer', name: 'Designer' }]}
        members={[{ id: 'member-1', name: 'Aoi' }, { id: 'member-3', name: 'Ren' }]}
        onRetry={() => undefined}
        onSave={async () => undefined}
        rateCard={storedCard}
        t={t}
      />,
    )
    expect(markup).toContain('Rate card')
    expect(markup).toContain('Designer')
    // The stored rate of a job role that is no longer configured stays editable under its ID.
    expect(markup).toContain('role-engineer')
    expect(markup).toContain('value="6000"')
    expect(markup).toContain('Aoi')
    expect(markup).toContain('Ren')
    // A member outside the Team's Projects keeps the stored row.
    expect(markup).toContain('member-2')
    expect(markup).toContain('value="9000"')
  })
})
