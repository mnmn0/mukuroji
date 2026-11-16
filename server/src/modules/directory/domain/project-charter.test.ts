import { describe, expect, test } from 'bun:test'
import {
  canTransitionProjectLifecycle,
  PROJECT_CHARTER_TAGS_MAX_ITEMS,
  projectLifecycleAcceptsNewWorkItems,
} from '@mukuroji/contracts'
import {
  createProjectCharter,
  createProjectCharterPerson,
  isStoredProjectCharter,
  listChangedProjectCharterFields,
  normalizeProjectCode,
  readInitialProjectLifecycleState,
  readProjectCharterUpdate,
  readProjectLifecycleTransition,
  resolveProjectLifecycleState,
  toProjectCharterSummary,
} from './project-charter'

describe('Project charter update validation', () => {
  test('normalizes a complete charter and treats blank text as cleared', () => {
    const result = readProjectCharterUpdate({
      expectedRevision: 2,
      charter: {
        code: ' ops-2026 ',
        description: '  社内基盤の刷新 ',
        purpose: '   ',
        ownerUserId: 'pm@example.com',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2027-03-31',
        tags: ['基盤', ' 基盤 ', 'Infra', 'infra', ''],
        repositoryUrls: ['https://github.com/example/repo', 'https://github.com/example/repo'],
      },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        expectedRevision: 2,
        code: 'OPS-2026',
        description: '社内基盤の刷新',
        ownerUserId: 'pm@example.com',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2027-03-31',
        tags: ['基盤', 'Infra'],
        repositoryUrls: ['https://github.com/example/repo'],
      },
    })
  })

  test.each([
    ['missing revision', { charter: {} }],
    ['negative revision', { expectedRevision: -1, charter: {} }],
    ['missing charter', { expectedRevision: 0 }],
    ['code with spaces', { expectedRevision: 0, charter: { code: 'OPS 1' } }],
    ['code starting with a dash', { expectedRevision: 0, charter: { code: '-OPS' } }],
    ['non-ASCII code', { expectedRevision: 0, charter: { code: '基盤' } }],
    ['impossible date', { expectedRevision: 0, charter: { plannedStartDate: '2026-02-30' } }],
    [
      'end before start',
      { expectedRevision: 0, charter: { plannedStartDate: '2026-05-01', plannedEndDate: '2026-04-30' } },
    ],
    ['plain HTTP repository', { expectedRevision: 0, charter: { repositoryUrls: ['http://example.com/repo'] } }],
    [
      'repository URL with credentials',
      { expectedRevision: 0, charter: { repositoryUrls: ['https://user:secret@example.com/repo'] } },
    ],
    [
      'too many tags',
      {
        expectedRevision: 0,
        charter: { tags: Array.from({ length: PROJECT_CHARTER_TAGS_MAX_ITEMS + 1 }, (_, i) => `tag-${i}`) },
      },
    ],
    ['non-string owner', { expectedRevision: 0, charter: { ownerUserId: 42 } }],
  ])('rejects %s', (_label, body) => {
    expect(readProjectCharterUpdate(body)).toMatchObject({ ok: false, code: 'InvalidProjectCharter' })
  })

  test('normalizes and rejects Project codes', () => {
    expect(normalizeProjectCode('ab_12-x')).toBe('AB_12-X')
    expect(normalizeProjectCode('')).toBeUndefined()
    expect(normalizeProjectCode('A'.repeat(33))).toBeUndefined()
  })
})

