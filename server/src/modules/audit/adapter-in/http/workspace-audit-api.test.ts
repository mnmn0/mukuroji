import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createFakeAuditEvent,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import type {
  AuditEventV1,
} from '../../audit'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('loads dashboard summary from the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/dashboard/summary', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projects: 1,
    tasks: 1,
    blocked: 0,
    updatedAt: '2026-06-03T00:00:00.000Z',
    source: 'dynamodb',
  })
  expect(calls.summaryReads).toEqual([
    {
      directoryId: 'user#demo@example.com',
      isSystemAdmin: false,
      userKey: 'demo@example.com',
    },
  ])
})

test('marks a workspace audit export as truncated when the 1,000 event cap leaves a cursor', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()
  let pageNumber = 0
  const accessEvents: AuditEventV1[] = []

  setTestAppDependencies({
    auditEvents: {
      async putEvent(accessEvent) {
        accessEvents.push(accessEvent)
      },
      async getEvent() {
        return undefined
      },
      async query(input) {
        pageNumber += 1
        expect(input.limit).toBe(100)

        return {
          events: Array.from({ length: 100 }, () => event),
          nextCursor: `cursor-${pageNumber}`,
        }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      Origin: 'http://localhost:5173',
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
    'X-Audit-Truncated,X-Audit-Next-Cursor,X-Correlation-Id,X-Request-Id',
  )
  expect(response.headers.get('X-Audit-Truncated')).toBe('true')
  expect(response.headers.get('X-Audit-Next-Cursor')).toBe('cursor-10')
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1_000)
  expect(pageNumber).toBe(10)
  expect(accessEvents).toHaveLength(1)
  expect(accessEvents[0]).toMatchObject({
    eventType: 'audit.exported',
    actor: { kind: 'user' },
    entity: { type: 'audit-log', id: 'user#demo@example.com' },
    metadata: {
      format: 'ndjson',
      returnedEventCount: 1_000,
      truncated: true,
    },
  })
})

test('omits truncation headers when a workspace audit export reaches the final page', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()

  setTestAppDependencies({
    auditEvents: {
      async putEvent() {},
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [event] }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Audit-Truncated')).toBeNull()
  expect(response.headers.get('X-Audit-Next-Cursor')).toBeNull()
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1)
})

test('appends an immutable audit event after viewing the workspace audit timeline', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()
  const accessEvents: AuditEventV1[] = []
  setTestAppDependencies({
    auditEvents: {
      async putEvent(accessEvent) {
        accessEvents.push(accessEvent)
      },
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [event] }
      },
    },
  })

  const response = await app.request('/api/audit/events?eventType=project.created', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'X-Request-Id': 'audit-view-request-1',
    },
  })

  expect(response.status).toBe(200)
  expect(accessEvents).toHaveLength(1)
  expect(accessEvents[0]).toMatchObject({
    eventType: 'audit.viewed',
    actor: { kind: 'user' },
    entity: { type: 'audit-log', id: 'user#demo@example.com' },
    metadata: {
      format: 'json',
      returnedEventCount: 1,
      truncated: false,
      filtered: true,
    },
  })
})
