import { afterEach, expect, test } from 'bun:test'
import { generateDigestPreview, getDigestState, isAmbiguousInboxSaveFailure, saveDigestPreferences } from '../src/features/update-feed/api/digest'
import { UpdateFeedApiError } from '../src/features/update-feed/api/updateFeed'
import { updateFeedFixture } from '../src/features/update-feed/fixtures'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const state = { revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, history: [] }
const preview = { id: 'daily:2026-10-03', replay: false, entries: updateFeedFixture.entries.slice(0, 1), truncated: false, transport: 'preview' }

test('Inbox save classification separates stable permanent failures from uncertain acknowledgments', () => {
  for (const code of ['UpdateFeedDigestCorruptState', 'UpdateFeedDigestStoragePermanent', 'UpdateFeedDigestRecipientMismatch', 'UpdateFeedReadStateCorrupt', 'SavedUpdateFeedsCorruptState', 'TenantAdministrationCorrupt']) expect(isAmbiguousInboxSaveFailure(new UpdateFeedApiError(502, code))).toBe(false)
  for (const status of [400, 401, 403, 409]) expect(isAmbiguousInboxSaveFailure(new UpdateFeedApiError(status))).toBe(false)
  for (const error of [new TypeError('Network failure'), new UpdateFeedApiError(503, 'UpdateFeedDigestRetryable'), new UpdateFeedApiError(502)]) expect(isAmbiguousInboxSaveFailure(error)).toBe(true)
})

test('validates personal metadata and reconstructs only bounded bodyless fields', async () => {
  globalThis.fetch = async () => Response.json({ ...state, secret: 'not retained' })
  expect(await getDigestState('session')).toEqual(state)
  for (const bad of [{ ...state, revision: -1 }, { ...state, preferences: { ...state.preferences, frequency: 'hourly' } }, { ...state, preferences: { ...state.preferences, views: ['recent', 'recent'] } }, { ...state, history: [{}] }, { ...state, history: Array(21).fill({}) }]) {
    globalThis.fetch = async () => Response.json(bad)
    await expect(getDigestState('session')).rejects.toMatchObject({ status: 502 })
  }
})

test('saves only desired preferences and observed revision, with current session authorization', async () => {
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toEndWith('/digest')
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session')
    expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 1, preferences: { enabled: true, frequency: 'weekly', views: ['recent'] } })
    return Response.json(state)
  }
  await saveDigestPreferences('session', 1, { enabled: true, frequency: 'weekly', views: ['recent'] })
})

test('requests preview only by POST and rejects live transport, read entries, duplicates and malformed bodies', async () => {
  globalThis.fetch = async (url, init) => { expect(String(url)).toEndWith('/digest/preview?locale=en'); expect(init?.method).toBe('POST'); return Response.json(preview) }
  expect(await generateDigestPreview('session', 'en')).toEqual(preview)
  for (const bad of [{ ...preview, transport: 'inbox' }, { ...preview, entries: [...preview.entries, ...preview.entries] }, { ...preview, entries: [{ ...preview.entries[0], readState: { read: true, revision: 1 } }] }, { ...preview, entries: [{ ...preview.entries[0], latestUpdate: undefined }] }]) {
    globalThis.fetch = async () => Response.json(bad)
    await expect(generateDigestPreview('session', 'en')).rejects.toMatchObject({ status: 502 })
  }
  for (const status of [401, 403, 409, 503]) {
    globalThis.fetch = async () => Response.json({ code: 'UpdateFeedDigestConflict' }, { status })
    await expect(generateDigestPreview('session', 'en')).rejects.toMatchObject({ status, code: 'UpdateFeedDigestConflict' })
  }
})
