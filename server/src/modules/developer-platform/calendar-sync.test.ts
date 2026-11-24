import { describe, expect, test } from 'bun:test'
import {
  InMemoryDeveloperPlatformStorage,
  LocalAesGcmSecretProtector,
} from './adapter-out/shared/developer-platform-store'
import {
  GoogleCalendarEventProtocol,
  MicrosoftGraphCalendarEventProtocol,
} from './calendar-event-protocols'
import {
  ConfiguredOAuthConnectorAdapter,
  createOAuthConnectorRegistryFromEnvironment,
  serializeConnectorCredential,
} from './connector-oauth'
import type { ConnectorProviderRequest } from './connector-resource-protocol'
import { BUILT_IN_CONNECTOR_CATALOG, ConnectorRegistry, type ConnectorProviderId } from './connectors'
import {
  ConnectorSyncEngine,
  InMemoryConnectorSyncPersistence,
  type ConnectorWorkItemGateway,
  type ConnectorWorkItemSnapshot,
} from './connector-sync-runtime'

/** Fixed start time of the tests. */
const NOW = new Date('2026-11-24T00:00:00.000Z')

/** Origin marker secret of the tests. */
const ORIGIN_SIGNING_SECRET = 'calendar-origin-signing-secret-at-least-thirty-two-bytes'

/** One event held by the fake Google Calendar. */
type FakeGoogleEvent = Record<string, unknown> & {
  /** Event ID. */
  id: string
}

/**
 * Builds a fake Google Calendar API on top of `fetch`.
 *
 * @param clock - Returns the time used for `updated`.
 * @returns The fetch function, the events, and the requests it saw.
 */
function createFakeGoogle(clock: () => Date) {
  const events = new Map<string, FakeGoogleEvent>()
  let revision = 0
  /** Returns a new ETag, as Google does on every change. */
  const nextEtag = () => {
    revision += 1
    return `"etag-${revision}"`
  }
  const requests: Array<{ method: string, url: URL, authorization: string | null, body?: Record<string, unknown> }> = []
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({ method, url, authorization: headers.get('Authorization'), ...(body ? { body } : {}) })
    const prefix = '/calendar/v3/calendars/primary/events'
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 })
    const id = decodeURIComponent(url.pathname.slice(prefix.length + 1))
    const stamp = () => ({ updated: clock().toISOString(), etag: nextEtag(), htmlLink: `https://calendar.google.com/event?eid=${id || String(body?.id)}` })
    if (method === 'POST') {
      const eventId = String(body?.id)
      if (events.has(eventId)) return Response.json({ error: 'duplicate' }, { status: 409 })
      const event = { ...body, id: eventId, updated: clock().toISOString(), etag: nextEtag(), htmlLink: `https://calendar.google.com/event?eid=${eventId}` }
      events.set(eventId, event)
      return Response.json(event)
    }
    if (method === 'PATCH') {
      const current = events.get(id)
      if (!current) return Response.json({ error: 'missing' }, { status: 404 })
      const expected = headers.get('If-Match')
      if (expected !== null && expected !== current.etag) return Response.json({ error: 'changed' }, { status: 412 })
      const next = { ...current, ...body, ...stamp(), id }
      events.set(id, next)
      return Response.json(next)
    }
    if (id) {
      const current = events.get(id)
      return current ? Response.json(current) : Response.json({ error: 'missing' }, { status: 404 })
    }
    const filter = url.searchParams.get('privateExtendedProperty')
    const items = [...events.values()].filter((event) => {
      const extended = event.extendedProperties
      const privateProperties = typeof extended === 'object' && extended !== null && 'private' in extended
        ? extended.private
        : undefined
      return filter === 'mukurojiManaged=1' &&
        typeof privateProperties === 'object' &&
        privateProperties !== null &&
        'mukurojiManaged' in privateProperties
    })
    return Response.json({ items })
  }) as typeof fetch
  return { fetcher, events, requests }
}

