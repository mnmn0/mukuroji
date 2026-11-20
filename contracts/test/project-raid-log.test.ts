import { describe, expect, test } from 'bun:test'
import {
  deriveProjectRaidSeverity,
  parseProjectRaidEntry,
  parseProjectRaidEntryInput,
  parseProjectRaidEntryResponse,
  parseProjectRaidLogResponse,
  summarizeProjectRaidLog,
  type ProjectRaidEntry,
} from '../src/project-raid-log'

/**
 * Builds a stored entry for summary tests.
 *
 * @param overrides - Fields replacing the open, medium risk defaults.
 * @returns One entry.
 */
function entry(overrides: Partial<ProjectRaidEntry> = {}): ProjectRaidEntry {
  return {
    id: 'entry-1',
    kind: 'risk',
    title: 'Vendor delay',
    probability: 3,
    impact: 3,
    status: 'open',
    revision: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseProjectRaidEntryInput', () => {
  test('normalizes text and drops empty optional fields', () => {
    expect(parseProjectRaidEntryInput({
      kind: 'risk',
      title: '  Vendor delay ',
      description: ' ',
      probability: 4,
      impact: 5,
      response: ' Add a second vendor ',
      reviewDueDate: '',
      status: 'open',
    })).toEqual({
      ok: true,
      value: { kind: 'risk', title: 'Vendor delay', probability: 4, impact: 5, response: 'Add a second vendor', status: 'open' },
    })
  })

  test('requires a probability for a risk and rejects one for other kinds', () => {
    expect(parseProjectRaidEntryInput({ kind: 'risk', title: 'A', impact: 3, status: 'open' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ kind: 'issue', title: 'A', probability: 2, impact: 3, status: 'open' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ kind: 'change-request', title: 'A', impact: 3, status: 'closed' }).ok).toBe(true)
  })

  test('rejects out-of-range ratings, impossible dates, and long text', () => {
    const base = { kind: 'issue', title: 'A', impact: 3, status: 'open' }
    expect(parseProjectRaidEntryInput({ ...base, impact: 6 }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, impact: 2.5 }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, reviewDueDate: '2026-02-30' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, title: 'x'.repeat(201) }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, response: 'x'.repeat(2001) }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, status: 'deleted' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput([]).ok).toBe(false)
  })

  test('keeps line breaks and Japanese text but rejects characters JSON escapes to six bytes', () => {
    const base = { kind: 'issue', title: 'A', impact: 3, status: 'open' }
    const accepted = parseProjectRaidEntryInput({ ...base, title: '納期遅延 🚚', description: '一行目\n\t二行目\r\n三行目' })
    expect(accepted.ok && accepted.value.description).toBe('一行目\n\t二行目\r\n三行目')
    expect(parseProjectRaidEntryInput({ ...base, title: 'A\u0001B' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, description: 'x\u0000y' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, response: 'x\u009Fy' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, response: 'x\uD800y' }).ok).toBe(false)
    expect(parseProjectRaidEntryInput({ ...base, description: 'x\uDC00' }).ok).toBe(false)
  })
})

describe('parseProjectRaidEntry', () => {
  test('accepts a normalized entry and rejects an unnormalized one', () => {
    expect(parseProjectRaidEntry(entry())).toEqual(entry())
    expect(parseProjectRaidEntry({ ...entry(), title: ' Vendor delay' })).toBeUndefined()
    expect(parseProjectRaidEntry({ ...entry(), revision: 0 })).toBeUndefined()
  })

  test('requires real UTC timestamps', () => {
    expect(parseProjectRaidEntry(entry({ createdAt: '2026-11-19T00:00:00Z' }))).toBeDefined()
    expect(parseProjectRaidEntry({ ...entry(), createdAt: 'yesterday' })).toBeUndefined()
    expect(parseProjectRaidEntry({ ...entry(), updatedAt: '2026-02-30T00:00:00.000Z' })).toBeUndefined()
    expect(parseProjectRaidEntry({ ...entry(), updatedAt: '2026-11-19T24:00:00.000Z' })).toBeUndefined()
    expect(parseProjectRaidEntry({ ...entry(), status: 'closed', closedAt: '2026-11-19' })).toBeUndefined()
  })
})

describe('deriveProjectRaidSeverity', () => {
  test('rates a risk by probability times impact', () => {
    expect(deriveProjectRaidSeverity({ kind: 'risk', probability: 2, impact: 2 })).toBe('low')
    expect(deriveProjectRaidSeverity({ kind: 'risk', probability: 3, impact: 3 })).toBe('medium')
    expect(deriveProjectRaidSeverity({ kind: 'risk', probability: 4, impact: 4 })).toBe('high')
    expect(deriveProjectRaidSeverity({ kind: 'risk', probability: 4, impact: 5 })).toBe('critical')
  })

  test('rates an issue or change request by impact', () => {
    expect(deriveProjectRaidSeverity({ kind: 'issue', impact: 2 })).toBe('low')
    expect(deriveProjectRaidSeverity({ kind: 'issue', impact: 3 })).toBe('medium')
    expect(deriveProjectRaidSeverity({ kind: 'change-request', impact: 4 })).toBe('high')
    expect(deriveProjectRaidSeverity({ kind: 'change-request', impact: 5 })).toBe('critical')
  })
})

describe('summarizeProjectRaidLog', () => {
  test('counts only open entries and finds the highest open severity and overdue reviews', () => {
    expect(summarizeProjectRaidLog([
      entry({ id: 'a', reviewDueDate: '2026-11-18' }),
      entry({ id: 'b', kind: 'issue', probability: undefined, impact: 4, reviewDueDate: '2026-11-19' }),
      entry({ id: 'c', kind: 'change-request', probability: undefined, impact: 5, status: 'closed', reviewDueDate: '2026-11-01' }),
    ], '2026-11-19')).toEqual({
      openCounts: { risk: 1, issue: 1, 'change-request': 0 },
      highestOpenSeverity: 'high',
      overdueReviewCount: 1,
    })
  })

  test('omits the highest severity when nothing is open', () => {
    expect(summarizeProjectRaidLog([entry({ status: 'closed' })], '2026-11-19')).toEqual({
      openCounts: { risk: 0, issue: 0, 'change-request': 0 },
      overdueReviewCount: 0,
    })
  })
})

describe('parseProjectRaidLogResponse', () => {
  test('accepts a valid response and rejects one with a malformed entry', () => {
    expect(parseProjectRaidLogResponse({ teamId: 't', projectId: 'p', entries: [entry()] }))
      .toEqual({ teamId: 't', projectId: 'p', entries: [entry()] })
    expect(parseProjectRaidLogResponse({ teamId: 't', projectId: 'p', entries: [{ id: 'x' }] })).toBeUndefined()
    expect(parseProjectRaidEntryResponse({ teamId: 't', projectId: 'p', entry: entry() })?.entry).toEqual(entry())
    expect(parseProjectRaidLogResponse({ teamId: 't', projectId: 'p', entries: [], viewer: { canEdit: false } })?.viewer)
      .toEqual({ canEdit: false })
    expect(parseProjectRaidLogResponse({ teamId: 't', projectId: 'p', entries: [], viewer: { canEdit: 'yes' } })).toBeUndefined()
  })
})
