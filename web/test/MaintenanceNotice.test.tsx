import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MaintenanceNotice } from '../src/app/MaintenanceNotice'
import {
  createMaintenanceStore,
  installMaintenanceFetchObserver,
  type MaintenanceNoticeState,
  type MaintenanceStore,
} from '../src/shared/api/maintenance'

/** One fake repeating timer. */
type FakeTimer = {
  /** Callback run on each tick. */
  readonly callback: () => void
  /** Whether the timer was stopped. */
  stopped: boolean
}

/**
 * Creates a store against `https://app.example.com/api` with a fake timer and status answers.
 *
 * @param statuses - Bodies returned by successive status requests.
 * @returns The store, the started timers, and the requested status URLs.
 */
function createTestStore(statuses: unknown[] = []) {
  const timers: FakeTimer[] = []
  const statusRequests: string[] = []
  const store = createMaintenanceStore({
    apiBaseUrls: ['/api'],
    origin: 'https://app.example.com/work',
    fetchStatus: async (url) => {
      statusRequests.push(url)
      return Response.json(statuses.shift() ?? { state: 'none' })
    },
    startTimer: (callback) => {
      const timer: FakeTimer = { callback, stopped: false }
      timers.push(timer)
      return () => {
        timer.stopped = true
      }
    },
  })
  return { store, timers, statusRequests }
}

/**
 * Builds a response with an optional maintenance header.
 *
 * @param status - HTTP status.
 * @param maintenance - Maintenance header value.
 * @returns The response.
 */
function response(status: number, maintenance?: string) {
  return new Response(null, { status, headers: maintenance ? { 'Mukuroji-Maintenance': maintenance } : {} })
}

/**
 * Creates a store that always reports one state.
 *
 * @param state - Reported state.
 * @returns A fixed store.
 */
function fixedMaintenance(state: MaintenanceNoticeState): MaintenanceStore {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
    observe: () => undefined,
    refresh: async () => undefined,
  }
}

describe('createMaintenanceStore', () => {
  test('follows the maintenance header and clears on a later ordinary API answer', () => {
    const { store, timers } = createTestStore()
    let notified = 0
    store.subscribe(() => { notified += 1 })

    store.observe('/api/teams/a/issues', response(200, 'read-only'))
    expect(store.getSnapshot()).toBe('read-only')
    expect(timers).toHaveLength(1)
    store.observe('/api/teams/a/issues', response(503, 'read-only'))
    expect(notified).toBe(1)

    // Ungated paths, failures, and other origins say nothing about the maintenance.
    store.observe('/api/health', response(200))
    store.observe('/api/teams/a/issues', response(503))
    store.observe('https://other.example.com/api/teams', response(200))
    store.observe('/assets/app.js', response(200))
    expect(store.getSnapshot()).toBe('read-only')

    store.observe('https://app.example.com/api/teams/a/issues', response(404))
    expect(store.getSnapshot()).toBe('none')
    expect(timers[0]?.stopped).toBe(true)
    expect(notified).toBe(2)
  })

  test('polls the status while a maintenance is shown', async () => {
    const { store, timers, statusRequests } = createTestStore([{ state: 'stopped' }, { state: 'unavailable' }])
    store.observe('/api/me', response(503, 'stopped'))
    expect(store.getSnapshot()).toBe('stopped')

    timers[0]?.callback()
    await store.refresh()
    expect(statusRequests).toEqual(['https://app.example.com/api/maintenance', 'https://app.example.com/api/maintenance'])
    // An outage is not a maintenance.
    expect(store.getSnapshot()).toBe('none')
  })

  test('keeps the state when the status cannot be read', async () => {
    const { store } = createTestStore([{ state: 'paused' }])
    store.observe('/api/me', response(200, 'read-only'))
    await store.refresh()
    expect(store.getSnapshot()).toBe('read-only')
  })
})

describe('installMaintenanceFetchObserver', () => {
  test('passes responses through while the store learns from them', async () => {
    const { store } = createTestStore()
    const target: { fetch: typeof fetch } = {
      fetch: async () => response(503, 'read-only'),
    }
    const restore = installMaintenanceFetchObserver(target, store)
    const result = await target.fetch('/api/teams/a/issues', { method: 'POST' })
    expect(result.status).toBe(503)
    expect(store.getSnapshot()).toBe('read-only')
    restore()
  })
})

describe('MaintenanceNotice', () => {
  test('explains read-only and stopped maintenance and hides otherwise', () => {
    const readOnly = renderToStaticMarkup(<MaintenanceNotice maintenance={fixedMaintenance('read-only')} />)
    expect(readOnly).toContain('data-maintenance-state="read-only"')
    expect(readOnly).toContain('メンテナンス中のため閲覧だけできます')
    const stopped = renderToStaticMarkup(<MaintenanceNotice maintenance={fixedMaintenance('stopped')} />)
    expect(stopped).toContain('障害ではありません')
    expect(renderToStaticMarkup(<MaintenanceNotice maintenance={fixedMaintenance('none')} />)).toBe('')
  })
})
