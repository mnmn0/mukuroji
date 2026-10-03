import { afterEach, expect, test } from 'bun:test'
import { getSavedUpdateFeeds, getUpdateFeedFilterOptions, replaceSavedUpdateFeeds } from '../src/features/update-feed/api/savedFeeds'
import type { SavedUpdateFeed } from '@mukuroji/contracts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const feed: SavedUpdateFeed = { id: 'risks', name: 'Risks', view: 'recent', filters: { teamIds: [], projects: [{ teamId: 'alpha', projectId: 'shared' }, { teamId: 'beta', projectId: 'shared' }], portfolioIds: [], initiativeIds: [], health: ['at-risk'], updateStates: ['overdue'] } }

test('preserves qualified selectors and personal CAS while rejecting corrupt collections', async () => {
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toEndWith('/planning/update-feed/saved')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 2, feeds: [feed] })
    return Response.json({ revision: 3, feeds: [feed] })
  }
  expect(await replaceSavedUpdateFeeds('session', { expectedRevision: 2, feeds: [feed] })).toEqual({ revision: 3, feeds: [feed] })
  for (const feeds of [[feed, feed], [{ ...feed, name: 'bad\nname' }], [{ ...feed, filters: { ...feed.filters, health: ['overdue'] } }], [{ ...feed, filters: { ...feed.filters, projects: [feed.filters.projects[0], feed.filters.projects[0]] } }], Array.from({ length: 21 }, (_, i) => ({ ...feed, id: String(i) }))]) {
    globalThis.fetch = async () => Response.json({ revision: 1, feeds })
    await expect(getSavedUpdateFeeds('session')).rejects.toMatchObject({ status: 502 })
  }
  for (const status of [401, 403, 409, 503]) {
    globalThis.fetch = async () => Response.json({ code: 'SavedUpdateFeedsConflict' }, { status })
    await expect(replaceSavedUpdateFeeds('session', { expectedRevision: 2, feeds: [] })).rejects.toMatchObject({ status, code: 'SavedUpdateFeedsConflict' })
  }
})

test('checks current selector metadata bounds and duplicate qualified identities', async () => {
  const options = { teams: [{ id: 'alpha', name: 'Alpha' }], projects: [{ teamId: 'alpha', projectId: 'shared', name: 'Shared' }], portfolios: [], initiatives: [] }
  globalThis.fetch = async (url) => { expect(String(url)).toEndWith('/options?locale=en'); return Response.json(options) }
  expect(await getUpdateFeedFilterOptions('session', 'en')).toEqual(options)
  for (const invalid of [{ ...options, projects: [...options.projects, ...options.projects] }, { ...options, teams: [{ id: 'bad\n', name: 'Bad' }] }, { ...options, initiatives: Array.from({ length: 2001 }, (_, i) => ({ id: String(i), name: 'Too many' })) }]) {
    globalThis.fetch = async () => Response.json(invalid)
    await expect(getUpdateFeedFilterOptions('session', 'en')).rejects.toMatchObject({ status: 502 })
  }
})
