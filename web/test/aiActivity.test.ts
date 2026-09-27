import { describe, expect, test } from 'bun:test'
import { createAiActivityStore, getAiActivityPhase, getAiActivityStatus } from '../src/features/ai-assistance/model/aiActivity'
import { createAiActivityOrigin } from '../src/features/ai-assistance/model/aiActivityOrigin'

describe('session AI activity', () => {
  test('source navigation retains selection without storing search text or arbitrary URL fields', () => {
    expect(createAiActivityOrigin('/projects/core/issues', '?teamId=team&taskId=one&q=private&token=secret&panel=brief'))
      .toBe('/projects/core/issues?teamId=team&taskId=one&panel=brief')
    expect(createAiActivityOrigin('//outside.test', '')).toBe('')
  })
  test('concurrent operations retain independent outcomes and human review is not task completion', () => {
    let now = 1000
    const store = createAiActivityStore(() => now)
    const first = store.start({ task: 'planning', label: 'Task A', origin: '/home' })
    const second = store.start({ task: 'summary', origin: '/documents' })
    now = 2000
    store.update(first, 'review', 5000)
    store.update(second, 'failed')
    expect(store.getSnapshot().map((entry) => getAiActivityStatus(entry.phase))).toEqual(['failed', 'review'])
    store.update(first, 'deciding')
    store.update(first, 'approved')
    store.close(first)
    expect(store.getSnapshot().find((entry) => entry.id === first)?.phase).toBe('approved')
    expect(store.getSnapshot().find((entry) => entry.id === first)?.events).toEqual([
      { phase: 'generating', at: 1000 }, { phase: 'review', at: 2000 },
      { phase: 'deciding', at: 2000 }, { phase: 'approved', at: 2000 },
    ])
  })

  test('leaving the owning screen closes active processing and pending review', () => {
    const store = createAiActivityStore(() => 1000)
    const running = store.start({ task: 'summary', origin: '/home' })
    const review = store.start({ task: 'planning', origin: '/home' })
    store.update(review, 'review', 5000)
    store.close(running)
    store.close(review)
    expect(store.getSnapshot().every((entry) => entry.phase === 'closed')).toBe(true)
    const cancelled = store.start({ task: 'search', origin: '/search' })
    store.update(cancelled, 'cancelled')
    store.close(cancelled)
    expect(store.getSnapshot()[0].phase).toBe('cancelled')
  })

  test('expired drafts leave the review lane and can be removed with history', () => {
    let now = 1000
    const store = createAiActivityStore(() => now)
    const id = store.start({ task: 'summary', origin: '/home' })
    store.update(id, 'review', 2000)
    expect(getAiActivityPhase(store.getSnapshot()[0], 1999)).toBe('review')
    now = 2000
    expect(getAiActivityPhase(store.getSnapshot()[0], now)).toBe('expired')
    store.clearHistory()
    expect(store.getSnapshot()).toEqual([])
  })

  test('unavailable content removes source labels and navigation and stores are isolated', () => {
    const first = createAiActivityStore()
    const second = createAiActivityStore()
    const id = first.start({ task: 'triage', label: 'Private title', origin: '/requests?submission=private' })
    first.update(id, 'unavailable')
    expect(first.getSnapshot()[0].label).toBeUndefined()
    expect(first.getSnapshot()[0].origin).toBe('')
    expect(second.getSnapshot()).toEqual([])
  })

  test('an in-flight decision survives the review deadline and history clearing', () => {
    let now = 1000
    const store = createAiActivityStore(() => now)
    const id = store.start({ task: 'summary', origin: '/home' })
    store.update(id, 'review', 2000)
    now = 1999
    store.update(id, 'deciding')
    now = 2001
    expect(getAiActivityPhase(store.getSnapshot()[0], now)).toBe('deciding')
    store.clearHistory()
    expect(store.getSnapshot()).toHaveLength(1)
    store.update(id, 'approved')
    expect(store.getSnapshot()[0].phase).toBe('approved')
  })

  test('history stays bounded while retaining all active work and cannot resurrect cleared records', () => {
    const store = createAiActivityStore()
    const active = store.start({ task: 'planning', origin: '/home' })
    let last = ''
    for (let index = 0; index < 40; index++) {
      last = store.start({ task: 'search', origin: '/search' })
      store.update(last, 'rejected')
    }
    expect(store.getSnapshot()).toHaveLength(31)
    expect(store.getSnapshot().some((entry) => entry.id === active)).toBe(true)
    store.clearHistory()
    store.update(last, 'approved')
    expect(store.getSnapshot()).toHaveLength(1)
    expect(store.getSnapshot()[0].id).toBe(active)
  })

  test('clearing unavailable source content preserves a validated decision without retaining labels', () => {
    const store = createAiActivityStore()
    const id = store.start({ task: 'summary', origin: '/documents/private', label: 'Private title' })
    store.update(id, 'deciding')
    store.clearSource(id, 'approved')
    expect(store.getSnapshot()[0]).toMatchObject({ phase: 'approved', label: undefined, origin: '', sourceUnavailable: true })
    store.clearSource(id)
    expect(store.getSnapshot()[0].phase).toBe('approved')
    const undecided = store.start({ task: 'summary', origin: '/home' })
    store.clearSource(undecided)
    expect(store.getSnapshot()[0].phase).toBe('unavailable')
  })

  test('subscribers observe changes and can unsubscribe without losing snapshot stability', () => {
    const store = createAiActivityStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => calls++)
    const initial = store.getSnapshot()
    expect(store.getSnapshot()).toBe(initial)
    const id = store.start({ task: 'summary', origin: '/home' })
    expect(calls).toBe(1)
    expect(store.getSnapshot()).not.toBe(initial)
    unsubscribe()
    store.update(id, 'failed')
    expect(calls).toBe(1)
  })
})
