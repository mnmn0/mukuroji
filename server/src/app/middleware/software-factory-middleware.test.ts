import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'
import { registerSoftwareFactoryMiddleware } from './software-factory-middleware'

/** Requests the gate must refuse while Software factory is not deployed. */
const SOFTWARE_FACTORY_REQUESTS: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/api/teams/team-1/work-items/item-1/agent-runs'],
  ['GET', '/api/teams/team-1/work-items/item-1/agent-run-reports'],
  ['GET', '/api/teams/team-1/agent-runs'],
  ['GET', '/api/teams/team-1/agent-runs/analytics'],
  ['POST', '/api/teams/team-1/agent-runs/run-1/release'],
  ['GET', '/api/teams/team-1/agent-settings'],
  ['PUT', '/api/teams/team-1/agent-settings'],
  ['POST', '/api/v1/work-items/item-1/agent-runs'],
  ['GET', '/api/v1/work-items/item-1/agent-runs'],
  ['POST', '/api/v1/work-items/item-1/agent-runs/resume'],
  ['POST', '/api/v1/work-items/item-1/agent-runs/run-1/take-over'],
  ['GET', '/api/v1/agent-runs'],
  ['GET', '/api/v1/agent-runs/run-1'],
  ['POST', '/api/v1/agent-runs/run-1/heartbeat'],
  ['POST', '/api/v1/agent-runs/run-1/finish'],
  ['POST', '/api/v1/agent-runs/run-1/reports'],
  ['GET', '/api/v1/agent-settings'],
  ['GET', '/api/v1/agent-context'],
  ['GET', '/api/developer/me/agent-connection'],
  ['POST', '/api/developer/me/api-keys'],
  ['POST', '/api/developer/me/api-keys/key-1/rotate'],
]

/** Requests that stay open without Software factory. */
const WBS_REQUESTS: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/api/v1/work-items'],
  ['GET', '/api/v1/work-items/item-1'],
  ['GET', '/api/v1/work-items/item-1/actual-dates'],
  ['GET', '/api/v1/me'],
  ['GET', '/api/v1/teams'],
  ['GET', '/api/v1/projects/project-1/members'],
  ['GET', '/api/v1/work-item-keys/ABC-1'],
  ['DELETE', '/api/developer/me/api-keys/key-1'],
  ['GET', '/api/developer/api-keys'],
  ['GET', '/api/teams/team-1/work-items/item-1'],
]

/**
 * Creates an app whose every route answers 200, behind the gate.
 *
 * @param deployed - Value the gate reads for the deployment switch.
 * @returns The test application.
 */
function createGatedApp(deployed: boolean): Hono {
  const app = new Hono()
  registerSoftwareFactoryMiddleware(app, { deployed: () => deployed })
  app.all('*', (context) => context.json({ ok: true }))
  return app
}

test('refuses every Software factory route with 503 when the module is not deployed', async () => {
  const app = createGatedApp(false)

  for (const [method, path] of SOFTWARE_FACTORY_REQUESTS) {
    const response = await app.request(path, { method })
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 503 })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ code: 'SoftwareFactoryNotDeployed' })
  }
})

test('answers Public API clients with a non-retryable problem document', async () => {
  const response = await createGatedApp(false).request('/api/v1/agent-runs/run-1/heartbeat', {
    method: 'POST',
  })

  expect(response.status).toBe(503)
  expect(response.headers.get('Content-Type')).toContain('application/problem+json')
  expect(await response.json()).toMatchObject({
    status: 503,
    code: 'SoftwareFactoryNotDeployed',
    retryable: false,
    instance: '/api/v1/agent-runs/run-1/heartbeat',
  })
})

test('keeps WBS reads, credential revocation, and preflight open without the module', async () => {
  const app = createGatedApp(false)

  for (const [method, path] of WBS_REQUESTS) {
    const response = await app.request(path, { method })
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 200 })
  }
  const preflight = await app.request('/api/v1/agent-runs', { method: 'OPTIONS' })
  expect(preflight.status).toBe(200)
})

test('refuses trailing-slash and nested variants of the gated paths', async () => {
  const app = createGatedApp(false)

  for (const path of [
    '/api/v1/agent-runs/',
    '/api/teams/team-1/agent-runs/',
    '/api/v1/agent-context/extra',
  ]) {
    expect((await app.request(path)).status).toBe(503)
  }
})

test('passes every route through when the module is deployed', async () => {
  const app = createGatedApp(true)

  for (const [method, path] of SOFTWARE_FACTORY_REQUESTS) {
    const response = await app.request(path, { method })
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 200 })
  }
})

test('the API app refuses Agent Run routes before authentication when SOFTWARE_FACTORY is disabled', async () => {
  const original = Bun.env.SOFTWARE_FACTORY
  try {
    Bun.env.SOFTWARE_FACTORY = 'disabled'
    const app = createApp(createTestAppDependencies())

    const agentRuns = await app.request('/api/v1/agent-runs')
    expect(agentRuns.status).toBe(503)
    expect(await agentRuns.json()).toMatchObject({ code: 'SoftwareFactoryNotDeployed' })
    const board = await app.request('/api/teams/team-1/agent-runs')
    expect(board.status).toBe(503)
    // WBS reads still reach the Public API, which asks for a credential.
    expect((await app.request('/api/v1/work-items')).status).toBe(401)

    Bun.env.SOFTWARE_FACTORY = 'enabled'
    expect((await app.request('/api/v1/agent-runs')).status).toBe(401)
  } finally {
    if (original === undefined) delete Bun.env.SOFTWARE_FACTORY
    else Bun.env.SOFTWARE_FACTORY = original
  }
})
