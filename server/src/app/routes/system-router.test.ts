import { expect, test } from 'bun:test'
import { createSystemRouter } from './system-router'

test('keeps liveness independent from dependency readiness', async () => {
  const router = createSystemRouter({
    readiness: {
      async check() {
        throw new Error('dependency unavailable')
      },
    },
  })

  const response = await router.request('/api/health')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, status: 'alive' })
})

test('returns a dependency-aware ready response only after successful checks', async () => {
  const router = createSystemRouter({
    readiness: {
      async check() {
        return {
          checks: [
            { name: 'work-items', ready: true },
            { name: 'workspace-access', ready: true },
          ],
          ready: true,
        }
      },
    },
  })

  const response = await router.request('/api/ready')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    status: 'ready',
    checks: [
      { name: 'work-items', ready: true },
      { name: 'workspace-access', ready: true },
    ],
  })
})

test('fails readiness closed for unavailable or failing probes', async () => {
  const unavailableRouter = createSystemRouter({
    readiness: {
      async check() {
        return {
          checks: [{ name: 'audit-events', ready: false }],
          ready: false,
        }
      },
    },
  })
  const failingRouter = createSystemRouter({
    readiness: {
      async check() {
        throw new Error('raw infrastructure detail')
      },
    },
  })

  const unavailableResponse = await unavailableRouter.request('/api/ready')
  const failingResponse = await failingRouter.request('/api/ready')

  expect(unavailableResponse.status).toBe(503)
  expect(await unavailableResponse.json()).toEqual({
    ok: false,
    status: 'not-ready',
    checks: [{ name: 'audit-events', ready: false }],
  })
  expect(failingResponse.status).toBe(503)
  expect(await failingResponse.json()).toEqual({
    ok: false,
    status: 'not-ready',
    checks: [{ name: 'readiness-probe', ready: false }],
  })
})
