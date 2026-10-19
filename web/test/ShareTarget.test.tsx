import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createShareHandoffIdentity,
  createShareHandoffInput,
  readSharedContent,
  sharedBodyMaxLength,
  sharedTitleMaxLength,
} from '../src/features/share-capture/model/sharedContent'
import {
  classifyShareHandoffFailure,
  readLockedShareHandoff,
  resolveFailedAttempt,
  useShareHandoff,
  type ShareHandoffStorage,
} from '../src/features/share-capture/mutations/useShareHandoff'
import { ShareCaptureForm } from '../src/features/share-capture/ui/ShareCaptureForm'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  discardStoredSharedContent,
  readStoredSharedContent,
  sharedContentCacheName,
  sharedContentKeyPrefix,
  type SharedContentCacheStorage,
} from '../src/shared/lib/pwa/sharedContentInbox'
import { createTriageManualHandoff, TriageApiError } from '../src/triage/api'
import { triageEntryFixtures } from '../src/triage/fixtures'

const originalFetch = globalThis.fetch
const t = createTranslator('en')

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('readSharedContent', () => {
  test('uses the shared title and keeps the text and link in the body', () => {
    const content = readSharedContent({
      title: '  Checkout\nfails ',
      text: 'Steps:\r\n1. Open the cart',
      url: 'https://example.com/cart',
    })
    expect(content).toEqual({
      title: 'Checkout fails',
      body: 'Steps:\n1. Open the cart\n\nhttps://example.com/cart',
    })
  })

  test('falls back to the first text line, then the link, for the title', () => {
    expect(readSharedContent({ title: '', text: '\n  First line \nSecond', url: '' }).title).toBe('First line')
    expect(readSharedContent({ title: '', text: '', url: 'https://example.com/a' })).toEqual({
      title: 'https://example.com/a',
      body: 'https://example.com/a',
    })
  })

  test('does not repeat a link the text already contains', () => {
    const content = readSharedContent({
      title: '',
      text: 'See https://example.com/a',
      url: 'https://example.com/a',
    })
    expect(content.body).toBe('See https://example.com/a')
  })

  test('keeps a link that only prefixes a longer URL in the text', () => {
    const content = readSharedContent({
      title: 'Article',
      text: 'Old: https://example.com/article-old',
      url: 'https://example.com/article',
    })
    expect(content.body).toBe('Old: https://example.com/article-old\n\nhttps://example.com/article')
  })

  test('cuts the text, not a separately shared link, at the body limit', () => {
    const url = 'https://example.com/report'
    const content = readSharedContent({ title: '', text: 'z'.repeat(9_000), url })
    expect(content.body.length).toBe(sharedBodyMaxLength)
    expect(content.body.endsWith(`\n\n${url}`)).toBe(true)
  })

  test('removes control characters and cuts values to the API limits', () => {
    const content = readSharedContent({
      title: `a\u0000b\u001b${'x'.repeat(600)}`,
      text: `line\u0007\t${'y'.repeat(9_000)}`,
      url: '',
    })
    expect(content.title.startsWith('ab')).toBe(true)
    expect(content.title.length).toBe(sharedTitleMaxLength)
    expect(content.body.startsWith('line\t')).toBe(true)
    expect(content.body.length).toBe(sharedBodyMaxLength)
  })

  test('does not split a surrogate pair at the limit', () => {
    const title = `${'x'.repeat(sharedTitleMaxLength - 1)}😀`
    expect(readSharedContent({ title, text: '', url: '' }).title).toBe('x'.repeat(sharedTitleMaxLength - 1))
  })

  test('returns empty values when nothing was shared', () => {
    expect(readSharedContent(undefined)).toEqual({ title: '', body: '' })
  })
})