/**
 * Creates a Google Calendar adapter with the built-in protocol.
 *
 * @param fetcher - Fake transport.
 * @returns The adapter.
 */
function createGoogleAdapter(fetcher: typeof fetch) {
  const definition = BUILT_IN_CONNECTOR_CATALOG.find((entry) => entry.id === 'google-calendar')
  if (!definition) throw new Error('Google Calendar is missing from the catalog.')
  return new ConfiguredOAuthConnectorAdapter({
    definition,
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.example.test/api/developer/connector-oauth/callback',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    apiBaseUrl: 'https://www.googleapis.com/calendar/v3/',
    defaultScopes: ['https://www.googleapis.com/auth/calendar.events'],
    token: { accessToken: 'access_token', externalAccountId: 'account' },
    allowedHosts: ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'app.example.test'],
    resourceProtocol: new GoogleCalendarEventProtocol(),
    fetch: fetcher,
  })
}

/**
 * Builds an engine with a Google Calendar installation and a Work Item gateway that keeps the
 * Work Item in memory.
 *
 * @returns The engine, the fake API, and the Work Item accessors.
 */
async function createCalendarFixture() {
  let currentTime = NOW
  const clock = () => currentTime
  const google = createFakeGoogle(clock)
  const adapter = createGoogleAdapter(google.fetcher)
  const platform = new InMemoryDeveloperPlatformStorage(
    new LocalAesGcmSecretProtector(new Uint8Array(32).fill(5)),
    clock,
  )
  const installation = await platform.installConnector({
    workspaceId: 'workspace-1',
    installedByUserId: 'installer-1',
    input: {
      category: 'calendar',
      provider: 'google-calendar',
      name: 'Team calendar',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
      externalAccountId: 'calendar-account',
      credential: serializeConnectorCredential({
        accessToken: 'calendar-access-token',
        externalAccountId: 'calendar-account',
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
      }),
    },
  })
  const calendarPolicy = { timeZone: 'Asia/Tokyo', workingWeekdays: [], holidays: [] }
  let workItem: ConnectorWorkItemSnapshot = {
    id: 'work-item-1',
    teamId: 'team-1',
    revision: 3,
    title: 'Ship the release',
    description: 'Release notes',
    status: 'open',
    schedule: { startDate: '2026-11-30', endDate: '2026-11-30', timeZone: calendarPolicy.timeZone },
  }
  const patches: unknown[] = []
  const workItems: ConnectorWorkItemGateway = {
    async authorize() {},
    async get() {
      return structuredClone(workItem)
    },
    async applyExternal(input) {
      if (input.expectedRevision !== workItem.revision) return { kind: 'conflict', workItem: structuredClone(workItem) }
      patches.push(structuredClone(input.patch))
      workItem = {
        ...workItem,
        revision: workItem.revision + 1,
        ...(input.patch.schedule ? { schedule: { ...input.patch.schedule, timeZone: calendarPolicy.timeZone } } : {}),
      }
      return { kind: 'applied', workItem: structuredClone(workItem) }
    },
  }
  const persistence = new InMemoryConnectorSyncPersistence()
  const engine = new ConnectorSyncEngine({
    platform,
    registry: new ConnectorRegistry([adapter]),
    workItems,
    persistence,
    health: { async authorizationRequired() {}, async degraded() {} },
    originSigningSecret: ORIGIN_SIGNING_SECRET,
    clock,
  })
  return {
    engine,
    platform,
    installation,
    google,
    patches,
    persistence,
    getWorkItem: () => structuredClone(workItem),
    setWorkItem: (next: ConnectorWorkItemSnapshot) => {
      workItem = structuredClone(next)
    },
    advance: (milliseconds: number) => {
      currentTime = new Date(currentTime.getTime() + milliseconds)
    },
  }
}