describe('Project lifecycle', () => {
  test('derives archived from the legacy archive marker and defaults legacy rows to active', () => {
    expect(resolveProjectLifecycleState({})).toBe('active')
    expect(resolveProjectLifecycleState({ lifecycleState: 'on-hold' })).toBe('on-hold')
    expect(resolveProjectLifecycleState({ lifecycleState: 'closed', archivedAt: '2026-01-01T00:00:00.000Z' }))
      .toBe('archived')
  })

  test('accepts only proposal, approval, or active as the initial state', () => {
    expect(readInitialProjectLifecycleState(undefined)).toEqual({ ok: true, value: 'active' })
    expect(readInitialProjectLifecycleState('proposed')).toEqual({ ok: true, value: 'proposed' })
    expect(readInitialProjectLifecycleState('closed')).toMatchObject({ ok: false })
    expect(readInitialProjectLifecycleState('archived')).toMatchObject({ ok: false })
  })

  test('allows only the documented transitions', () => {
    expect(canTransitionProjectLifecycle('proposed', 'approved')).toBe(true)
    expect(canTransitionProjectLifecycle('approved', 'active')).toBe(true)
    expect(canTransitionProjectLifecycle('active', 'on-hold')).toBe(true)
    expect(canTransitionProjectLifecycle('on-hold', 'active')).toBe(true)
    expect(canTransitionProjectLifecycle('active', 'closed')).toBe(true)
    expect(canTransitionProjectLifecycle('closed', 'active')).toBe(true)
    expect(canTransitionProjectLifecycle('proposed', 'active')).toBe(false)
    expect(canTransitionProjectLifecycle('active', 'proposed')).toBe(false)
    expect(canTransitionProjectLifecycle('closed', 'archived')).toBe(false)
    expect(canTransitionProjectLifecycle('archived', 'active')).toBe(false)
  })

  test('rejects new Work Items only after closing', () => {
    expect(projectLifecycleAcceptsNewWorkItems('proposed')).toBe(true)
    expect(projectLifecycleAcceptsNewWorkItems('on-hold')).toBe(true)
    expect(projectLifecycleAcceptsNewWorkItems('closed')).toBe(false)
    expect(projectLifecycleAcceptsNewWorkItems('archived')).toBe(false)
  })

  test('validates a transition body', () => {
    expect(readProjectLifecycleTransition({ expectedRevision: 1, state: 'closed' }))
      .toEqual({ ok: true, value: { expectedRevision: 1, state: 'closed' } })
    expect(readProjectLifecycleTransition({ expectedRevision: 1, state: 'done' }))
      .toMatchObject({ ok: false, code: 'InvalidProjectLifecycleTransition' })
  })
})

describe('stored Project charter', () => {
  test('builds, summarizes, and diffs a charter', () => {
    const update = readProjectCharterUpdate({
      expectedRevision: 0,
      charter: { code: 'ops', ownerUserId: 'pm@example.com', plannedEndDate: '2026-12-31', tags: ['a'] },
    })
    if (!update.ok) throw new Error('expected valid update')
    const owner = createProjectCharterPerson('pm@example.com', ' 山田 ', 'pm@example.com')
    const charter = createProjectCharter(update.value, { owner })

    expect(charter).toEqual({
      code: 'OPS',
      owner: { userId: 'pm@example.com', displayName: '山田' },
      plannedEndDate: '2026-12-31',
      tags: ['a'],
      repositoryUrls: [],
    })
    expect(isStoredProjectCharter(charter)).toBe(true)
    expect(toProjectCharterSummary(charter)).toEqual({
      code: 'OPS',
      owner: { userId: 'pm@example.com', displayName: '山田' },
      plannedEndDate: '2026-12-31',
    })
    expect(toProjectCharterSummary({ tags: ['a'], repositoryUrls: [] })).toBeUndefined()
    expect(listChangedProjectCharterFields({ tags: [], repositoryUrls: [] }, charter))
      .toEqual(['code', 'owner', 'plannedEndDate', 'tags'])
  })

  test('fails closed on malformed stored charters', () => {
    expect(isStoredProjectCharter({ tags: [], repositoryUrls: [] })).toBe(true)
    expect(isStoredProjectCharter({ tags: [] })).toBe(false)
    expect(isStoredProjectCharter({ code: 'lower', tags: [], repositoryUrls: [] })).toBe(false)
    expect(isStoredProjectCharter({ owner: { userId: 'x' }, tags: [], repositoryUrls: [] })).toBe(false)
  })
})
