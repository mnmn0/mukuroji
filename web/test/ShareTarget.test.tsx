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
  cancelStoredSharedContent,
  discardStoredSharedContent,
  readSharedContentSendState,
  readStoredSharedContent,
  sharedContentCacheName,
  sharedContentKeyPrefix,
  sharedContentMaxAgeMilliseconds,
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
    const identity = createShareHandoffIdentity('', new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
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

  test('uses the stored share ID as the source in every tab and rounds retention to the day', () => {
    const morning = createShareHandoffIdentity('0f8fad5b', new Date('2026-10-19T01:00:00.000Z'), () => 'uuid-a')
    const evening = createShareHandoffIdentity('0f8fad5b', new Date('2026-10-19T23:00:00.000Z'), () => 'uuid-b')
    expect(morning).toEqual(evening)
    expect(morning.sourceId).toBe('share:0f8fad5b')
  })

  test('derives retention from when the share was received, so a later day sends the same handoff', () => {
    const receivedAt = new Date('2026-10-19T23:59:00.000Z')
    expect(createShareHandoffIdentity('0f8fad5b', receivedAt, () => 'uuid-a'))
      .toEqual(createShareHandoffIdentity('0f8fad5b', new Date(receivedAt.getTime()), () => 'uuid-b'))
    expect(createShareHandoffIdentity('0f8fad5b', receivedAt).retentionExpiresAt).toBe('2026-11-18T00:00:00.000Z')
  })

  test('falls back to a requester name the API accepts', () => {
    const identity = createShareHandoffIdentity('', new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
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
    const identity = createShareHandoffIdentity('', new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
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
    const identity = createShareHandoffIdentity('', new Date('2026-10-19T00:00:00.000Z'), () => 'uuid-1')
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
    put: async (key: RequestInfo | URL, response: Response) => {
      store.set(String(key), await response.text())
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
const account = 'workspace-1/ada'

describe('shared content inbox', () => {
  test('reads only the text fields the worker stored', async () => {
    const { storage, opened } = createCacheStorage({
      [`${sharedContentKeyPrefix}${sharedId}`]: JSON.stringify({ title: 'Bug', text: 7, url: 'https://example.com', receivedAt: 1 }),
    })
    expect(await readStoredSharedContent(sharedId, account, storage, 1_000)).toEqual({ title: 'Bug', text: '', url: 'https://example.com', receivedAt: 1 })
    expect(opened).toEqual([sharedContentCacheName])
  })

  test('deletes and ignores content past the retention window', async () => {
    const key = `${sharedContentKeyPrefix}${sharedId}`
    const { storage, store } = createCacheStorage({
      [key]: JSON.stringify({ title: 'Old', text: '', url: '', receivedAt: 0 }),
    })
    expect(await readStoredSharedContent(sharedId, account, storage, sharedContentMaxAgeMilliseconds)).toEqual({ title: 'Old', text: '', url: '', receivedAt: 0 })
    expect(await readStoredSharedContent(sharedId, account, storage, sharedContentMaxAgeMilliseconds + 1)).toBeUndefined()
    expect(store.has(key)).toBe(false)
  })

  test('treats content without a receive time as expired', async () => {
    const { storage } = createCacheStorage({
      [`${sharedContentKeyPrefix}${sharedId}`]: JSON.stringify({ title: 'Bug', text: '', url: '' }),
    })
    expect(await readStoredSharedContent(sharedId, account, storage, 1_000)).toBeUndefined()
  })

  test('ignores IDs the worker could not have issued and missing content', async () => {
    const { storage, opened } = createCacheStorage({ '/__mukuroji/share/../secret': '{}' })
    expect(await readStoredSharedContent('../secret', account, storage)).toBeUndefined()
    expect(await readStoredSharedContent('', account, storage)).toBeUndefined()
    expect(opened).toEqual([])
    expect(await readStoredSharedContent(sharedId, account, storage)).toBeUndefined()
    expect(await readStoredSharedContent(sharedId, account, undefined)).toBeUndefined()
  })

  test('cancels a share for every tab with a marker that reads as missing', async () => {
    const key = `${sharedContentKeyPrefix}${sharedId}`
    const { storage, store } = createCacheStorage({
      [key]: JSON.stringify({ title: 'Bug', text: '', url: '', receivedAt: 1 }),
    })
    expect(await readSharedContentSendState(sharedId, account, storage, 10)).toBe('live')
    await cancelStoredSharedContent(sharedId, account, storage, 5)
    expect(JSON.parse(store.get(key) ?? '{}')).toEqual({ cancelled: true, receivedAt: 5 })
    expect(await readSharedContentSendState(sharedId, account, storage, 10)).toBe('gone')
    expect(await readStoredSharedContent(sharedId, account, storage, 10)).toBeUndefined()
  })

  test('sends only a live share and fails closed when storage cannot be read', async () => {
    const key = `${sharedContentKeyPrefix}${sharedId}`
    const { storage, store } = createCacheStorage({
      [key]: JSON.stringify({ title: 'Bug', text: '', url: '', receivedAt: 0 }),
    })
    expect(await readSharedContentSendState(sharedId, account, storage, sharedContentMaxAgeMilliseconds + 1)).toBe('gone')
    store.delete(key)
    expect(await readSharedContentSendState(sharedId, account, storage, 1)).toBe('gone')
    expect(await readSharedContentSendState('', account, storage)).toBe('live')
    const broken: SharedContentCacheStorage = { open: async () => { throw new Error('blocked') } }
    expect(await readSharedContentSendState(sharedId, account, broken)).toBe('unverified')
  })

  test('binds a share to the first signed-in account and hides it from others', async () => {
    const key = `${sharedContentKeyPrefix}${sharedId}`
    const { storage, store } = createCacheStorage({
      [key]: JSON.stringify({ title: 'Secret', text: '', url: '', receivedAt: 1 }),
    })
    expect(await readStoredSharedContent(sharedId, account, storage, 10)).toMatchObject({ title: 'Secret' })
    expect(JSON.parse(store.get(key) ?? '{}')).toMatchObject({ accountKey: account })
    expect(await readStoredSharedContent(sharedId, 'workspace-2/bob', storage, 10)).toBeUndefined()
    expect(await readSharedContentSendState(sharedId, 'workspace-2/bob', storage, 10)).toBe('gone')
    // Another account leaving the form never cancels the share.
    await cancelStoredSharedContent(sharedId, 'workspace-2/bob', storage, 20)
    expect(await readStoredSharedContent(sharedId, account, storage, 10)).toMatchObject({ title: 'Secret' })
  })

  test('serializes the first binding so two accounts reading at once cannot both see a share', async () => {
    const key = `${sharedContentKeyPrefix}${sharedId}`
    const { storage } = createCacheStorage({
      [key]: JSON.stringify({ title: 'Secret', text: '', url: '', receivedAt: 1 }),
    })
    let queue: Promise<unknown> = Promise.resolve()
    const lockNames: string[] = []
    const runExclusive = <Result,>(name: string, task: () => Promise<Result>): Promise<Result> => {
      lockNames.push(name)
      const run = queue.then(task)
      queue = run.catch(() => undefined)
      return run
    }
    const [first, second] = await Promise.all([
      readStoredSharedContent(sharedId, account, storage, 10, runExclusive),
      readStoredSharedContent(sharedId, 'workspace-2/bob', storage, 10, runExclusive),
    ])
    expect(first).toMatchObject({ title: 'Secret' })
    expect(second).toBeUndefined()
    expect(lockNames).toEqual([`mukuroji-share-${sharedId}`, `mukuroji-share-${sharedId}`])
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
      'mukuroji.shareHandoff:ws-1%2Fada:share-1': JSON.stringify(storedAttempt),
      'mukuroji.shareHandoff:ws-1%2Fada:broken': '{',
    })
    const seen: Record<string, unknown> = {}

    /**
     * Renders the hook state for one share key.
     *
     * @param props - Share key.
     * @returns Nothing visible.
     */
    function Probe({ handoffKey, accountKey = 'ws-1/ada' }: { readonly handoffKey: string, readonly accountKey?: string }) {
      const controller = useShareHandoff({
        guardEnterpriseSession: (request) => request,
        requesterDisplayName: 'Ada',
        handoffKey,
        accountKey,
        storage,
      })
      seen[`${accountKey}:${handoffKey}`] = { locked: controller.locked, failure: controller.failure }
      if (handoffKey === 'share-1' && accountKey === 'ws-1/ada') seen.controller = controller
      return null
    }

    renderToStaticMarkup(<><Probe handoffKey="share-1" /><Probe handoffKey="share-2" /><Probe handoffKey="broken" /><Probe accountKey="ws-2/bob" handoffKey="share-1" /></>)
    expect(seen['ws-1/ada:share-1']).toEqual({ locked: storedAttempt, failure: 'uncertain' })
    // Another account signed in on the same tab never restores the first account's send.
    expect(seen['ws-2/bob:share-1']).toEqual({ locked: undefined, failure: undefined })
    expect(seen['ws-1/ada:share-2']).toEqual({ locked: undefined, failure: undefined })
    expect(seen['ws-1/ada:broken']).toEqual({ locked: undefined, failure: undefined })
  })

  test('abandoning a share deletes its stored attempt', () => {
    const { storage, values } = createSessionStorage({
      'mukuroji.shareHandoff:ws-1%2Fada:share-1': JSON.stringify(storedAttempt),
    })
    let controller: ReturnType<typeof useShareHandoff> | undefined

    /**
     * Captures the hook controller.
     *
     * @returns Nothing visible.
     */
    function Probe() {
      controller = useShareHandoff({
        guardEnterpriseSession: (request) => request,
        requesterDisplayName: 'Ada',
        handoffKey: 'share-1',
        accountKey: 'ws-1/ada',
        storage,
      })
      return null
    }

    renderToStaticMarkup(<Probe />)
    expect(controller?.locked).toEqual(storedAttempt)
    controller?.abandon()
    expect(values.size).toBe(0)
  })

  test('refuses a first send when its replay state cannot be stored', async () => {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return new Response('{}', { status: 500 })
    }
    const failing: ShareHandoffStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => undefined,
    }
    let controller: ReturnType<typeof useShareHandoff> | undefined

    /**
     * Captures the hook controller.
     *
     * @returns Nothing visible.
     */
    function Probe() {
      controller = useShareHandoff({
        accessToken: 'token-1',
        guardEnterpriseSession: (request) => request,
        requesterDisplayName: 'Ada',
        handoffKey: 'share-1',
        accountKey: 'ws-1/ada',
        storage: failing,
      })
      return null
    }

    renderToStaticMarkup(<Probe />)
    expect(await controller?.submit('team-a', { title: 'Bug', body: '' })).toBeUndefined()
    expect(requests).toEqual([])
  })
})