/**
 * Creates the calendar event of the fixture Work Item and links it.
 *
 * @param fixture - Calendar fixture.
 * @param syncDirection - Link direction.
 * @returns The link.
 */
async function linkNewEvent(
  fixture: Awaited<ReturnType<typeof createCalendarFixture>>,
  syncDirection: 'outbound' | 'bidirectional' = 'bidirectional',
) {
  const { record } = await fixture.engine.createLinkedResource({
    workspaceId: 'workspace-1',
    installationId: fixture.installation.id,
    teamId: 'team-1',
    workItemId: 'work-item-1',
    resourceType: 'calendar-event',
    operationId: 'create-operation-1',
  })
  return fixture.platform.createExternalWorkItemLink({
    workspaceId: 'workspace-1',
    input: {
      teamId: 'team-1',
      workItemId: 'work-item-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
      externalId: record.externalId,
      externalUrl: record.externalUrl,
      syncDirection,
    },
  })
}

/**
 * Links an event, then moves both the Work Item and the event so the next poll records a
 * schedule conflict.
 *
 * @param fixture - Calendar fixture.
 * @returns The open conflict's ID and the event ID.
 */
async function createScheduleConflict(fixture: Awaited<ReturnType<typeof createCalendarFixture>>) {
  const link = await linkNewEvent(fixture)
  await fixture.engine.pollInstallation({
    workspaceId: 'workspace-1',
    installationId: fixture.installation.id,
    resourceType: 'calendar-event',
  })
  fixture.setWorkItem({
    ...fixture.getWorkItem(),
    revision: 9,
    schedule: { startDate: '2026-12-10', endDate: '2026-12-10', timeZone: 'Asia/Tokyo' },
  })
  const event = fixture.google.events.get(link.externalId)
  if (!event) throw new Error('Expected the event.')
  fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-11' }, end: { date: '2026-12-12' }, etag: '"moved-in-calendar"' })
  const polled = await fixture.engine.pollInstallation({
    workspaceId: 'workspace-1',
    installationId: fixture.installation.id,
    resourceType: 'calendar-event',
  })
  const result = polled.results[0]
  if (result?.kind !== 'conflict') throw new Error(`Expected a conflict, got ${result?.kind}`)
  return { id: result.conflict.id, externalId: link.externalId }
}