describe('createShareHandoffInput', () => {
  test('builds a bounded handoff with retry-stable identity', () => {
    const identity = createShareHandoffIdentity(new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
    expect(identity).toEqual({
      sourceId: 'share:uuid-1',
      retentionExpiresAt: '2026-11-18T00:00:00.000Z',
    })
    expect(createShareHandoffInput({ title: ' Bug\nreport ', body: ' details \n' }, identity, '  Ada  ')).toEqual({
      sourceId: 'share:uuid-1',
      title: 'Bug report',
      body: 'details',
      requesterDisplayName: 'Ada',
      routingReason: 'Shared to mukuroji from a device',
      retentionExpiresAt: '2026-11-18T00:00:00.000Z',
    })
  })

  test('falls back to a requester name the API accepts', () => {
    const identity = createShareHandoffIdentity(new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
    expect(createShareHandoffInput({ title: 'Bug', body: '' }, identity, ' ').requesterDisplayName).toBe('mukuroji')
  })
})

describe('createTriageManualHandoff', () => {
  test('posts the handoff with replay-safe headers and validates the receipt', async () => {
    const requests: Request[] = []
    const entry = triageEntryFixtures[0]
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(new URL(String(input), 'https://mukuroji.test'), init))
      return new Response(JSON.stringify({ entry, replayed: false }), { status: 201 })
    }
    const identity = createShareHandoffIdentity(new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
    const input = createShareHandoffInput({ title: 'Bug', body: 'Details' }, identity, 'Ada')

    const receipt = await createTriageManualHandoff('team/a', input, 'token-1', {
      idempotencyKey: 'key-1',
      correlationId: 'key-1',
    })

    expect(receipt.entry.id).toBe(entry?.id ?? '')
    expect(receipt.replayed).toBe(false)
    const request = requests[0]
    expect(request?.method).toBe('POST')
    expect(new URL(request?.url ?? '').pathname).toBe('/api/teams/team%2Fa/triage-entries/manual-handoffs')
    expect(request?.headers.get('Authorization')).toBe('Bearer token-1')
    expect(request?.headers.get('Idempotency-Key')).toBe('key-1')
    expect(await request?.json()).toEqual(input)
  })

  test('surfaces the API error code', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'Forbidden', message: 'No access' }), { status: 403 })
    const identity = createShareHandoffIdentity(new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
    const input = createShareHandoffInput({ title: 'Bug', body: '' }, identity, 'Ada')

    await expect(createTriageManualHandoff('team-a', input, 'token-1', {
      idempotencyKey: 'key-1',
      correlationId: 'key-1',
    })).rejects.toMatchObject({ status: 403, code: 'Forbidden' })
  })
})

/**
 * Creates an in-memory Cache Storage holding one cache of JSON responses.
 *
 * @param entries - Initial key and JSON body pairs.
 * @returns The storage and its backing map.
 */
function createCacheStorage(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries))
  const opened: string[] = []
  const cache = {
    match: async (key: RequestInfo | URL) => {
      const body = store.get(String(key))
      return body === undefined ? undefined : new Response(body)
    },
    delete: async (key: RequestInfo | URL) => store.delete(String(key)),
  }
  const storage: SharedContentCacheStorage = {
    open: async (name: string) => {
      opened.push(name)
      return cache
    },
  }
  return { storage, store, opened }
}

const sharedId = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('shared content inbox', () => {
  test('reads only the text fields the worker stored', async () => {
    const { storage, opened } = createCacheStorage({
      [`${sharedContentKeyPrefix}${sharedId}`]: JSON.stringify({ title: 'Bug', text: 7, url: 'https://example.com', receivedAt: 1 }),
    })
    expect(await readStoredSharedContent(sharedId, storage)).toEqual({ title: 'Bug', text: '', url: 'https://example.com' })
    expect(opened).toEqual([sharedContentCacheName])
  })

  test('ignores IDs the worker could not have issued and missing content', async () => {
    const { storage, opened } = createCacheStorage({ '/__mukuroji/share/../secret': '{}' })
    expect(await readStoredSharedContent('../secret', storage)).toBeUndefined()
    expect(await readStoredSharedContent('', storage)).toBeUndefined()
    expect(opened).toEqual([])
    expect(await readStoredSharedContent(sharedId, storage)).toBeUndefined()
    expect(await readStoredSharedContent(sharedId, undefined)).toBeUndefined()
  })

  test('deletes a share after use', async () => {
    const { storage, store } = createCacheStorage({
      [`${sharedContentKeyPrefix}${sharedId}`]: '{}',
    })
    await discardStoredSharedContent(sharedId, storage)
    expect(store.size).toBe(0)
  })
})

