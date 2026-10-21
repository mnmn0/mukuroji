import { afterEach, expect, test } from 'bun:test'
import { getUpdateFeed, setUpdateFeedReadState } from '../src/features/update-feed/api/updateFeed'
import { updateFeedFixture } from '../src/features/update-feed/fixtures'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('validates independent health and submission fields without changing server ranking', async () => {
  globalThis.fetch = async (url) => {
    expect(String(url)).toContain('locale=en')
    expect(String(url)).toContain('relevance=2')
    return Response.json(updateFeedFixture)
  }
  expect(await getUpdateFeed('session', 'for-me', 'en')).toEqual(updateFeedFixture)
  for (const invalid of [
    { ...updateFeedFixture, view: 'recent' },
    { ...updateFeedFixture, entries: [{ ...updateFeedFixture.entries[0], readState: { read: true, revision: -1 } }] },
    { ...updateFeedFixture, entries: [{ ...updateFeedFixture.entries[0], updateState: ['current'] }] },
    { ...updateFeedFixture, entries: [{ ...updateFeedFixture.entries[0], latestUpdate: { ...updateFeedFixture.entries[0]?.latestUpdate, createdAt: 'invalid' } }] },
  ]) {
    globalThis.fetch = async () => Response.json(invalid)
    await expect(getUpdateFeed('session', 'for-me')).rejects.toMatchObject({ status: 502 })
  }
})

test('writes qualified immutable identity and preserves authorization/conflict failures', async () => {
  const target = updateFeedFixture.entries[0]?.target
  if (!target) throw new Error('Missing fixture')
  const input = { target, version: 1, read: true, expectedRevision: 0 }
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toEndWith('/planning/update-feed/read-state')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual(input)
    return Response.json({ read: true, revision: 1 })
  }
  expect(await setUpdateFeedReadState('session', input)).toEqual({ read: true, revision: 1 })
  for (const status of [401, 403, 409, 503]) {
    globalThis.fetch = async () => Response.json({}, { status })
    await expect(setUpdateFeedReadState('session', input)).rejects.toMatchObject({ status })
  }
  globalThis.fetch = async () => Response.json({ code: 'EnterpriseMfaRequired' }, { status: 403 })
  await expect(setUpdateFeedReadState('session', input)).rejects.toMatchObject({ status: 403, code: 'EnterpriseMfaRequired' })
})

test('accepts explained personal signals and rejects corrupt attention without re-ranking', async () => {
  const response = { ...updateFeedFixture, entries: [{ ...updateFeedFixture.entries[0], relevance: 9, reasons: ['project-member', 'watching', 'recent-interaction'], attention: { score: 3, reasons: ['recent-comment', 'recent-reaction'] } }] }
  globalThis.fetch = async () => Response.json(response)
  expect(await getUpdateFeed('session', 'for-me')).toEqual(response)
  for (const attention of [{ score: 4, reasons: [] }, { score: 1, reasons: ['unknown'] }, { score: 2, reasons: ['recent-comment', 'recent-comment'] }, { score: -1, reasons: [] }]) {
    globalThis.fetch = async () => Response.json({ ...response, entries: [{ ...response.entries[0], attention }] })
    await expect(getUpdateFeed('session', 'for-me')).rejects.toMatchObject({ status: 502 })
  }
})
