import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MaintenanceBanner } from '../src/app/maintenance/MaintenanceNotice'
import {
  applyMaintenanceObservation,
  refreshMaintenanceStatus,
  summarizeMaintenanceState,
} from '../src/app/maintenance/queries/maintenanceStatus'
import {
  fetchMaintenanceState,
  installMaintenanceFetchObserver,
  readMaintenanceObservation,
  type MaintenanceObservation,
} from '../src/shared/api/maintenance'

const pageUrl = 'https://app.example.com/work'
const sharedApi = 'https://app.example.com/api'
const workspaceApi = 'https://workspace.example.com/api'
const bases = [sharedApi, workspaceApi]

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

describe('readMaintenanceObservation', () => {
  test('reports the header with the API that sent it', () => {
    expect(readMaintenanceObservation('/api/teams/a/issues', response(200, 'read-only'), bases, pageUrl))
      .toEqual({ kind: 'report', state: 'read-only', apiBaseUrl: sharedApi })
    expect(readMaintenanceObservation(`${workspaceApi}/documents`, response(503, 'stopped'), bases, pageUrl))
      .toEqual({ kind: 'report', state: 'stopped', apiBaseUrl: workspaceApi })
  })

  test('attributes a request to the most specific nested base', () => {
    const nestedApi = `${sharedApi}/workspace`
    for (const order of [[sharedApi, nestedApi], [nestedApi, sharedApi]]) {
      expect(readMaintenanceObservation('/api/workspace/documents', response(503, 'read-only'), order, pageUrl))
        .toEqual({ kind: 'report', state: 'read-only', apiBaseUrl: nestedApi })
      expect(readMaintenanceObservation('/api/teams', response(200, 'read-only'), order, pageUrl))
        .toEqual({ kind: 'report', state: 'read-only', apiBaseUrl: sharedApi })
    }
  })

  test('clears only on an ordinary gated answer from an API', () => {
    expect(readMaintenanceObservation('/api/teams', response(404), bases, pageUrl))
      .toEqual({ kind: 'clear', state: 'none', apiBaseUrl: sharedApi })
    for (const [url, result] of [
      ['/api/health', response(200)],
      ['/api/maintenance', response(200)],
      ['/api/teams', response(503)],
      ['https://other.example.com/api/teams', response(200)],
      ['/assets/app.js', response(200)],
    ] as const) {
      expect(readMaintenanceObservation(url, result, bases, pageUrl)).toBeUndefined()
    }
  })
})

describe('applyMaintenanceObservation', () => {
  test('keeps each API in maintenance until that API recovers', () => {
    const stopped = applyMaintenanceObservation(undefined, { kind: 'report', state: 'stopped', apiBaseUrl: workspaceApi })
    const both = applyMaintenanceObservation(stopped, { kind: 'report', state: 'read-only', apiBaseUrl: sharedApi })
    expect(summarizeMaintenanceState(both)).toBe('stopped')
    const sharedBack = applyMaintenanceObservation(both, { kind: 'clear', state: 'none', apiBaseUrl: sharedApi })
    expect(sharedBack).toEqual({ apis: { [workspaceApi]: 'stopped' } })
    expect(summarizeMaintenanceState(sharedBack)).toBe('stopped')
    const allBack = applyMaintenanceObservation(sharedBack, { kind: 'clear', state: 'none', apiBaseUrl: workspaceApi })
    expect(summarizeMaintenanceState(allBack)).toBe('none')
    // A clear from an API that was never in maintenance changes nothing.
    expect(applyMaintenanceObservation(allBack, { kind: 'clear', state: 'none', apiBaseUrl: sharedApi })).toBe(allBack)
  })
})

describe('refreshMaintenanceStatus', () => {
  test('asks every API in maintenance and keeps a state it could not refresh', async () => {
    const requested: string[] = []
    const send: typeof fetch = async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.startsWith(workspaceApi)) return new Response(null, { status: 502 })
      return Response.json({ state: 'unavailable' })
    }
    const status = { apis: { [sharedApi]: 'read-only', [workspaceApi]: 'stopped' } } as const
    expect(await refreshMaintenanceStatus(status, send)).toEqual({ apis: { [workspaceApi]: 'stopped' } })
    expect(requested.sort()).toEqual([`${sharedApi}/maintenance`, `${workspaceApi}/maintenance`])
  })

  test('gives up on a status answer that never arrives', async () => {
    const send: typeof fetch = async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }
    const status = { apis: { [workspaceApi]: 'stopped' } } as const
    expect(await refreshMaintenanceStatus(status, send)).toBe(status)
  })

  test('reads each reported state', async () => {
    const answers = [{ state: 'stopped' }, { state: 'paused' }]
    const send: typeof fetch = async () => Response.json(answers.shift())
    expect(await fetchMaintenanceState(workspaceApi, send)).toBe('stopped')
    await expect(fetchMaintenanceState(workspaceApi, send)).rejects.toThrow('unreadable')
  })
})

describe('installMaintenanceFetchObserver', () => {
  test('passes responses through while reporting what they say', async () => {
    const observations: MaintenanceObservation[] = []
    const target: { fetch: typeof fetch } = {
      fetch: async () => response(503, 'read-only'),
    }
    const restore = installMaintenanceFetchObserver((observation) => observations.push(observation), target)
    const result = await target.fetch('http://localhost/api/teams/a/issues', { method: 'POST' })
    expect(result.status).toBe(503)
    expect(observations).toEqual([{ kind: 'report', state: 'read-only', apiBaseUrl: 'http://localhost/api' }])
    restore()
  })

  test('ignores a response to a request older than one already reported', async () => {
    const observations: MaintenanceObservation[] = []
    const pending: Array<(value: Response) => void> = []
    const target: { fetch: typeof fetch } = {
      fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
    }
    const restore = installMaintenanceFetchObserver((observation) => observations.push(observation), target)
    const older = target.fetch('http://localhost/api/teams')
    const newer = target.fetch('http://localhost/api/teams')
    pending[1]?.(response(200, 'read-only'))
    await newer
    pending[0]?.(response(200))
    expect((await older).status).toBe(200)
    expect(observations).toEqual([{ kind: 'report', state: 'read-only', apiBaseUrl: 'http://localhost/api' }])
    restore()
  })
})

describe('MaintenanceBanner', () => {
  test('explains read-only and stopped maintenance and hides otherwise', () => {
    const readOnly = renderToStaticMarkup(<MaintenanceBanner state="read-only" />)
    expect(readOnly).toContain('data-maintenance-state="read-only"')
    expect(readOnly).toContain('メンテナンス中のため閲覧だけできます')
    expect(renderToStaticMarkup(<MaintenanceBanner state="stopped" />)).toContain('障害ではありません')
    expect(renderToStaticMarkup(<MaintenanceBanner state="none" />)).toBe('')
  })
})