describe('classifyShareHandoffFailure', () => {
  test('separates refused sends from ones that may have been saved', () => {
    expect(classifyShareHandoffFailure(new TriageApiError(403, 'No access', 'Forbidden'))).toBe('forbidden')
    expect(classifyShareHandoffFailure(new TriageApiError(401, 'Expired'))).toBe('forbidden')
    expect(classifyShareHandoffFailure(new TriageApiError(400, 'Invalid'))).toBe('rejected')
    expect(classifyShareHandoffFailure(new TriageApiError(422, 'Invalid'))).toBe('rejected')
    expect(classifyShareHandoffFailure(new TriageApiError(500, 'Down'))).toBe('uncertain')
    expect(classifyShareHandoffFailure(new TriageApiError(409, 'Conflict', 'TriageSourceConflict'))).toBe('uncertain')
    expect(classifyShareHandoffFailure(new TypeError('Failed to fetch'))).toBe('uncertain')
  })
})

describe('ShareCaptureForm', () => {
  test('preselects the only Team and fills in the shared content', () => {
    const markup = renderToStaticMarkup(
      <ShareCaptureForm
        initialContent={{ title: 'Bug', body: 'Details' }}
        isSubmitting={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        t={t}
        teams={[{ id: 'team-a', name: 'Core' }]}
      />,
    )
    expect(markup).toContain('<option value="team-a" selected="">Core</option>')
    expect(markup).toContain('value="Bug"')
    expect(markup).toContain('>Details</textarea>')
    expect(markup).toContain('aria-label="Send to Triage"')
  })

  test('asks for a Team when there are several', () => {
    const markup = renderToStaticMarkup(
      <ShareCaptureForm
        initialContent={{ title: 'Bug', body: '' }}
        isSubmitting={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        t={t}
        teams={[{ id: 'team-a', name: 'Core' }, { id: 'team-b', name: 'Ops' }]}
      />,
    )
    expect(markup).toContain('<option disabled="" value="" selected="">Select a Team</option>')
  })

  test('keeps Cancel when there is no destination or sending is unavailable', () => {
    for (const props of [{ teams: [] }, { teams: [{ id: 'team-a', name: 'Core' }], unavailableMessage: 'Guest accounts can’t send to Triage.' }]) {
      const markup = renderToStaticMarkup(
        <ShareCaptureForm
          initialContent={{ title: 'Bug', body: '' }}
          isSubmitting={false}
          onCancel={() => undefined}
          onSubmit={() => undefined}
          t={t}
          {...props}
        />,
      )
      expect(markup).not.toContain('<form')
      expect(markup).toContain('role="status"')
      expect(markup).toContain('>Cancel</button>')
    }
  })

  test('shows an uncertain send read-only and offers to resend it unchanged', () => {
    const markup = renderToStaticMarkup(
      <ShareCaptureForm
        errorMessage="We couldn’t confirm the send."
        initialContent={{ title: 'Original', body: 'Original body' }}
        isSubmitting={false}
        lockedSend={{ teamId: 'team-b', draft: { title: 'Sent title', body: 'Sent body' } }}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        t={t}
        teams={[{ id: 'team-a', name: 'Core' }, { id: 'team-b', name: 'Ops' }]}
      />,
    )
    expect(markup).toContain('<fieldset class="contents" disabled=""')
    expect(markup).toContain('<option value="team-b" selected="">Ops</option>')
    expect(markup).toContain('value="Sent title"')
    expect(markup).toContain('>Sent body</textarea>')
    expect(markup).toContain('Send the same content again')
    expect(markup).toContain('role="alert"')
  })

  test('keeps the form and Cancel inert while sending', () => {
    const markup = renderToStaticMarkup(
      <ShareCaptureForm
        initialContent={{ title: 'Bug', body: '' }}
        isSubmitting
        onCancel={() => undefined}
        onSubmit={() => undefined}
        t={t}
        teams={[{ id: 'team-a', name: 'Core' }]}
      />,
    )
    expect(markup).toContain('<fieldset class="contents" disabled=""')
    expect(markup).toMatch(/<button aria-disabled="true"[^>]*type="button">Cancel<\/button>/)
    expect(markup).toContain('Sending…')
  })
})

/**
 * Creates session storage backed by a map.
 *
 * @param entries - Initial entries.
 * @returns The storage and its backing map.
 */
function createSessionStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries))
  const storage: ShareHandoffStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
  return { storage, values }
}