describe('calendar connectors (ADR 0089)', () => {
  test('creates one all-day event per operation, even when the create is retried', async () => {
    const fixture = await createCalendarFixture()
    const first = await fixture.engine.createLinkedResource({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      resourceType: 'calendar-event',
      operationId: 'create-operation-1',
    })
    const retried = await fixture.engine.createLinkedResource({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      resourceType: 'calendar-event',
      operationId: 'create-operation-1',
    })
    expect(retried.record.externalId).toBe(first.record.externalId)
    expect(retried.workItemRevision).toBe(3)
    expect(fixture.google.events.size).toBe(1)
    expect(first.record).toMatchObject({
      resourceType: 'calendar-event',
      schedule: { startDate: '2026-11-30', endDate: '2026-11-30' },
      title: 'Ship the release',
    })
    const created = fixture.google.requests.find((request) => request.method === 'POST')
    expect(created?.authorization).toBe('Bearer calendar-access-token')
    expect(created?.body).toMatchObject({
      summary: 'Ship the release',
      start: { date: '2026-11-30' },
      end: { date: '2026-12-01' },
      extendedProperties: { private: { mukurojiManaged: '1' } },
    })
  })

  test('keeps dates changed between creating the event and the first poll', async () => {
    const fixture = await createCalendarFixture()
    const resource = await fixture.engine.createLinkedResource({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      resourceType: 'calendar-event',
      operationId: 'create-operation-1',
    })
    const link = await fixture.platform.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: {
        teamId: 'team-1',
        workItemId: 'work-item-1',
        installationId: fixture.installation.id,
        resourceType: 'calendar-event',
        externalId: resource.record.externalId,
        externalUrl: resource.record.externalUrl,
        syncDirection: 'inbound',
      },
    })
    await fixture.engine.initializeLinkedResourceSync({ workspaceId: 'workspace-1', link, resource })
    // The Work Item moves before the first poll; the unchanged event must not move it back.
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 4,
      schedule: { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' },
    })
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(fixture.patches).toEqual([])
    expect(fixture.getWorkItem().schedule).toMatchObject({ startDate: '2026-12-05' })
    expect(await fixture.persistence.getLinkState('workspace-1', link.id)).toMatchObject({
      workItemRevision: 3,
      lastExternalVersion: resource.record.externalVersion,
    })
  })

  test('refuses to create an event for a Work Item without dates', async () => {
    const fixture = await createCalendarFixture()
    const { schedule: _schedule, ...unscheduled } = fixture.getWorkItem()
    fixture.setWorkItem(unscheduled)
    expect(fixture.engine.createLinkedResource({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      resourceType: 'calendar-event',
      operationId: 'create-operation-2',
    })).rejects.toMatchObject({ code: 'ConnectorCalendarScheduleRequired' })
    expect(fixture.google.events.size).toBe(0)
  })

  test('moves the event when the deadline changes and skips a Work Item without dates', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture, 'outbound')
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 4,
      schedule: { startDate: '2026-12-02', endDate: '2026-12-04', timeZone: 'Asia/Tokyo' },
    })
    fixture.advance(60_000)
    const pushed = await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-1' })
    expect(pushed).toMatchObject({ kind: 'synced', workItemRevision: 4 })
    const event = fixture.google.events.get(link.externalId)
    expect(event).toMatchObject({ start: { date: '2026-12-02' }, end: { date: '2026-12-05' }, status: 'confirmed' })
    // The status of a source-control link is not sent to a calendar.
    const patch = fixture.google.requests.findLast((request) => request.method === 'PATCH')
    expect(patch?.body).not.toHaveProperty('status', 'open')

    const { schedule: _schedule, ...unscheduled } = fixture.getWorkItem()
    fixture.setWorkItem({ ...unscheduled, revision: 5 })
    expect(await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-2' }))
      .toEqual({ kind: 'skipped', linkId: link.id, reason: 'unscheduled' })
  })

  test('moves the Work Item when the event moves, and ignores its own echo', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    // The first poll sees the event Mukuroji created with the same dates and changes nothing.
    const first = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(first.results).toEqual([{ kind: 'skipped', linkId: link.id, reason: 'stale' }])
    expect(fixture.patches).toEqual([])

    // Someone drags the event to two days in the calendar.
    fixture.advance(60_000)
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, {
      ...event,
      start: { date: '2026-12-07' },
      end: { date: '2026-12-09' },
      summary: 'Renamed in the calendar',
      updated: new Date(NOW.getTime() + 60_000).toISOString(),
      etag: '"moved-in-calendar"',
    })
    const moved = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(moved.results).toMatchObject([{ kind: 'synced', workItemRevision: 4 }])
    // Only the dates come back; the calendar title never renames the Work Item.
    expect(fixture.patches).toEqual([{ schedule: { startDate: '2026-12-07', endDate: '2026-12-08' } }])
    expect(fixture.getWorkItem().title).toBe('Ship the release')

    // Pushing the moved Work Item back produces an echo that the next poll skips.
    fixture.advance(60_000)
    await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-echo' })
    const echo = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(echo.results).toEqual([{ kind: 'skipped', linkId: link.id, reason: 'self-origin' }])
    expect(fixture.patches).toHaveLength(1)
  })

  test('does not overwrite an event moved since the last read', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-11' }, end: { date: '2026-12-12' }, etag: '"moved-in-calendar"' })
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 9,
      schedule: { startDate: '2026-12-10', endDate: '2026-12-10', timeZone: 'Asia/Tokyo' },
    })
    const pushed = await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-stale' })
    expect(pushed).toEqual({ kind: 'skipped', linkId: link.id, reason: 'stale' })
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-12-11' } })
    // The next poll reads the move and records a conflict, since the Work Item changed too.
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'conflict' }])
  })

  test('keeps an undated Work Item when its conflict is resolved with the local value', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const { schedule: _schedule, ...undated } = fixture.getWorkItem()
    fixture.setWorkItem({ ...undated, revision: 9 })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-11' }, end: { date: '2026-12-12' }, etag: '"moved-in-calendar"' })
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const result = polled.results[0]
    if (result?.kind !== 'conflict') throw new Error(`Expected a conflict, got ${result?.kind}`)
    const requestsBefore = fixture.google.requests.length
    const resolved = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      result.conflict.id,
      { resolution: 'use-local' },
    )
    expect(resolved.status).toBe('resolved')
    // Nothing is written to the calendar for a Work Item without dates.
    expect(fixture.google.requests.slice(requestsBefore).some((request) => request.method === 'PATCH')).toBe(false)
  })

  test('records a schedule conflict when both sides moved', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 9,
      schedule: { startDate: '2026-12-10', endDate: '2026-12-10', timeZone: 'Asia/Tokyo' },
    })
    fixture.advance(60_000)
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, {
      ...event,
      start: { date: '2026-12-11' },
      end: { date: '2026-12-12' },
      updated: new Date(NOW.getTime() + 60_000).toISOString(),
      etag: '"moved-in-calendar"',
    })
    const result = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(result.results).toMatchObject([{
      kind: 'conflict',
      conflict: {
        fields: [{
          field: 'schedule',
          localValue: { startDate: '2026-12-10', endDate: '2026-12-10' },
          externalValue: { startDate: '2026-12-11', endDate: '2026-12-11' },
        }],
      },
    }])
  })

  test('applies an event edit whose ETag sorts before the stored one', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    // ETags say only that the event changed; this one sorts before the stored "etag-…".
    fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-11' }, end: { date: '2026-12-12' }, etag: '"a-moved"' })
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'synced' }])
    expect(fixture.getWorkItem().schedule).toMatchObject({ startDate: '2026-12-11', endDate: '2026-12-11' })
  })

  test('refreshes a conflict whose event moved again before it was resolved', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture)
    const event = fixture.google.events.get(conflict.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(conflict.externalId, { ...event, start: { date: '2026-12-20' }, end: { date: '2026-12-21' }, etag: '"moved-again"' })
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflict.id,
      { resolution: 'use-local' },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    const refreshed = await fixture.persistence.getConflict('workspace-1', conflict.id)
    expect(refreshed?.conflict).toMatchObject({
      status: 'open',
      externalRevision: '"moved-again"',
      fields: [{ field: 'schedule', externalValue: { startDate: '2026-12-20', endDate: '2026-12-20' } }],
    })
    expect(refreshed?.resolutionOperationId).toBeUndefined()
    // Resolving again writes the local dates over the event the user has now seen.
    const resolved = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflict.id,
      { resolution: 'use-local' },
    )
    expect(resolved.status).toBe('resolved')
    expect(fixture.google.events.get(conflict.externalId)).toMatchObject({ start: { date: '2026-12-10' }, end: { date: '2026-12-11' } })
  })

  test('merges chosen dates into a schedule conflict and refuses other merge fields', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture)
    const actor = { workspaceId: 'workspace-1', userId: 'installer-1' }
    await expect(fixture.engine.resolveConflict(actor, conflict.id, {
      resolution: 'merge',
      mergedValues: { schedule: { startDate: '2026-12-13', endDate: '2026-12-12' } },
    })).rejects.toMatchObject({ code: 'ConnectorSyncResolutionInvalid' })
    await expect(fixture.engine.resolveConflict(actor, conflict.id, {
      resolution: 'merge',
      mergedValues: { title: 'Renamed' },
    })).rejects.toMatchObject({ code: 'ConnectorSyncResolutionInvalid' })
    const resolved = await fixture.engine.resolveConflict(actor, conflict.id, {
      resolution: 'merge',
      mergedValues: { schedule: { startDate: '2026-12-12', endDate: '2026-12-13' } },
    })
    expect(resolved.status).toBe('resolved')
    expect(fixture.getWorkItem().schedule).toMatchObject({ startDate: '2026-12-12', endDate: '2026-12-13' })
    expect(fixture.google.events.get(conflict.externalId)).toMatchObject({ start: { date: '2026-12-12' }, end: { date: '2026-12-14' } })
  })

  test('uses the built-in protocol for calendar providers configured from the environment', async () => {
    const google = createFakeGoogle(() => NOW)
    const entry = (provider: ConnectorProviderId) => ({
      provider,
      clientId: 'client',
      clientSecretEnvironmentVariable: 'CALENDAR_SECRET',
      redirectUri: 'https://app.example.test/api/developer/connector-oauth/callback',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      apiBaseUrl: 'https://www.googleapis.com/calendar/v3/',
      defaultScopes: ['https://www.googleapis.com/auth/calendar.events'],
      token: { accessToken: 'access_token', externalAccountId: 'account' },
      allowedHosts: ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'app.example.test'],
    })
    const registry = createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify([entry('google-calendar')]),
        CALENDAR_SECRET: 'secret',
      },
      fetch: google.fetcher,
    })
    const adapter = registry.get('google-calendar')
    const page = await adapter.pull({ accessToken: 'token', externalAccountId: 'a', scopes: [] }, 'calendar-event')
    expect(page).toEqual({ items: [] })
    expect(google.requests[0]?.url.searchParams.get('privateExtendedProperty')).toBe('mukurojiManaged=1')

    // REST bindings cannot be configured for a provider with a built-in protocol.
    expect(() => createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify([{
          ...entry('google-calendar'),
          resources: { 'calendar-event': { collectionPath: 'x', itemPath: 'x/{externalId}', itemsPath: 'items', record: {}, mutation: {} } },
        }]),
        CALENDAR_SECRET: 'secret',
      },
    })).toThrow(expect.objectContaining({ code: 'ConnectorResourceBindingMismatch' }))
  })
})

