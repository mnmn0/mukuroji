import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { aiSummaryGenerationFixture } from '../src/features/ai-assistance/fixtures'
import { createAiActivityStore, type AiActivityStore } from '../src/features/ai-assistance/model/aiActivity'
import { useAiAssistanceController, type AiAssistanceController } from '../src/features/ai-assistance/mutations/useAiAssistanceController'
import { AiActivityContext } from '../src/features/ai-assistance/queries/aiActivityContext'

const originalFetch = globalThis.fetch
const input = { task: 'summary', locale: 'en', sources: [{ type: 'document', documentId: 'doc-1', expectedRevision: 1 }] } satisfies Parameters<AiAssistanceController['generate']>[0]

afterEach(() => { globalThis.fetch = originalFetch })

/** Captures explicit controller actions while keeping its optional session context real. */
function controllerFor(store: AiActivityStore): AiAssistanceController {
  let controller: AiAssistanceController | undefined
  /** Captures the hook's event handlers without issuing a render-time request. */
  function Capture() {
    controller = useAiAssistanceController({ accessToken: 'test-token', activityLabel: 'Visible document' })
    return null
  }
  renderToStaticMarkup(
    <AiActivityContext.Provider value={{ store, origin: '/documents/doc-1', openBoard: () => undefined }}>
      <Capture />
    </AiActivityContext.Provider>,
  )
  if (!controller) throw new Error('Controller was not rendered')
  return controller
}

/** Provides a currently retained response through the real transport validator. */
function availableResponse(): Response {
  return Response.json({ ...aiSummaryGenerationFixture,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })
}

describe('AI controller activity integration', () => {
  test('records explicit generation and the authorized response without copying draft content', async () => {
    globalThis.fetch = Object.assign(() => Promise.resolve(availableResponse()), originalFetch)
    const store = createAiActivityStore()
    const controller = controllerFor(store)
    expect(store.getSnapshot()).toEqual([])
    const pending = controller.generate(input)
    expect(store.getSnapshot()[0].phase).toBe('generating')
    expect((await pending)?.task).toBe('summary')
    expect(store.getSnapshot()[0]).toMatchObject({ phase: 'review', label: 'Visible document', origin: '/documents/doc-1' })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('citations')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('test-token')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('draft')
  })

  test('a cancelled request cannot publish its late result or overwrite a replacement operation', async () => {
    const response = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<void>()
    globalThis.fetch = Object.assign(() => { entered.resolve(); return response.promise }, originalFetch)
    const store = createAiActivityStore()
    const controller = controllerFor(store)
    const pending = controller.generate(input)
    await entered.promise
    controller.cancelGeneration()
    expect(store.getSnapshot()[0].phase).toBe('cancelled')
    response.resolve(availableResponse())
    expect(await pending).toBeUndefined()
    expect(store.getSnapshot()[0].phase).toBe('cancelled')
    globalThis.fetch = Object.assign(() => Promise.resolve(availableResponse()), originalFetch)
    await controller.generate(input)
    expect(store.getSnapshot().map((activity) => activity.phase)).toEqual(['review', 'cancelled'])
  })

  test('permission errors redact source metadata while provider failures remain retryable', async () => {
    globalThis.fetch = Object.assign(() => Promise.resolve(Response.json({ code: 'AiAssistanceAuthorizationChanged' }, { status: 403 })), originalFetch)
    const store = createAiActivityStore()
    const controller = controllerFor(store)
    await controller.generate(input)
    expect(store.getSnapshot()[0]).toMatchObject({ phase: 'unavailable', label: undefined, origin: '' })
    globalThis.fetch = Object.assign(() => Promise.resolve(Response.json({ code: 'ProviderFailure' }, { status: 502 })), originalFetch)
    await controller.generate(input)
    expect(store.getSnapshot()[0].phase).toBe('failed')
  })
})
