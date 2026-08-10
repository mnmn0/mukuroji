import { describe, expect, test } from 'bun:test'
import { triageEntryFixtures } from '../src/triage/fixtures'
import {
  countTriageEntryViews,
  createTriageEntryView,
  filterTriageEntryViews,
  resolveTriageSlaState,
} from '../src/triage/model/triageView'

describe('triage presentation model', () => {
  test('removes source content from restricted permission projections', () => {
    const metadataOnly = triageEntryFixtures.find((entry) => entry.id === 'triage-email-1')
    const denied = triageEntryFixtures.find((entry) => entry.id === 'triage-webhook-denied')

    if (!metadataOnly || !denied) throw new Error('Expected permission fixtures.')

    const metadataOnlyView = createTriageEntryView(metadataOnly)
    const deniedView = createTriageEntryView(denied)
    expect(metadataOnlyView.body).toBeUndefined()
    expect(metadataOnlyView.title).toBe('Invoice workspace reference')
    expect(deniedView.body).toBeUndefined()
    expect(deniedView.title).toBeUndefined()
  })

  test('does not match free-text filters against denied source title or body', () => {
    expect(filterTriageEntryViews(
      triageEntryFixtures,
      { query: 'denied title' },
      [],
      new Date('2026-08-09T01:30:00.000Z'),
    )).toHaveLength(0)
  })

  test('derives owner and SLA filters plus queue metrics from visible entries', () => {
    const dueSoonEntry = triageEntryFixtures[1]
    if (!dueSoonEntry) throw new Error('Expected an SLA fixture.')
    const breached = filterTriageEntryViews(
      triageEntryFixtures,
      { owner: 'unowned', sla: 'breached' },
      [],
      new Date('2026-08-09T01:30:00.000Z'),
    )

    expect(breached.map((view) => view.entry.id)).toEqual(['triage-chat-1'])
    expect(countTriageEntryViews(breached)).toEqual({
      breached: 1,
      pending: 1,
      unowned: 1,
    })
    expect(resolveTriageSlaState(
      dueSoonEntry,
      new Date('2026-08-09T01:30:00.000Z'),
    )).toBe('due-soon')
    if (!dueSoonEntry.sla) throw new Error('Expected an SLA fixture.')
    expect(resolveTriageSlaState({
      ...dueSoonEntry,
      state: 'snoozed',
      sla: {
        ...dueSoonEntry.sla,
        breachedAt: '2026-08-09T01:00:00.000Z',
      },
    })).toBe('breached')
  })
})
