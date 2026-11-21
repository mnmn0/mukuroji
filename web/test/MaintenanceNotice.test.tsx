import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MaintenanceBanner } from '../src/app/MaintenanceNotice'
import {
  applyMaintenanceObservation,
  fetchMaintenanceStatus,
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

  test('clears only on an ordinary gated answer from an API', () => {
    expect(readMaintenanceObservation('/api/teams', response(404), bases, pageUrl))
      .toEqual({ kind: 'clear', state: 'none', apiBaseUrl: sharedApi })
    for (const [url, result] of [
      ['/api/health', response(200)],
      ['/api/teams', response(503)],
      ['https://other.example.com/api/teams', response(200)],
      ['/assets/app.js', response(200)],
    ] as const) {
      expect(readMaintenanceObservation(url, result, bases, pageUrl)).toBeUndefined()
    }
  })
})

describe('applyMaintenanceObservation', () => {
  test('lets only the reporting API end its maintenance', () => {
    const reported = applyMaintenanceObservation(undefined, { kind: 'report', state: 'read-only', apiBaseUrl: workspaceApi })
    expect(reported).toEqual({ state: 'read-only', apiBaseUrl: workspaceApi })
    expect(applyMaintenanceObservation(reported, { kind: 'clear', state: 'none', apiBaseUrl: sharedApi })).toBe(reported)
    expect(applyMaintenanceObservation(reported, { kind: 'clear', state: 'none', apiBaseUrl: workspaceApi })).toEqual({ state: 'none' })
  })
})

describe('fetchMaintenanceStatus', () => {
  test('asks the reporting API and treats an outage as no maintenance', async () => {
    const requested: string[] = []
    const answers = [{ state: 'stopped' }, { state: 'unavailable' }, { state: 'paused' }]
    const send: typeof fetch = async (input) => {
      requested.push(String(input))
      return Response.json(answers.shift())
    }
    expect(await fetchMaintenanceStatus(workspaceApi, send)).toEqual({ state: 'stopped', apiBaseUrl: workspaceApi })
    expect(await fetchMaintenanceStatus(workspaceApi, send)).toEqual({ state: 'none' })
    await expect(fetchMaintenanceStatus(workspaceApi, send)).rejects.toThrow('unreadable')
    expect(requested[0]).toBe(`${workspaceApi}/maintenance`)
  })
})

describe('installMaintenanceFetchObserver', () => {
  test('passes responses through while reporting what they say', async () => {
    const observations: MaintenanceObservation[] = []
    const target: { fetch: typeof fetch } = {
      fetch: async () => response(503, 'read-only'),
    }
    const restore = installMaintenanceFetchObserver(target, (observation) => observations.push(observation))
    const result = await target.fetch('http://localhost/api/teams/a/issues', { method: 'POST' })
    expect(result.status).toBe(503)
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
