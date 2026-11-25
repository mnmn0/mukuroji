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
  type ConnectorWorkItemRejection,
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
 * Checks for a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Applies a Google patch: nested objects merge field by field and `null` clears a field.
 *
 * @param current - Stored event.
 * @param patch - Patch body.
 * @returns The patched event.
 */
function mergeGooglePatch(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key]
    if (value === null) delete next[key]
    else if (isPlainObject(value) && isPlainObject(existing)) next[key] = mergeGooglePatch(existing, value)
    else next[key] = value
  }
  return next
}

/**
 * Checks whether an event boundary holds both a date and a date-time, which Google refuses.
 *
 * @param boundary - Event start or end.
 * @returns Whether both kinds are present.
 */
function hasMixedBoundaries(boundary: unknown) {
  return isPlainObject(boundary) && 'date' in boundary && 'dateTime' in boundary
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
  const hooks: { afterListRead?: () => Promise<void>, failEventRead?: boolean } = {}
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
      const merged = mergeGooglePatch(current, body ?? {})
      if (hasMixedBoundaries(merged.start) || hasMixedBoundaries(merged.end)) {
        return Response.json({ error: 'invalid boundaries' }, { status: 400 })
      }
      const next = { ...merged, ...stamp(), id }
      events.set(id, next)
      return Response.json(next)
    }
    if (id) {
      // Lets a test make reading one event fail.
      if (hooks.failEventRead) return Response.json({ error: 'unavailable' }, { status: 500 })
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
    const snapshot = Response.json({ items })
    // Lets a test run other work after the list is read and before the poll processes it.
    const hook = hooks.afterListRead
    hooks.afterListRead = undefined
    if (hook) await hook()
    return snapshot
  }) as typeof fetch
  return { fetcher, events, requests, hooks }
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
  // Like the real gateway, an applied operation keeps a receipt keyed on its operation ID, which
  // replays the same request and refuses a different one.
  const receipts = new Map<string, { request: string, workItem: ConnectorWorkItemSnapshot }>()
  let rejection: ConnectorWorkItemRejection | undefined
  // Like a deadline Work Item, keep only the last day of the dates written to it.
  let deadlineOnly = false
  const workItems: ConnectorWorkItemGateway = {
    async authorize() {},
    async get() {
      return structuredClone(workItem)
    },
    async applyExternal(input) {
      const request = JSON.stringify({ expectedRevision: input.expectedRevision, patch: input.patch })
      const receipt = receipts.get(input.operationId)
      if (receipt && receipt.request !== request) throw new Error('The operation ID was reused for another request.')
      if (receipt) return { kind: 'applied', workItem: structuredClone(receipt.workItem) }
      if (input.expectedRevision !== workItem.revision) return { kind: 'conflict', workItem: structuredClone(workItem) }
      if (rejection && input.patch.schedule) {
        return { kind: 'rejected', workItem: structuredClone(workItem), reason: rejection }
      }
      patches.push(structuredClone(input.patch))
      workItem = {
        ...workItem,
        revision: workItem.revision + 1,
        ...(input.patch.schedule
          ? {
              schedule: {
                startDate: deadlineOnly ? input.patch.schedule.endDate : input.patch.schedule.startDate,
                endDate: input.patch.schedule.endDate,
                timeZone: calendarPolicy.timeZone,
              },
            }
          : {}),
      }
      receipts.set(input.operationId, { request, workItem: structuredClone(workItem) })
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
    rejectSchedules: (reason: ConnectorWorkItemRejection | undefined) => {
      rejection = reason
    },
    useDeadlines: () => {
      deadlineOnly = true
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
  syncDirection: 'inbound' | 'outbound' | 'bidirectional' = 'bidirectional',
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
 * @param syncDirection - Link direction.
 * @returns The open conflict's ID and the event ID.
 */
async function createScheduleConflict(
  fixture: Awaited<ReturnType<typeof createCalendarFixture>>,
  syncDirection: 'inbound' | 'bidirectional' = 'bidirectional',
) {
  const link = await linkNewEvent(fixture, syncDirection)
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

  test('skips an event read before an outbound write committed', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    // The poll reads the event, then the Work Item moves and its outbound write commits.
    fixture.google.hooks.afterListRead = async () => {
      fixture.setWorkItem({
        ...fixture.getWorkItem(),
        revision: 9,
        schedule: { startDate: '2026-12-10', endDate: '2026-12-10', timeZone: 'Asia/Tokyo' },
      })
      const pushed = await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-during-poll' })
      expect(pushed.kind).toBe('synced')
    }
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'skipped', reason: 'stale' }])
    expect(fixture.patches).toEqual([])
    expect(fixture.getWorkItem().schedule).toMatchObject({ startDate: '2026-12-10' })
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

  test('makes an event that was changed to a timed event all-day again', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, {
      ...event,
      start: { dateTime: '2026-12-02T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-12-02T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
      etag: '"made-timed"',
    })
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'synced' }])

    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: fixture.getWorkItem().revision + 1,
      schedule: { startDate: '2026-12-04', endDate: '2026-12-04', timeZone: 'Asia/Tokyo' },
    })
    const pushed = await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-all-day' })

    expect(pushed).toMatchObject({ kind: 'synced' })
    expect(fixture.google.events.get(link.externalId)).toMatchObject({
      start: { date: '2026-12-04' },
      end: { date: '2026-12-05' },
    })
    expect(fixture.google.events.get(link.externalId)?.start).not.toHaveProperty('dateTime')
  })

  test('records dates the Work Item cannot take as a conflict instead of failing the poll', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-05' }, end: { date: '2026-12-07' }, etag: '"moved-to-weekend"' })
    fixture.rejectSchedules('calendar-dates-invalid')

    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })

    expect(polled.results).toMatchObject([{ kind: 'conflict' }])
    expect(fixture.patches).toEqual([])
    const conflictId = polled.results[0]?.kind === 'conflict' ? polled.results[0].conflict.id : ''
    // Polling again keeps the same open conflict and still writes nothing.
    const again = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(again.results).toMatchObject([{ kind: 'conflict', conflict: { id: conflictId, status: 'open' } }])
    expect(fixture.patches).toEqual([])
    // Taking the calendar dates is refused, and the conflict stays open for another choice.
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflictId,
      { resolution: 'use-external' },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictDatesRejected' })
    const kept = await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflictId,
      { resolution: 'use-local' },
    )
    expect(kept.status).toBe('resolved')
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-11-30' } })
  })

  test('returns the event a retried create finds without writing to it, and asks which dates to keep', async () => {
    const fixture = await createCalendarFixture()
    const create = () => fixture.engine.createLinkedResource({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      resourceType: 'calendar-event',
      operationId: 'create-operation-1',
    })
    const first = await create()
    expect(first.datesMatch).toBe(true)
    // The response was lost, the Work Item moved, and the create is retried.
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 4,
      schedule: { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' },
    })
    const retried = await create()
    expect(fixture.google.requests.filter((request) => request.method === 'PATCH')).toEqual([])
    expect(retried).toMatchObject({
      workItemRevision: 4,
      datesMatch: false,
      record: { externalId: first.record.externalId, schedule: { startDate: '2026-11-30' } },
    })
    const link = await fixture.platform.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: {
        teamId: 'team-1',
        workItemId: 'work-item-1',
        installationId: fixture.installation.id,
        resourceType: 'calendar-event',
        externalId: retried.record.externalId,
        externalUrl: retried.record.externalUrl,
        syncDirection: 'bidirectional',
      },
    })
    await fixture.engine.initializeLinkedResourceSync({ workspaceId: 'workspace-1', link, resource: retried })
    expect(await fixture.persistence.getLinkState('workspace-1', link.id)).toBeUndefined()
    // Without a synced baseline the poll cannot tell whether someone moved the event, so it
    // overwrites neither side and records a conflict.
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'conflict', conflict: { status: 'open' } }])
    expect(fixture.patches).toEqual([])
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-11-30' } })
    const [result] = polled.results
    if (result?.kind !== 'conflict') throw new Error('Expected a conflict.')
    await fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      result.conflict.id,
      { resolution: 'use-local' },
    )
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-12-05' }, end: { date: '2026-12-06' } })
  })

  test('records a conflict for an event polled before the link state is recorded', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    // The Work Item moves after the event was created and before its state is recorded.
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 4,
      schedule: { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' },
    })
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'conflict', conflict: { status: 'open' } }])
    expect(fixture.patches).toEqual([])
    expect(fixture.getWorkItem().schedule).toMatchObject({ startDate: '2026-12-05' })
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-11-30' } })
  })

  test('keeps a user edit made to an event before its link state is recorded', async () => {
    for (const [direction, workItemSchedule] of [
      ['inbound', { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' }],
      ['bidirectional', { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' }],
      // Only the event moves, as after a retried create that returned the first attempt's event.
      ['bidirectional', { startDate: '2026-11-30', endDate: '2026-11-30', timeZone: 'Asia/Tokyo' }],
      // The Work Item dates were cleared.
      ['bidirectional', undefined],
    ] as const) {
      const fixture = await createCalendarFixture()
      const link = await linkNewEvent(fixture, direction)
      // Someone moves the event in the calendar before the first poll records a baseline.
      const event = fixture.google.events.get(link.externalId)
      if (!event) throw new Error('Expected the event.')
      fixture.google.events.set(link.externalId, {
        ...event,
        start: { date: '2026-12-10' },
        end: { date: '2026-12-11' },
        etag: '"moved-by-user"',
      })
      const { schedule: _created, ...unscheduled } = fixture.getWorkItem()
      fixture.setWorkItem(workItemSchedule
        ? { ...unscheduled, revision: 4, schedule: { ...workItemSchedule } }
        : { ...unscheduled, revision: 4 })
      const polled = await fixture.engine.pollInstallation({
        workspaceId: 'workspace-1',
        installationId: fixture.installation.id,
        resourceType: 'calendar-event',
      })
      expect(polled.results).toMatchObject([{ kind: 'conflict', conflict: { status: 'open' } }])
      expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-12-10' } })
      expect(fixture.getWorkItem().schedule).toEqual(workItemSchedule)
    }
  })

  test('writes new Work Item dates to an event whose title alone changed', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture)
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    const retitle = (etag: string) => {
      const event = fixture.google.events.get(link.externalId)
      if (!event) throw new Error('Expected the event.')
      fixture.google.events.set(link.externalId, { ...event, summary: `Renamed ${etag}`, etag })
    }
    retitle('"renamed-1"')
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 4,
      schedule: { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' },
    })
    // The outbound write meets the new ETag, reads the event again, and still writes the dates.
    expect(await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-renamed' }))
      .toMatchObject({ kind: 'synced', workItemRevision: 4 })
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-12-05' } })

    // A poll that reads a renamed event before any outbound write does the same.
    retitle('"renamed-2"')
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      revision: 5,
      schedule: { startDate: '2026-12-08', endDate: '2026-12-08', timeZone: 'Asia/Tokyo' },
    })
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'synced', workItemRevision: 5 }])
    expect(fixture.patches).toEqual([])
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-12-08' } })
  })

  test('moves the Work Item when the event moves after a title-only Work Item change', async () => {
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
    fixture.setWorkItem({ ...fixture.getWorkItem(), revision: 4, title: 'Renamed in Mukuroji' })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-03' }, end: { date: '2026-12-04' }, etag: '"moved"' })
    const polled = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(polled.results).toMatchObject([{ kind: 'synced', workItemRevision: 5 }])
    expect(fixture.getWorkItem()).toMatchObject({ title: 'Renamed in Mukuroji', schedule: { startDate: '2026-12-03' } })
  })

  test('moves a deadline synchronized from a multi-day event after a title-only Work Item change', async () => {
    const fixture = await createCalendarFixture()
    fixture.useDeadlines()
    const link = await linkNewEvent(fixture, 'inbound')
    const poll = () => fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    await poll()
    const move = (start: string, end: string, etag: string) => {
      const event = fixture.google.events.get(link.externalId)
      if (!event) throw new Error('Expected the event.')
      fixture.google.events.set(link.externalId, { ...event, start: { date: start }, end: { date: end }, etag })
    }
    move('2026-12-03', '2026-12-06', '"range-1"')
    expect((await poll()).results).toMatchObject([{ kind: 'synced' }])
    expect(fixture.getWorkItem().schedule).toMatchObject({ startDate: '2026-12-05', endDate: '2026-12-05' })
    // The deadline is the last day of the synchronized range, so a rename leaves its dates as synced.
    fixture.setWorkItem({ ...fixture.getWorkItem(), revision: fixture.getWorkItem().revision + 1, title: 'Renamed' })
    move('2026-12-08', '2026-12-11', '"range-2"')
    expect((await poll()).results).toMatchObject([{ kind: 'synced' }])
    expect(fixture.getWorkItem()).toMatchObject({ title: 'Renamed', schedule: { endDate: '2026-12-10' } })
  })

  test('retries an event change applied to the Work Item as read after the state commit failed', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture, 'inbound')
    await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    fixture.setWorkItem({ ...fixture.getWorkItem(), revision: 4, title: 'Renamed in Mukuroji' })
    const event = fixture.google.events.get(link.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(link.externalId, { ...event, start: { date: '2026-12-03' }, end: { date: '2026-12-06' }, etag: '"moved"' })
    // The Work Item takes the event dates, and the sync state commit after it fails once.
    const commit = fixture.persistence.commitLinkState.bind(fixture.persistence)
    let failCommit = true
    fixture.persistence.commitLinkState = async (input) => {
      if (!failCommit) return commit(input)
      failCommit = false
      return false
    }
    await expect(fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })).rejects.toMatchObject({ code: 'ConnectorSyncStateConflict' })
    expect(fixture.getWorkItem()).toMatchObject({ revision: 5, schedule: { startDate: '2026-12-03' } })
    // A due-date Work Item keeps only the last day of the range, so on retry its dates match
    // neither the event nor the last synchronized dates.
    fixture.setWorkItem({
      ...fixture.getWorkItem(),
      schedule: { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' },
    })
    // The retry then conditions on the synchronized revision, which is a new operation rather than
    // a replay of the first one with another request.
    const retried = await fixture.engine.pollInstallation({
      workspaceId: 'workspace-1',
      installationId: fixture.installation.id,
      resourceType: 'calendar-event',
    })
    expect(retried.results.map((result) => result.kind)).toEqual(['conflict'])
    expect(fixture.getWorkItem()).toMatchObject({ revision: 5, schedule: { startDate: '2026-12-05' } })
  })

  test('skips an outbound write that read a Work Item older than the synchronized one', async () => {
    const fixture = await createCalendarFixture()
    const link = await linkNewEvent(fixture, 'outbound')
    const older = fixture.getWorkItem()
    fixture.setWorkItem({
      ...older,
      revision: 4,
      schedule: { startDate: '2026-12-05', endDate: '2026-12-05', timeZone: 'Asia/Tokyo' },
    })
    await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-new' })
    const writes = fixture.google.requests.filter((request) => request.method === 'PATCH').length
    // A delayed write read revision 3 before revision 4 was written.
    fixture.setWorkItem(older)
    expect(await fixture.engine.processOutbound({ workspaceId: 'workspace-1', link, operationId: 'push-old' }))
      .toEqual({ kind: 'skipped', linkId: link.id, reason: 'stale' })
    expect(fixture.google.requests.filter((request) => request.method === 'PATCH')).toHaveLength(writes)
    expect(fixture.google.events.get(link.externalId)).toMatchObject({ start: { date: '2026-12-05' } })
  })

  test('resolves an inbound-only conflict only against the event version it showed', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture, 'inbound')
    const event = fixture.google.events.get(conflict.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(conflict.externalId, { ...event, start: { date: '2026-12-20' }, end: { date: '2026-12-21' }, etag: '"moved-again"' })
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflict.id,
      { resolution: 'use-local' },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    expect(fixture.google.events.get(conflict.externalId)).toMatchObject({ start: { date: '2026-12-20' } })
  })

  test('refuses a resolution chosen from a conflict another resolution refreshed', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture)
    const stored = await fixture.persistence.getConflict('workspace-1', conflict.id)
    if (!stored) throw new Error('Expected the conflict.')
    const claim = fixture.persistence.claimConflictResolution.bind(fixture.persistence)
    // Another resolution refreshes the conflict after this one read it and before it claims it.
    fixture.persistence.claimConflictResolution = async (workspaceId, conflictId, input) => {
      await claim(workspaceId, conflictId, { operationId: 'other-resolution', startedAt: input.startedAt })
      const newer = { ...stored.externalRecord, externalVersion: '"refreshed"', schedule: { startDate: '2026-12-20', endDate: '2026-12-20' } }
      await fixture.persistence.releaseConflictResolution(workspaceId, conflictId, 'other-resolution', {
        externalRecord: newer,
        localWorkItem: stored.localWorkItem,
        fields: stored.conflict.fields,
      })
      return claim(workspaceId, conflictId, input)
    }
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflict.id,
      { resolution: 'use-external' },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    expect(fixture.patches).toEqual([])
    expect((await fixture.persistence.getConflict('workspace-1', conflict.id))?.resolutionOperationId).toBeUndefined()
  })

  test('leaves the claim of an attempt still running when a retry of it fails', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture)
    fixture.persistence.claimConflictResolution = async () => 'same-operation'
    const releases: string[] = []
    const release = fixture.persistence.releaseConflictResolution.bind(fixture.persistence)
    fixture.persistence.releaseConflictResolution = async (workspaceId, conflictId, operationId, refresh) => {
      releases.push(operationId)
      return release(workspaceId, conflictId, operationId, refresh)
    }
    fixture.setWorkItem({ ...fixture.getWorkItem(), revision: 10 })
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflict.id,
      { resolution: 'use-local' },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    expect(releases).toEqual([])
  })

  test('keeps the merged Work Item in the conflict when the moved event cannot be read', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture)
    const event = fixture.google.events.get(conflict.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(conflict.externalId, { ...event, etag: '"changed-again"' })
    fixture.google.hooks.failEventRead = true
    await expect(fixture.engine.resolveConflict(
      { workspaceId: 'workspace-1', userId: 'installer-1' },
      conflict.id,
      { resolution: 'merge', mergedValues: { schedule: { startDate: '2026-12-14', endDate: '2026-12-14' } } },
    )).rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    expect(fixture.getWorkItem()).toMatchObject({ revision: 10, schedule: { startDate: '2026-12-14' } })
    expect((await fixture.persistence.getConflict('workspace-1', conflict.id))?.conflict).toMatchObject({
      status: 'open',
      localRevision: 10,
    })
  })

  test('merges the same dates again after a refresh that kept the event version', async () => {
    const fixture = await createCalendarFixture()
    const conflict = await createScheduleConflict(fixture)
    const event = fixture.google.events.get(conflict.externalId)
    if (!event) throw new Error('Expected the event.')
    fixture.google.events.set(conflict.externalId, { ...event, etag: '"changed-again"' })
    fixture.google.hooks.failEventRead = true
    const actor = { workspaceId: 'workspace-1', userId: 'installer-1' }
    const merge = { resolution: 'merge' as const, mergedValues: { schedule: { startDate: '2026-12-14', endDate: '2026-12-14' } } }
    await expect(fixture.engine.resolveConflict(actor, conflict.id, merge))
      .rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    // The event could not be read, so the conflict still shows the old version. Merging again
    // conditions on the newer Work Item and must not replay the first operation.
    fixture.google.hooks.failEventRead = false
    await expect(fixture.engine.resolveConflict(actor, conflict.id, merge))
      .rejects.toMatchObject({ code: 'ConnectorSyncConflictChanged' })
    const resolved = await fixture.engine.resolveConflict(actor, conflict.id, merge)
    expect(resolved.status).toBe('resolved')
    expect(fixture.google.events.get(conflict.externalId)).toMatchObject({ start: { date: '2026-12-14' }, end: { date: '2026-12-15' } })
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
      { status: 200, payload: graphEvent },
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
    expect(requests[1]?.method).toBe('GET')
    expect(requests[3]?.headers).toMatchObject({ 'If-Match': 'W/"old"' })
  })

  test('reads the dates of a created event in the time zone it was written in', async () => {
    const protocol = new MicrosoftGraphCalendarEventProtocol()
    // Create and update responses leave the extended properties out.
    const written = { ...graphEvent, singleValueExtendedProperties: [] }
    const { request } = createRequester([
      { status: 201, payload: written },
      { status: 200, payload: graphEvent },
      { status: 200, payload: written },
      // A retried create returns the event the first attempt wrote in another time zone.
      { status: 201, payload: written },
      { status: 200, payload: graphEvent },
    ])
    const mutation = {
      resourceType: 'calendar-event' as const,
      workItemRevision: 3,
      title: 'Ship the release',
      schedule: { startDate: '2026-11-30', endDate: '2026-11-30', timeZone: 'Asia/Tokyo' },
      originMarker: 'v1.origin.marker',
      operationId: 'operation-1',
    }
    expect((await protocol.create(request, mutation)).schedule)
      .toEqual({ startDate: '2026-11-30', endDate: '2026-11-30' })
    expect((await protocol.push(request, { ...mutation, externalId: 'AAMkAGI2T_abc=' })).schedule)
      .toEqual({ startDate: '2026-11-30', endDate: '2026-11-30' })
    // The event is read back with the time zone it records, not the one this attempt would write.
    expect((await protocol.create(request, {
      ...mutation,
      schedule: { ...mutation.schedule, timeZone: 'America/Los_Angeles' },
    })).schedule).toEqual({ startDate: '2026-11-30', endDate: '2026-11-30' })
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