const storedAttempt = {
  teamId: 'team-b',
  draft: { title: 'Sent title', body: 'Sent body' },
  input: {
    sourceId: 'share:uuid-1',
    title: 'Sent title',
    body: 'Sent body',
    requesterDisplayName: 'Ada',
    routingReason: 'Shared to mukuroji from a device',
    retentionExpiresAt: '2026-11-18T00:00:00.000Z',
  },
  context: { idempotencyKey: 'key-1', correlationId: 'key-1' },
}

describe('attempted share handoffs', () => {
  test('keeps a retried send locked even when the server now refuses it', () => {
    expect(resolveFailedAttempt(false, 'uncertain')).toBe('lock')
    expect(resolveFailedAttempt(false, 'forbidden')).toBe('forget')
    expect(resolveFailedAttempt(false, 'rejected')).toBe('forget')
    expect(resolveFailedAttempt(true, 'forbidden')).toBe('lock')
    expect(resolveFailedAttempt(true, 'rejected')).toBe('lock')
  })

  test('validates a stored attempt', () => {
    expect(readLockedShareHandoff(storedAttempt)).toEqual(storedAttempt)
    expect(readLockedShareHandoff({ ...storedAttempt, context: { idempotencyKey: '' } })).toBeUndefined()
    expect(readLockedShareHandoff({ ...storedAttempt, input: { ...storedAttempt.input, sourceId: 7 } })).toBeUndefined()
    expect(readLockedShareHandoff('nope')).toBeUndefined()
  })

  test('restores the locked send of the same share after a reload', () => {
    const { storage } = createSessionStorage({
      'mukuroji.shareHandoff:share-1': JSON.stringify(storedAttempt),
      'mukuroji.shareHandoff:broken': '{',
    })
    const seen: Record<string, unknown> = {}

    /**
     * Renders the hook state for one share key.
     *
     * @param props - Share key.
     * @returns Nothing visible.
     */
    function Probe({ handoffKey }: { readonly handoffKey: string }) {
      const controller = useShareHandoff({
        guardEnterpriseSession: (request) => request,
        requesterDisplayName: 'Ada',
        handoffKey,
        storage,
      })
      seen[handoffKey] = { locked: controller.locked, failure: controller.failure }
      return null
    }

    renderToStaticMarkup(<><Probe handoffKey="share-1" /><Probe handoffKey="share-2" /><Probe handoffKey="broken" /></>)
    expect(seen['share-1']).toEqual({ locked: storedAttempt, failure: 'uncertain' })
    expect(seen['share-2']).toEqual({ locked: undefined, failure: undefined })
    expect(seen.broken).toEqual({ locked: undefined, failure: undefined })
  })
})
