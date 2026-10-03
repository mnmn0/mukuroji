import { expect, test } from 'bun:test'
import type { SavedUpdateFeed, UpdateFeedFilters } from '@mukuroji/contracts'
import { parseSavedUpdateFeeds } from './saved-feeds'

const empty: UpdateFeedFilters = { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] }
const feed: SavedUpdateFeed = { id: 'risk', name: 'My risks', view: 'at-risk', filters: empty }

test('validates every bounded dimension and reconstructs definitions without unknown fields', () => {
  expect(parseSavedUpdateFeeds({ expectedRevision: 0, memberKey: 'other', feeds: [{ ...feed, name: ' My risks ', body: 'discard' }] })).toEqual({ expectedRevision: 0, feeds: [feed] })
  for (const filters of [
    { ...empty, teamIds: ['same', 'same'] },
    { ...empty, projects: [{ teamId: 'team' }] },
    { ...empty, projects: [{ teamId: 't', projectId: 'p' }, { teamId: 't', projectId: 'p' }] },
    { ...empty, portfolioIds: ['x'.repeat(513)] },
    { ...empty, initiativeIds: ['bad\nidentifier'] },
    { ...empty, health: ['overdue'] },
    { ...empty, updateStates: ['off-track'] },
    { ...empty, teamIds: Array.from({ length: 21 }, (_, i) => String(i)) },
  ]) expect(() => parseSavedUpdateFeeds({ expectedRevision: 0, feeds: [{ ...feed, filters }] })).toThrow()
  for (const invalid of [
    { expectedRevision: -1, feeds: [] }, { expectedRevision: Number.MAX_SAFE_INTEGER, feeds: [] },
    { expectedRevision: 0, feeds: [feed, feed] }, { expectedRevision: 0, feeds: [{ ...feed, view: 'custom' }] },
    { expectedRevision: 0, feeds: [{ ...feed, name: ' ' }] }, { expectedRevision: 0, feeds: [{ ...feed, name: 'x'.repeat(81) }] },
    { expectedRevision: 0, feeds: Array.from({ length: 21 }, (_, i) => ({ ...feed, id: String(i) })) },
    { expectedRevision: 0, feeds: Array.from({ length: 20 }, (_, i) => ({ ...feed, id: String(i), filters: { ...empty, teamIds: Array.from({ length: 20 }, (_, j) => `${j}${'長'.repeat(170)}`) } })) },
  ]) expect(() => parseSavedUpdateFeeds(invalid)).toThrow()
})
