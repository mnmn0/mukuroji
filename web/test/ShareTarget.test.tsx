import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createShareHandoffIdentity,
  createShareHandoffInput,
  readSharedContent,
  sharedBodyMaxLength,
  sharedTitleMaxLength,
} from '../src/features/share-capture/model/sharedContent'
import { ShareCaptureForm } from '../src/features/share-capture/ui/ShareCaptureForm'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTriageManualHandoff } from '../src/triage/api'
import { triageEntryFixtures } from '../src/triage/fixtures'

const originalFetch = globalThis.fetch
const t = createTranslator('en')

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('readSharedContent', () => {
  test('uses the shared title and keeps the text and link in the body', () => {
    const content = readSharedContent(new URLSearchParams({
      title: '  Checkout\nfails ',
      text: 'Steps:\r\n1. Open the cart',
      url: 'https://example.com/cart',
    }))
    expect(content).toEqual({
      title: 'Checkout fails',
      body: 'Steps:\n1. Open the cart\n\nhttps://example.com/cart',
    })
  })

  test('falls back to the first text line, then the link, for the title', () => {
    expect(readSharedContent(new URLSearchParams({ text: '\n  First line \nSecond' })).title).toBe('First line')
    expect(readSharedContent(new URLSearchParams({ url: 'https://example.com/a' }))).toEqual({
      title: 'https://example.com/a',
      body: 'https://example.com/a',
    })
  })

  test('does not repeat a link the text already contains', () => {
    const content = readSharedContent(new URLSearchParams({
      text: 'See https://example.com/a',
      url: 'https://example.com/a',
    }))
    expect(content.body).toBe('See https://example.com/a')
  })

  test('removes control characters and cuts values to the API limits', () => {
    const content = readSharedContent(new URLSearchParams({
      title: `a\u0000b\u001b${'x'.repeat(600)}`,
      text: `line\u0007\t${'y'.repeat(9_000)}`,
    }))
    expect(content.title.startsWith('ab')).toBe(true)
    expect(content.title.length).toBe(sharedTitleMaxLength)
    expect(content.body.startsWith('line\t')).toBe(true)
    expect(content.body.length).toBe(sharedBodyMaxLength)
  })

  test('does not split a surrogate pair at the limit', () => {
    const title = `${'x'.repeat(sharedTitleMaxLength - 1)}😀`
    expect(readSharedContent(new URLSearchParams({ title })).title).toBe('x'.repeat(sharedTitleMaxLength - 1))
  })

  test('returns empty values when nothing was shared', () => {
    expect(readSharedContent(new URLSearchParams())).toEqual({ title: '', body: '' })
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

  test('explains when there is no destination Team', () => {
    const markup = renderToStaticMarkup(
      <ShareCaptureForm
        initialContent={{ title: 'Bug', body: '' }}
        isSubmitting={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        t={t}
        teams={[]}
      />,
    )
    expect(markup).toContain('There is no Team you can send to.')
    expect(markup).not.toContain('<form')
  })

  test('announces a failed send and keeps the form disabled while sending', () => {
    const markup = renderToStaticMarkup(
      <ShareCaptureForm
        errorMessage="Could not send to Triage. Try again."
        initialContent={{ title: 'Bug', body: '' }}
        isSubmitting
        onCancel={() => undefined}
        onSubmit={() => undefined}
        t={t}
        teams={[{ id: 'team-a', name: 'Core' }]}
      />,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('<fieldset class="contents" disabled=""')
    expect(markup).toContain('Sending…')
  })
})
