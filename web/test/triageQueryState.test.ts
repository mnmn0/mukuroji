import { describe, expect, test } from 'bun:test'
import { triageEntryFixtures } from '../src/triage/fixtures'
import {
  createTriageSearchParams,
  readTriageRouteState,
} from '../src/triage/model/queryState'
import {
  resolveTriageActionShortcut,
  resolveTriageNavigationIndex,
} from '../src/triage/model/keyboard'

describe('Team triage URL state', () => {
  test('parses and serializes selected entry plus supported filters', () => {
    const state = readTriageRouteState(new URLSearchParams(
      'entryId=entry%2F1&q=launch&state=pending&source=chat&owner=mine&sla=breached',
    ))

    expect(state).toEqual({
      entryId: 'entry/1',
      filters: {
        owner: 'mine',
        query: 'launch',
        sla: 'breached',
        source: 'chat',
        state: 'pending',
      },
      view: 'queue',
    })
    expect(createTriageSearchParams(state).toString()).toBe(
      'entryId=entry%2F1&q=launch&state=pending&source=chat&owner=mine&sla=breached',
    )
  })

  test('drops unsupported values and removes queue selection from settings', () => {
    const state = readTriageRouteState(new URLSearchParams(
      'view=settings&entryId=secret&state=unknown&source=sms&owner=everyone&sla=late',
    ))
    expect(state).toEqual({ filters: {}, entryId: 'secret', view: 'settings' })
    expect(createTriageSearchParams(state).toString()).toBe('view=settings')
  })
})

describe('Team triage keyboard model', () => {
  test('wraps queue row navigation and resolves Home and End', () => {
    expect(resolveTriageNavigationIndex(2, 'ArrowDown', 3)).toBe(0)
    expect(resolveTriageNavigationIndex(0, 'ArrowUp', 3)).toBe(2)
    expect(resolveTriageNavigationIndex(1, 'Home', 3)).toBe(0)
    expect(resolveTriageNavigationIndex(1, 'End', 3)).toBe(2)
  })

  test('opens only capability-backed action forms', () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    expect(resolveTriageActionShortcut('a', null, entry.capabilities)).toBe('accept')
    expect(resolveTriageActionShortcut('d', null, entry.capabilities)).toBe('duplicate')
    expect(resolveTriageActionShortcut('i', null, {
      ...entry.capabilities,
      canReply: false,
    })).toBeUndefined()
  })
})
