import { describe, expect, test } from 'bun:test'
import {
  compareProjectDecisionEntries,
  compareTimestampsNewestFirst,
  normalizeProjectDecisionSourceUrl,
  parseProjectDecisionEntry,
  parseProjectDecisionEntryInput,
  parseProjectDecisionLogResponse,
  parseTeamDecisionLogResponse,
  teamDecisionLogItemMatches,
  type ProjectDecisionEntry,
} from '../src/project-decision-log'

/**
 * Builds a stored decision for tests.
 *
 * @param overrides - Fields replacing the defaults.
 * @returns One decision.
 */
function decision(overrides: Partial<ProjectDecisionEntry> = {}): ProjectDecisionEntry {
  return {
    id: 'decision-1',
    title: 'Use DynamoDB',
    content: 'Keep decisions in the Planning table.',
    decidedAt: '2026-11-27T01:00:00.000Z',
    status: 'active',
    origin: 'project',
    recordedByMemberId: 'pm@example.com',
    revision: 1,
    createdAt: '2026-11-28T00:00:00.000Z',
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseProjectDecisionEntryInput', () => {
  test('normalizes text, drops empty optional fields and repeated links', () => {
    expect(parseProjectDecisionEntryInput({
      title: '  Use DynamoDB ',
      content: ' Keep decisions in the Planning table. ',
      rationale: ' ',
      deciderMemberIds: ['pm@example.com', 'pm@example.com'],
      decidedAt: '2026-11-27T01:00:00.000Z',
      relatedWorkItemIds: [],
      sources: [
        { url: ' https://example.slack.com/archives/C1/p1 ', label: ' Slack ' },
        { url: 'https://example.slack.com/archives/C1/p1' },
      ],
      status: 'active',
      origin: 'work-item',
    })).toEqual({
      ok: true,
      value: {
        title: 'Use DynamoDB',
        content: 'Keep decisions in the Planning table.',
        deciderMemberIds: ['pm@example.com'],
        decidedAt: '2026-11-27T01:00:00.000Z',
        sources: [{ url: 'https://example.slack.com/archives/C1/p1', label: 'Slack' }],
        status: 'active',
        origin: 'work-item',
      },
    })
  })

  test('requires title, content, a timestamp, and a known status and origin', () => {
    const valid = { title: 't', content: 'c', decidedAt: '2026-11-27T01:00:00.000Z', status: 'active', origin: 'project' }
    expect(parseProjectDecisionEntryInput(valid).ok).toBe(true)
    expect(parseProjectDecisionEntryInput({ ...valid, title: ' ' }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, content: undefined }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, decidedAt: '2026-02-30T00:00:00.000Z' }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, status: 'open' }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, origin: 'email' }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, title: 'x'.repeat(201) }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, content: 'a\u0000b' }).ok).toBe(false)
  })

  test('lets only a superseded decision name its replacement', () => {
    const valid = { title: 't', content: 'c', decidedAt: '2026-11-27T01:00:00.000Z', origin: 'project' }
    expect(parseProjectDecisionEntryInput({ ...valid, status: 'superseded', supersededByEntryId: 'decision-2' }).ok).toBe(true)
    expect(parseProjectDecisionEntryInput({ ...valid, status: 'active', supersededByEntryId: 'decision-2' }).ok).toBe(false)
  })

  test('limits deciders, related Work Items, and sources', () => {
    const valid = { title: 't', content: 'c', decidedAt: '2026-11-27T01:00:00.000Z', status: 'active', origin: 'project' }
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `id-${index}`)
    expect(parseProjectDecisionEntryInput({ ...valid, deciderMemberIds: ids(10) }).ok).toBe(true)
    expect(parseProjectDecisionEntryInput({ ...valid, deciderMemberIds: ids(11) }).ok).toBe(false)
    expect(parseProjectDecisionEntryInput({ ...valid, relatedWorkItemIds: ids(11) }).ok).toBe(false)
    const links = (count: number) => Array.from({ length: count }, (_, index) => ({ url: `https://example.com/${index}` }))
    expect(parseProjectDecisionEntryInput({ ...valid, sources: links(5) }).ok).toBe(true)
    expect(parseProjectDecisionEntryInput({ ...valid, sources: links(6) }).ok).toBe(false)
  })
})