describe('Microsoft Graph calendar protocol', () => {
  /**
   * Builds a requester that answers from a queue and records the requests.
   *
   * @param responses - Responses in order.
   * @returns The requester and the requests.
   */
  function createRequester(responses: Array<{ status: number, payload: unknown }>) {
    const requests: ConnectorProviderRequest[] = []
    return {
      requests,
      request: async (request: ConnectorProviderRequest) => {
        requests.push(request)
        const response = responses.shift()
        if (!response) throw new Error('No response queued.')
        return response
      },
    }
  }

  /** A Graph all-day November 30 event in Asia/Tokyo, returned in UTC as Graph does. */
  const graphEvent = {
    '@odata.etag': 'W/"DwAAABYAAAA="',
    id: 'AAMkAGI2T_abc=',
    subject: 'Ship the release',
    webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAGI2T',
    lastModifiedDateTime: '2026-11-24T01:02:03.4567890Z',
    isAllDay: true,
    start: { dateTime: '2026-11-29T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-30T15:00:00.0000000', timeZone: 'UTC' },
    singleValueExtendedProperties: [
      { id: 'String {00020329-0000-0000-c000-000000000046} Name mukurojiOrigin', value: 'v1.origin.marker' },
      { id: 'String {00020329-0000-0000-c000-000000000046} Name mukurojiTimeZone', value: 'Asia/Tokyo' },
    ],
  }

  test('reads managed events page by page through the configured origin', async () => {
    const protocol = new MicrosoftGraphCalendarEventProtocol()
    const { request, requests } = createRequester([
      {
        status: 200,
        payload: {
          value: [graphEvent, { ...graphEvent, id: 'cancelled', isCancelled: true }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/events?$skip=50&$top=50',
        },
      },
      { status: 200, payload: { value: [] } },
    ])
    const first = await protocol.pull(request, 'calendar-event')
    expect(first.items).toEqual([{
      externalId: 'AAMkAGI2T_abc=',
      resourceType: 'calendar-event',
      externalUrl: 'https://outlook.office365.com/owa/?itemid=AAMkAGI2T',
      externalVersion: 'W/"DwAAABYAAAA="',
      title: 'Ship the release',
      schedule: { startDate: '2026-11-30', endDate: '2026-11-30' },
      metadata: { calendar: 'default' },
      originMarker: 'v1.origin.marker',
    }])
    expect(first.nextCursor).toBe('?$skip=50&$top=50')
    expect(requests[0]?.query?.$filter).toContain('mukurojiManaged')
    // Graph answers in UTC; the recorded time zone turns 15:00 UTC back into the Tokyo date.
    expect(requests[0]?.headers).toEqual({ Prefer: 'outlook.timezone="UTC"' })
    await protocol.pull(request, 'calendar-event', first.nextCursor)
    expect(requests[1]).toMatchObject({ path: 'me/events', query: { $skip: '50', $top: '50' } })
  })

  test('writes an all-day event in the Work Item time zone and reports a deleted event', async () => {
    const protocol = new MicrosoftGraphCalendarEventProtocol()
    const { request, requests } = createRequester([
      { status: 201, payload: graphEvent },
      { status: 404, payload: undefined },
      { status: 412, payload: undefined },
    ])
    const mutation = {
      resourceType: 'calendar-event' as const,
      workItemRevision: 3,
      title: 'Ship the release',
      schedule: { startDate: '2026-11-30', endDate: '2026-12-02', timeZone: 'Asia/Tokyo' },
      originMarker: 'v1.origin.marker',
      operationId: 'operation-1',
    }
    await protocol.create(request, mutation)
    expect(requests[0]?.body).toMatchObject({
      isAllDay: true,
      start: { dateTime: '2026-11-30T00:00:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-12-03T00:00:00', timeZone: 'Asia/Tokyo' },
    })
    expect(String(requests[0]?.body?.transactionId)).toMatch(/^mukuroji-[0-9a-f]{40}$/)
    expect(requests[0]?.body?.singleValueExtendedProperties).toContainEqual({
      id: 'String {00020329-0000-0000-C000-000000000046} Name mukurojiTimeZone',
      value: 'Asia/Tokyo',
    })
    await expect(protocol.push(request, { ...mutation, externalId: 'gone' }))
      .rejects.toMatchObject({ code: 'ConnectorExternalResourceMissing' })
    // An event changed since the last read is not overwritten.
    await expect(protocol.push(request, { ...mutation, externalId: 'moved', expectedExternalVersion: 'W/"old"' }))
      .rejects.toMatchObject({ code: 'ConnectorExternalVersionChanged' })
    expect(requests[2]?.headers).toMatchObject({ 'If-Match': 'W/"old"' })
  })

  test('reads a timed event as the days it covers', async () => {
    const protocol = new MicrosoftGraphCalendarEventProtocol()
    const { request } = createRequester([{
      status: 200,
      payload: {
        value: [{
          ...graphEvent,
          singleValueExtendedProperties: [],
          isAllDay: false,
          start: { dateTime: '2026-12-01T09:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-12-03T00:00:00.0000000', timeZone: 'UTC' },
        }],
      },
    }])
    const page = await protocol.pull(request, 'calendar-event')
    expect(page.items[0]?.schedule).toEqual({ startDate: '2026-12-01', endDate: '2026-12-02' })
  })
})
