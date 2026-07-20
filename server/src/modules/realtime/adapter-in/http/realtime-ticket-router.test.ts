import { describe, expect, test } from 'bun:test'
import { RealtimeTicketError } from '../../realtime-ticket'
import { createRealtimeTicketRouter } from './realtime-ticket-router'

const principal = {
  directoryId: 'workspace-1',
  userKey: 'member@example.com',
  isSystemAdmin: false,
}

describe('realtime ticket router', () => {
  test('issues a ticket with the authenticated and normalized Work Item scope', async () => {
    const requests: object[] = []
    const router = createRealtimeTicketRouter({
      async authenticate(accessToken) {
        expect(accessToken).toBe('access-token')
        return principal
      },
      async issueTicket(request) {
        requests.push(request)
        return {
          ticket: 'one-time-ticket',
          websocketUrl: 'wss://realtime.example.com/dev',
          expiresAt: '2026-07-12T00:01:00.000Z',
        }
      },
      mapError: (context) => context.json({ message: 'unexpected' }, 500),
      readJson: async (request) => await request.json(),
    })

    const response = await router.request('/api/realtime/tickets', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ teamId: ' core ', issueId: ' issue-1 ' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      ticket: 'one-time-ticket',
      websocketUrl: 'wss://realtime.example.com/dev',
      expiresAt: '2026-07-12T00:01:00.000Z',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      accessToken: 'access-token',
      principal,
      teamId: 'core',
      issueId: 'issue-1',
    })
  })

  test('rejects missing authentication before reading the request body', async () => {
    let bodyRead = false
    const router = createRealtimeTicketRouter({
      async authenticate() {
        return principal
      },
      async issueTicket() {
        throw new Error('unreachable')
      },
      mapError: (context) => context.json({ message: 'unexpected' }, 500),
      async readJson() {
        bodyRead = true
        return {}
      },
    })

    const response = await router.request('/api/realtime/tickets', { method: 'POST' })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Bearer token is required.' })
    expect(bodyRead).toBe(false)
  })

  test('preserves validation responses for missing Work Item identifiers', async () => {
    const router = createRealtimeTicketRouter({
      async authenticate() {
        return principal
      },
      async issueTicket() {
        throw new Error('unreachable')
      },
      mapError: (context) => context.json({ message: 'unexpected' }, 500),
      readJson: async (request) => await request.json(),
    })

    const missingTeam = await router.request('/api/realtime/tickets', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ issueId: 'issue-1' }),
    })
    const missingIssue = await router.request('/api/realtime/tickets', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ teamId: 'core' }),
    })

    expect(missingTeam.status).toBe(400)
    expect(await missingTeam.json()).toEqual({ message: 'Team ID is required.' })
    expect(missingIssue.status).toBe(400)
    expect(await missingIssue.json()).toEqual({ message: 'Issue ID is required.' })
  })

  test('maps stable realtime errors and delegates infrastructure errors', async () => {
    let failure: unknown = new RealtimeTicketError(
      403,
      'RealtimeDenied',
      'Realtime access is denied.',
    )
    const router = createRealtimeTicketRouter({
      async authenticate() {
        return principal
      },
      async issueTicket() {
        throw failure
      },
      mapError: (context, error) =>
        context.json({ message: error === failure ? 'mapped' : 'unexpected' }, 502),
      readJson: async (request) => await request.json(),
    })
    const request = () => router.request('/api/realtime/tickets', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ teamId: 'core', issueId: 'issue-1' }),
    })

    const denied = await request()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      code: 'RealtimeDenied',
      message: 'Realtime access is denied.',
    })

    failure = new Error('DynamoDB unavailable')
    const unavailable = await request()
    expect(unavailable.status).toBe(502)
    expect(await unavailable.json()).toEqual({ message: 'mapped' })
  })
})