describe('normalizeProjectDecisionSourceUrl', () => {
  test('accepts only https and http links without credentials or spaces', () => {
    expect(normalizeProjectDecisionSourceUrl('https://github.com/o/r/blob/main/docs/adr/0114.md')).toBe(
      'https://github.com/o/r/blob/main/docs/adr/0114.md',
    )
    expect(normalizeProjectDecisionSourceUrl('http://intranet.example/minutes')).toBe('http://intranet.example/minutes')
    expect(normalizeProjectDecisionSourceUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeProjectDecisionSourceUrl('https://user:secret@example.com/')).toBeUndefined()
    expect(normalizeProjectDecisionSourceUrl('https://example.com/a b')).toBeUndefined()
    expect(normalizeProjectDecisionSourceUrl('/relative')).toBeUndefined()
    expect(normalizeProjectDecisionSourceUrl('https:example.com')).toBeUndefined()
    expect(normalizeProjectDecisionSourceUrl(`https://example.com/${'a'.repeat(1_000)}`)).toBeUndefined()
  })
})

describe('parseProjectDecisionEntry', () => {
  test('accepts a normalized decision and refuses one normalization would change', () => {
    expect(parseProjectDecisionEntry(decision())).toEqual(decision())
    expect(parseProjectDecisionEntry({ ...decision(), title: ' Use DynamoDB' })).toBeUndefined()
    expect(parseProjectDecisionEntry({ ...decision(), sources: [{ url: 'https://example.com', extra: true }] })).toBeUndefined()
    expect(parseProjectDecisionEntry({ ...decision(), revision: 0 })).toBeUndefined()
    expect(parseProjectDecisionEntry({ ...decision(), recordedByMemberId: 'a'.repeat(255) })).toBeUndefined()
  })
})

describe('compareProjectDecisionEntries', () => {
  test('puts the newest decision first', () => {
    const older = decision({ id: 'a', decidedAt: '2026-11-01T00:00:00.000Z' })
    const newer = decision({ id: 'b', decidedAt: '2026-11-20T00:00:00.000Z' })
    expect([older, newer].sort(compareProjectDecisionEntries).map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})

describe('responses', () => {
  test('parses the Project and Team logs', () => {
    expect(parseProjectDecisionLogResponse({
      teamId: 'team-1',
      projectId: 'project-1',
      entries: [decision()],
      viewer: { canEdit: true },
    })?.entries).toHaveLength(1)
    expect(parseProjectDecisionLogResponse({ teamId: 'team-1', projectId: 'project-1', entries: [] })).toBeUndefined()
    const team = parseTeamDecisionLogResponse({
      teamId: 'team-1',
      truncated: false,
      items: [
        { kind: 'decision', projectId: 'project-1', decidedAt: decision().decidedAt, entry: decision() },
        {
          kind: 'change-request',
          projectId: 'project-1',
          decidedAt: '2026-11-21T00:00:00.000Z',
          entry: {
            id: 'cr-1',
            kind: 'change-request',
            title: 'Move launch',
            impact: 3,
            status: 'closed',
            decision: { outcome: 'approved', decidedAt: '2026-11-21T00:00:00.000Z', decidedByMemberId: 'pm@example.com' },
            revision: 2,
            createdAt: '2026-11-20T00:00:00.000Z',
            updatedAt: '2026-11-21T00:00:00.000Z',
            closedAt: '2026-11-21T00:00:00.000Z',
          },
        },
      ],
    })
    expect(team?.items.map((item) => item.kind)).toEqual(['decision', 'change-request'])
    expect(parseTeamDecisionLogResponse({ teamId: 'team-1', truncated: false, items: [{ kind: 'note' }] })).toBeUndefined()
  })

  test('matches keywords in any free text, ignoring case', () => {
    const item = { kind: 'decision' as const, projectId: 'p', decidedAt: decision().decidedAt, entry: decision({ rationale: 'Cheaper than OpenSearch' }) }
    expect(teamDecisionLogItemMatches(item, 'opensearch')).toBe(true)
    expect(teamDecisionLogItemMatches(item, 'aurora')).toBe(false)
    expect(teamDecisionLogItemMatches(item, '')).toBe(true)
  })
})

describe('decision timestamps', () => {
  test('orders timestamps with different fractional precision by instant', () => {
    expect(compareTimestampsNewestFirst('2026-11-28T10:00:00Z', '2026-11-28T10:00:00.500Z')).toBeGreaterThan(0)
    expect(compareTimestampsNewestFirst('2026-11-28T10:00:00.500Z', '2026-11-28T10:00:00Z')).toBeLessThan(0)
  })

  test('stores decidedAt in one representation', () => {
    const parsed = parseProjectDecisionEntryInput({ title: 't', content: 'c', decidedAt: '2026-11-28T10:00:00Z', status: 'active', origin: 'project' })
    expect(parsed.ok && parsed.value.decidedAt).toBe('2026-11-28T10:00:00.000Z')
  })

  test('refuses fractions of a second beyond milliseconds', () => {
    const parsed = parseProjectDecisionEntryInput({ title: 't', content: 'c', decidedAt: '2026-11-28T10:00:00.1234Z', status: 'active', origin: 'project' })
    expect(parsed.ok).toBe(false)
  })
})
