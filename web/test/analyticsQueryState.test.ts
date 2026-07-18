import { describe, expect, test } from 'bun:test'
import {
  createDefaultAnalyticsFilter,
  parseAnalyticsRouteState,
  serializeAnalyticsRouteState,
} from '../src/analytics/queryState'

describe('Analytics report URL state', () => {
  test('round-trips report, snapshot, filters, timezone, and builder mode canonically', () => {
    const source = new URLSearchParams(
      'status=started&team=design-team&team=core-team&project=refero&assignee=sato%40example.com&customField=%7B%22value%22%3A%22high%22%2C%22operator%22%3A%22equals%22%2C%22fieldId%22%3A%22impact%22%7D&archived=1&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-17T23%3A59%3A59.999Z&baselineFrom=2026-07-01T00%3A00%3A00.000Z&baselineTo=2026-08-15T23%3A59%3A59.999Z&timezone=Asia%2FTokyo&report=delivery-health&snapshot=snapshot%2F7&edit=1',
    )
    const fallback = createDefaultAnalyticsFilter(new Date('2026-07-18T00:00:00.000Z'))
    const parsed = parseAnalyticsRouteState(source, fallback, 'UTC')
    const canonical = serializeAnalyticsRouteState(parsed)
    const restored = parseAnalyticsRouteState(canonical, fallback, 'UTC')

    expect(serializeAnalyticsRouteState(restored).toString()).toBe(
      canonical.toString(),
    )
    expect(canonical.getAll('team')).toEqual(['core-team', 'design-team'])
    expect(canonical.get('snapshot')).toBe('snapshot/7')
    expect(restored.forecastBaseline).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-15T23:59:59.999Z',
    })
    expect(canonical.get('timezone')).toBe('Asia/Tokyo')
    expect(canonical.get('edit')).toBe('1')
    expect(canonical.get('v')).toBe('1')
  })

  test('uses a stable inclusive 30-day UTC period when URL values are absent', () => {
    const filter = createDefaultAnalyticsFilter(
      new Date('2026-07-18T14:50:00.000Z'),
    )
    const state = parseAnalyticsRouteState(
      new URLSearchParams(),
      filter,
      'Asia/Tokyo',
    )

    expect(state.filter.period).toEqual({
      from: '2026-06-19T00:00:00.000Z',
      to: '2026-07-18T23:59:59.999Z',
    })
    expect(state.timezone).toBe('Asia/Tokyo')
    expect(state.builder).toBeFalse()
  })

  test('ignores malformed custom-field JSON without failing the report route', () => {
    const state = parseAnalyticsRouteState(
      new URLSearchParams('customField=%7Bnot-json'),
      createDefaultAnalyticsFilter(),
      'UTC',
    )

    expect(state.filter.customFields).toEqual([])
  })

  test('uses the local current day for a positive-offset timezone near UTC midnight', () => {
    const filter = createDefaultAnalyticsFilter(
      new Date('2026-07-18T15:30:00.000Z'),
      'Asia/Tokyo',
    )

    expect(filter.period).toEqual({
      from: '2026-06-19T15:00:00.000Z',
      to: '2026-07-19T14:59:59.999Z',
    })
  })

  test('uses the previous local day for a negative-offset timezone near UTC midnight', () => {
    const filter = createDefaultAnalyticsFilter(
      new Date('2026-07-18T01:00:00.000Z'),
      'America/Los_Angeles',
    )

    expect(filter.period).toEqual({
      from: '2026-06-18T07:00:00.000Z',
      to: '2026-07-18T06:59:59.999Z',
    })
  })
})
