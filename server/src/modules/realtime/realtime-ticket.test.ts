import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DynamoDbRealtimeTicketsClient,
  RealtimeTicketError,
} from './realtime-ticket'

test('stores a one-time hashed realtime ticket without exposing the raw value', async () => {
  const commands: object[] = []
  const documentClient = {
    async send(command: object) {
      commands.push(command)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbRealtimeTicketsClient(
    'realtime-table',
    documentClient,
    'wss://realtime.example.com/dev',
    () => new Date('2026-07-12T00:00:00.000Z'),
  )

  const ticket = await client.createTicket({
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    teamId: 'core',
    issueId: 'issue-one',
    projectId: 'platform',
    systemAdmin: false,
    canWrite: true,
    scopeKey: 'workspace-1#work-item#team/core/issue/one',
    authenticatedAt: 1_783_814_400,
    tokenExpiresAt: 1_783_818_000,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: ['pwd', 'software_token_mfa'],
    clientIp: '203.0.113.42',
  })
  const commandInput = (commands[0] as { input: { Item: Record<string, unknown> } }).input

  expect(ticket.websocketUrl).toBe('wss://realtime.example.com/dev')
  expect(ticket.expiresAt).toBe('2026-07-12T00:01:00.000Z')
  expect(ticket.ticket.length).toBeGreaterThan(30)
  expect(commandInput.Item.connectionId).toMatch(/^TICKET#[a-f0-9]{64}$/)
  expect(Object.values(commandInput.Item)).not.toContain(ticket.ticket)
  expect(commandInput.Item).toMatchObject({
    itemType: 'ticket',
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    teamId: 'core',
    issueId: 'issue-one',
    projectId: 'platform',
    systemAdmin: false,
    canWrite: true,
    ticketScopeKey: 'workspace-1#work-item#team/core/issue/one',
    authenticatedAt: 1_783_814_400,
    tokenExpiresAt: 1_783_818_000,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: ['pwd', 'software_token_mfa'],
    clientIp: '203.0.113.42',
    expiresAt: Math.floor(Date.parse('2026-07-12T00:00:00.000Z') / 1000) + 60,
    authorizationExpiresAt:
      Math.floor(Date.parse('2026-07-12T00:00:00.000Z') / 1000) + 60 * 60,
  })
})

test('uses polling fallback when no production realtime URL is configured', async () => {
  const client = new DynamoDbRealtimeTicketsClient(
    'realtime-table',
    { send: async () => ({}) } as unknown as DynamoDBDocumentClient,
    undefined,
  )

  await expect(client.createTicket({
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    teamId: 'core',
    issueId: 'issue-one',
    systemAdmin: false,
    canWrite: false,
    scopeKey: 'scope-1',
    authenticatedAt: 1_783_814_400,
    tokenExpiresAt: 1_783_818_000,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: ['pwd'],
    clientIp: '203.0.113.42',
  })).rejects.toMatchObject({
    status: 503,
    code: 'RealtimeUnavailable',
  } satisfies Partial<RealtimeTicketError>)
})

test('stores a short-lived Document ticket that names only the Document scope', async () => {
  const commands: object[] = []
  const documentClient = {
    async send(command: object) {
      commands.push(command)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbRealtimeTicketsClient(
    'realtime-table',
    documentClient,
    'wss://realtime.example.com/dev',
    () => new Date('2026-07-12T00:00:00.000Z'),
  )
  const createdAt = Math.floor(Date.parse('2026-07-12T00:00:00.000Z') / 1000)

  const ticket = await client.createDocumentTicket({
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    documentId: 'doc-1',
    systemAdmin: false,
    authenticatedAt: createdAt - 60,
    tokenExpiresAt: createdAt + 3_600,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: ['pwd'],
    clientIp: '203.0.113.42',
  })
  const item = (commands[0] as { input: { Item: Record<string, unknown> } }).input.Item

  expect(item).toMatchObject({
    itemType: 'ticket',
    scopeType: 'document',
    documentId: 'doc-1',
    canWrite: false,
    ticketScopeKey: 'workspace-1#document#doc-1',
    expiresAt: createdAt + 60,
    authorizationExpiresAt: createdAt + 300,
  })
  expect(item.teamId).toBeUndefined()
  expect(item.issueId).toBeUndefined()
  expect(Object.values(item)).not.toContain(ticket.ticket)
  expect(ticket.sessionExpiresAt).toBe('2026-07-12T00:05:00.000Z')
})

test('caps a Document ticket at the access token expiry and rejects an expired token', async () => {
  const documentClient = {
    async send() {
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbRealtimeTicketsClient(
    'realtime-table',
    documentClient,
    'wss://realtime.example.com/dev',
    () => new Date('2026-07-12T00:00:00.000Z'),
  )
  const createdAt = Math.floor(Date.parse('2026-07-12T00:00:00.000Z') / 1000)
  const input = {
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    documentId: 'doc-1',
    systemAdmin: false,
    authenticatedAt: createdAt - 600,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: ['pwd'],
    clientIp: '203.0.113.42',
  }

  const capped = await client.createDocumentTicket({ ...input, tokenExpiresAt: createdAt + 120 })
  expect(capped.sessionExpiresAt).toBe('2026-07-12T00:02:00.000Z')
  await expect(client.createDocumentTicket({ ...input, tokenExpiresAt: createdAt }))
    .rejects.toBeInstanceOf(RealtimeTicketError)
})

test('refuses Document tickets when the WebSocket is not configured', async () => {
  const client = new DynamoDbRealtimeTicketsClient(
    'realtime-table',
    { async send() { return {} } } as unknown as DynamoDBDocumentClient,
    '',
  )

  await expect(client.createDocumentTicket({
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    documentId: 'doc-1',
    systemAdmin: false,
    authenticatedAt: 1,
    tokenExpiresAt: 4_000_000_000,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: [],
    clientIp: '203.0.113.42',
  })).rejects.toMatchObject({ status: 503, code: 'RealtimeUnavailable' })
})
