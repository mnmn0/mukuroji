import { createHash } from 'node:crypto'
import { ConnectorRuntimeError } from './connector-runtime-error'
import type {
  ConnectorProviderRequester,
  ConnectorResourceProtocol,
} from './connector-resource-protocol'
import type {
  ConnectorCreateMutation,
  ConnectorEventSchedule,
  ConnectorExternalRecord,
  ConnectorOutboundMutation,
  ConnectorProviderId,
  ExternalResourceType,
} from './connectors'

/** Private extended property that marks an event Mukuroji created. */
const MANAGED_PROPERTY = 'mukurojiManaged'

/** Private extended property that carries the outbound origin marker. */
const ORIGIN_PROPERTY = 'mukurojiOrigin'

/** Microsoft Graph id of the managed-event extended property (PS_PUBLIC_STRINGS namespace). */
const GRAPH_MANAGED_PROPERTY_ID =
  `String {00020329-0000-0000-C000-000000000046} Name ${MANAGED_PROPERTY}`

/** Microsoft Graph id of the origin-marker extended property. */
const GRAPH_ORIGIN_PROPERTY_ID =
  `String {00020329-0000-0000-C000-000000000046} Name ${ORIGIN_PROPERTY}`

/** Private extended property that records the IANA time zone of the event's dates. */
const TIME_ZONE_PROPERTY = 'mukurojiTimeZone'

/** Microsoft Graph id of the time-zone extended property. */
const GRAPH_TIME_ZONE_PROPERTY_ID =
  `String {00020329-0000-0000-C000-000000000046} Name ${TIME_ZONE_PROPERTY}`

/** Asks Graph to return every date-time in UTC, which the time-zone property converts back. */
const GRAPH_UTC_PREFERENCE = { Prefer: 'outlook.timezone="UTC"' }

/** Longest event title Mukuroji writes. */
const TITLE_MAX_LENGTH = 1_024

/** Longest event description Mukuroji writes. */
const DESCRIPTION_MAX_LENGTH = 8_000

/** Longest provider cursor Mukuroji keeps between pages. */
const CURSOR_MAX_LENGTH = 4_096

/** Calendar events are the only resource type of both calendar providers. */
const CALENDAR_RESOURCE_TYPES: readonly ExternalResourceType[] = ['calendar-event']

/**
 * Returns the built-in resource protocol of a provider, or `undefined` when the provider uses
 * operator-configured REST bindings.
 *
 * @param provider - Built-in provider ID.
 * @returns The calendar protocol for Google Calendar and Outlook Calendar.
 */
export function createBuiltInConnectorResourceProtocol(
  provider: ConnectorProviderId,
): ConnectorResourceProtocol | undefined {
  if (provider === 'google-calendar') return new GoogleCalendarEventProtocol()
  if (provider === 'outlook-calendar') return new MicrosoftGraphCalendarEventProtocol()
  return undefined
}

/**
 * Google Calendar API v3 events in the primary calendar of the connected account. Events are
 * all-day, and Mukuroji finds its own events by a private extended property.
 */
export class GoogleCalendarEventProtocol implements ConnectorResourceProtocol {
  /** Resource types the protocol serves. */
  readonly resourceTypes = CALENDAR_RESOURCE_TYPES

  /**
   * Lists the events Mukuroji created, one provider page at a time.
   *
   * @param request - Authenticated provider requester.
   * @param resourceType - Must be `calendar-event`.
   * @param cursor - Google `pageToken` from the previous page.
   * @returns Events that are not cancelled, and the next page token.
   */
  async pull(
    request: ConnectorProviderRequester,
    resourceType: ExternalResourceType,
    cursor?: string,
  ) {
    requireCalendarResource(resourceType)
    const response = await request({
      method: 'GET',
      path: 'calendars/primary/events',
      query: {
        privateExtendedProperty: `${MANAGED_PROPERTY}=1`,
        maxResults: '250',
        ...(cursor === undefined ? {} : { pageToken: readCursor(cursor) }),
      },
    })
    const payload = requireObject(response.payload, 'Google Calendar event list')
    const items = payload.items ?? []
    if (!Array.isArray(items)) throw malformed('Google Calendar event list items must be an array.')
    const nextPageToken = payload.nextPageToken
    return {
      items: items
        .filter((item) => !(isObject(item) && item.status === 'cancelled'))
        .map(readGoogleEvent),
      ...(typeof nextPageToken === 'string' && nextPageToken !== ''
        ? { nextCursor: readCursor(nextPageToken) }
        : {}),
    }
  }

  /**
   * Reads one event, for example to refresh a conflict after a conditional write failed.
   *
   * @param request - Authenticated provider requester.
   * @param resourceType - Must be `calendar-event`.
   * @param externalId - Google event ID.
   * @returns The event as it is now.
   */
  async read(
    request: ConnectorProviderRequester,
    resourceType: ExternalResourceType,
    externalId: string,
  ) {
    requireCalendarResource(resourceType)
    const response = await request({
      method: 'GET',
      path: `calendars/primary/events/${encodeURIComponent(readEventId(externalId))}`,
      allowedStatuses: [404, 410],
    })
    if (response.status === 404 || response.status === 410) throw missingEvent()
    if (isObject(response.payload) && response.payload.status === 'cancelled') throw missingEvent()
    return readGoogleEvent(response.payload)
  }

  /**
   * Writes the Work Item title and dates to its event. The write is conditional on the event's
   * ETag, so an event changed since the last read is not overwritten.
   *
   * @param request - Authenticated provider requester.
   * @param mutation - Work Item contents.
   * @returns The updated event.
   */
  async push(request: ConnectorProviderRequester, mutation: ConnectorOutboundMutation) {
    requireCalendarResource(mutation.resourceType)
    const response = await request({
      method: 'PATCH',
      path: `calendars/primary/events/${encodeURIComponent(readEventId(mutation.externalId))}`,
      body: createGooglePatchBody(mutation),
      ...ifMatch(mutation.expectedExternalVersion),
      allowedStatuses: [404, 410, 412],
    })
    if (response.status === 404 || response.status === 410) throw missingEvent()
    if (response.status === 412) throw eventChanged()
    return readGoogleEvent(response.payload)
  }

  /**
   * Creates the event with an ID derived from the operation, so a retry finds the event the
   * first attempt created instead of adding another. A retry returns that event as it is now,
   * without writing to it: someone may have changed it since, and the sync engine compares its
   * dates with the Work Item's.
   *
   * @param request - Authenticated provider requester.
   * @param mutation - Work Item contents and the stable operation ID.
   * @returns The created event.
   */
  async create(request: ConnectorProviderRequester, mutation: ConnectorCreateMutation) {
    requireCalendarResource(mutation.resourceType)
    const id = createGoogleEventId(mutation.operationId)
    const body = createGoogleEventBody(mutation)
    const response = await request({
      method: 'POST',
      path: 'calendars/primary/events',
      body: { id, ...body },
      allowedStatuses: [409],
    })
    if (response.status !== 409) return readGoogleEvent(response.payload)
    return this.read(request, mutation.resourceType, id)
  }
}

/**
 * Microsoft Graph events in the default calendar of the connected account. Events are all-day,
 * and Mukuroji finds its own events by a single-value extended property.
 */
export class MicrosoftGraphCalendarEventProtocol implements ConnectorResourceProtocol {
  /** Resource types the protocol serves. */
  readonly resourceTypes = CALENDAR_RESOURCE_TYPES

  /**
   * Lists the events Mukuroji created, following `@odata.nextLink`.
   *
   * @param request - Authenticated provider requester.
   * @param resourceType - Must be `calendar-event`.
   * @param cursor - Query string of the previous page's next link.
   * @returns Events that are not cancelled, and the next page cursor.
   */
  async pull(
    request: ConnectorProviderRequester,
    resourceType: ExternalResourceType,
    cursor?: string,
  ) {
    requireCalendarResource(resourceType)
    const response = await request({
      method: 'GET',
      path: 'me/events',
      query: cursor === undefined
        ? {
            $filter:
              `singleValueExtendedProperties/Any(ep: ep/id eq '${GRAPH_MANAGED_PROPERTY_ID}' and ep/value eq '1')`,
            $expand:
              `singleValueExtendedProperties($filter=id eq '${GRAPH_ORIGIN_PROPERTY_ID}' or id eq '${GRAPH_TIME_ZONE_PROPERTY_ID}')`,
            $select: 'id,subject,webLink,lastModifiedDateTime,start,end,isAllDay,isCancelled',
            $top: '50',
          }
        : readGraphCursor(cursor),
      headers: GRAPH_UTC_PREFERENCE,
    })
    const payload = requireObject(response.payload, 'Microsoft Graph event list')
    const items = payload.value ?? []
    if (!Array.isArray(items)) throw malformed('Microsoft Graph event list value must be an array.')
    const nextLink = payload['@odata.nextLink']
    return {
      items: items
        .filter((item) => !(isObject(item) && item.isCancelled === true))
        .map((item) => readGraphEvent(item)),
      ...(typeof nextLink === 'string' && nextLink !== ''
        ? { nextCursor: toGraphCursor(nextLink) }
        : {}),
    }
  }

  /**
   * Reads one event, for example to refresh a conflict after a conditional write failed.
   *
   * @param request - Authenticated provider requester.
   * @param resourceType - Must be `calendar-event`.
   * @param externalId - Graph event ID.
   * @returns The event as it is now, with its dates in its stored time zone.
   */
  async read(
    request: ConnectorProviderRequester,
    resourceType: ExternalResourceType,
    externalId: string,
  ) {
    requireCalendarResource(resourceType)
    const response = await request({
      method: 'GET',
      path: `me/events/${encodeURIComponent(readEventId(externalId))}`,
      query: {
        $expand:
          `singleValueExtendedProperties($filter=id eq '${GRAPH_ORIGIN_PROPERTY_ID}' or id eq '${GRAPH_TIME_ZONE_PROPERTY_ID}')`,
        $select: 'id,subject,webLink,lastModifiedDateTime,start,end,isAllDay,isCancelled',
      },
      headers: GRAPH_UTC_PREFERENCE,
      allowedStatuses: [404, 410],
    })
    if (response.status === 404 || response.status === 410) throw missingEvent()
    if (isObject(response.payload) && response.payload.isCancelled === true) throw missingEvent()
    return readGraphEvent(response.payload)
  }

  /**
   * Writes the Work Item title and dates to its event, on the condition that the event's ETag has
   * not changed since the last read.
   *
   * @param request - Authenticated provider requester.
   * @param mutation - Work Item contents.
   * @returns The updated event.
   */
  async push(request: ConnectorProviderRequester, mutation: ConnectorOutboundMutation) {
    requireCalendarResource(mutation.resourceType)
    const response = await request({
      method: 'PATCH',
      path: `me/events/${encodeURIComponent(readEventId(mutation.externalId))}`,
      body: createGraphEventBody(mutation),
      headers: {
        ...GRAPH_UTC_PREFERENCE,
        ...(mutation.expectedExternalVersion === undefined
          ? {}
          : { 'If-Match': readVersion(mutation.expectedExternalVersion) }),
      },
      allowedStatuses: [404, 410, 412],
    })
    if (response.status === 404 || response.status === 410) throw missingEvent()
    if (response.status === 412) throw eventChanged()
    return readGraphEvent(response.payload, readGraphWriteTimeZone(mutation))
  }

  /**
   * Creates the event with a `transactionId` derived from the operation, which Graph uses to
   * drop a retried create, and reads it back with its recorded time zone.
   *
   * @param request - Authenticated provider requester.
   * @param mutation - Work Item contents and the stable operation ID.
   * @returns The created event.
   */
  async create(request: ConnectorProviderRequester, mutation: ConnectorCreateMutation) {
    requireCalendarResource(mutation.resourceType)
    const response = await request({
      method: 'POST',
      path: 'me/events',
      body: {
        ...createGraphEventBody(mutation),
        transactionId: `mukuroji-${hashOperation(mutation.operationId).slice(0, 40)}`,
      },
      headers: GRAPH_UTC_PREFERENCE,
    })
    // A retried create returns the event the first attempt made, which may hold another time
    // zone than this attempt's, so the event is read again with its recorded time zone.
    const created = readGraphEvent(response.payload, readGraphWriteTimeZone(mutation))
    return this.read(request, mutation.resourceType, created.externalId)
  }
}

/**
 * Builds the Google event fields Mukuroji owns.
 *
 * @param mutation - Work Item contents.
 * @returns The event body for insert and patch.
 */
function createGoogleEventBody(mutation: ConnectorCreateMutation) {
  const schedule = requireSchedule(mutation.schedule)
  return {
    summary: readTitle(mutation.title),
    description: readDescription(mutation.description),
    start: { date: schedule.startDate },
    end: { date: addDays(schedule.endDate, 1) },
    status: 'confirmed',
    transparency: 'transparent',
    extendedProperties: {
      private: {
        [MANAGED_PROPERTY]: '1',
        [ORIGIN_PROPERTY]: mutation.originMarker,
      },
    },
  }
}

/**
 * Builds the Google patch body. A patch merges `start` and `end` field by field, so the body
 * clears `dateTime` and `timeZone` too: an event someone made timed in the calendar becomes
 * all-day again instead of holding both kinds of boundary.
 *
 * @param mutation - Work Item contents.
 * @returns The event body for patch.
 */
function createGooglePatchBody(mutation: ConnectorCreateMutation) {
  const body = createGoogleEventBody(mutation)
  return {
    ...body,
    start: { ...body.start, dateTime: null, timeZone: null },
    end: { ...body.end, dateTime: null, timeZone: null },
  }
}

/**
 * Builds the Microsoft Graph event fields Mukuroji owns.
 *
 * @param mutation - Work Item contents.
 * @returns The event body for create and patch.
 */
function createGraphEventBody(mutation: ConnectorCreateMutation) {
  const schedule = requireSchedule(mutation.schedule)
  const timeZone = readGraphWriteTimeZone(mutation)
  return {
    subject: readTitle(mutation.title),
    body: { contentType: 'text', content: readDescription(mutation.description) },
    isAllDay: true,
    start: { dateTime: `${schedule.startDate}T00:00:00`, timeZone },
    end: { dateTime: `${addDays(schedule.endDate, 1)}T00:00:00`, timeZone },
    showAs: 'free',
    isReminderOn: false,
    singleValueExtendedProperties: [
      { id: GRAPH_MANAGED_PROPERTY_ID, value: '1' },
      { id: GRAPH_ORIGIN_PROPERTY_ID, value: mutation.originMarker },
      { id: GRAPH_TIME_ZONE_PROPERTY_ID, value: timeZone },
    ],
  }
}

/**
 * Returns the time zone a Graph write records the event's dates in.
 *
 * @param mutation - Work Item contents.
 * @returns The Work Item calendar's IANA time zone, or `UTC`.
 */
function readGraphWriteTimeZone(mutation: ConnectorCreateMutation) {
  return requireSchedule(mutation.schedule).timeZone ?? 'UTC'
}

/**
 * Reads a Google Calendar event into a normalized record.
 *
 * @param value - Event resource.
 * @returns The calendar-event record.
 */
function readGoogleEvent(value: unknown): ConnectorExternalRecord {
  const event = requireObject(value, 'Google Calendar event')
  const extended = isObject(event.extendedProperties) && isObject(event.extendedProperties.private)
    ? event.extendedProperties.private
    : {}
  const origin = extended[ORIGIN_PROPERTY]
  return {
    externalId: readEventId(event.id),
    resourceType: 'calendar-event',
    externalUrl: readHttpsUrl(event.htmlLink),
    externalVersion: readVersion(event.etag),
    ...(typeof event.summary === 'string' ? { title: event.summary } : {}),
    schedule: readEventSchedule(
      readGoogleEventTime(event.start, 'start'),
      readGoogleEventTime(event.end, 'end'),
    ),
    metadata: { calendar: 'primary' },
    ...(typeof origin === 'string' && origin !== '' ? { originMarker: origin } : {}),
  }
}

/**
 * Reads a Microsoft Graph event into a normalized record.
 *
 * @param value - Event resource.
 * @param writtenTimeZone - Time zone a write just recorded. Create and update responses leave the
 *   extended property out, so without it a UTC answer would be read a day early in Asia/Tokyo.
 * @returns The calendar-event record.
 */
function readGraphEvent(value: unknown, writtenTimeZone?: string): ConnectorExternalRecord {
  const event = requireObject(value, 'Microsoft Graph event')
  const properties = Array.isArray(event.singleValueExtendedProperties)
    ? event.singleValueExtendedProperties
    : []
  const originValue = readGraphProperty(properties, GRAPH_ORIGIN_PROPERTY_ID)
  const timeZone = readTimeZone(
    readGraphProperty(properties, GRAPH_TIME_ZONE_PROPERTY_ID) ?? writtenTimeZone,
  )
  return {
    externalId: readEventId(event.id),
    resourceType: 'calendar-event',
    externalUrl: readHttpsUrl(event.webLink),
    externalVersion: readVersion(event['@odata.etag']),
    ...(typeof event.subject === 'string' ? { title: event.subject } : {}),
    schedule: readEventSchedule(
      { value: readGraphDateTime(event.start, 'start', timeZone), allDay: event.isAllDay === true },
      { value: readGraphDateTime(event.end, 'end', timeZone), allDay: event.isAllDay === true },
    ),
    metadata: { calendar: 'default' },
    ...(typeof originValue === 'string' && originValue !== ''
      ? { originMarker: originValue }
      : {}),
  }
}

/** Start or end of an event: a date for all-day events, a local date-time otherwise. */
type EventTime = {
  /** `YYYY-MM-DD` or a date-time that starts with one. */
  value: string
  /** Whether the value is an all-day boundary, whose end is exclusive. */
  allDay: boolean
}

/**
 * Reads a Google `start` or `end` object.
 *
 * @param value - `{ date }` for all-day events or `{ dateTime }`.
 * @param label - Field name for errors.
 * @returns The boundary.
 */
function readGoogleEventTime(value: unknown, label: string): EventTime {
  const time = requireObject(value, `Google Calendar event ${label}`)
  if (typeof time.date === 'string') return { value: time.date, allDay: true }
  if (typeof time.dateTime === 'string') return { value: time.dateTime, allDay: false }
  throw malformed(`Google Calendar event ${label} has no date.`)
}

/**
 * Reads a Microsoft Graph `dateTimeTimeZone` value as a local date-time. Graph answers in UTC
 * (the requests ask for it), so a UTC value is converted to the event's recorded time zone: an
 * all-day November 30 event in Asia/Tokyo arrives as November 29 15:00 UTC.
 *
 * @param value - `{ dateTime, timeZone }`.
 * @param label - Field name for errors.
 * @param timeZone - IANA time zone the event's dates were written in, if recorded.
 * @returns The local date-time string.
 */
function readGraphDateTime(value: unknown, label: string, timeZone: string | undefined) {
  const time = requireObject(value, `Microsoft Graph event ${label}`)
  if (typeof time.dateTime !== 'string') {
    throw malformed(`Microsoft Graph event ${label} has no date-time.`)
  }
  const zone = typeof time.timeZone === 'string' ? time.timeZone : 'UTC'
  if (zone.toUpperCase() !== 'UTC' || timeZone === undefined) return time.dateTime
  const instant = Date.parse(`${time.dateTime.slice(0, 19)}Z`)
  if (Number.isNaN(instant)) throw malformed(`Microsoft Graph event ${label} date-time is invalid.`)
  return toLocalDateTime(instant, timeZone)
}

/**
 * Formats an instant as a `YYYY-MM-DDTHH:MM:SS` local date-time in a time zone.
 *
 * @param instant - Milliseconds since the epoch.
 * @param timeZone - IANA time zone.
 * @returns The local date-time.
 */
function toLocalDateTime(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
}

/**
 * Finds a single-value extended property of a Graph event.
 *
 * @param properties - `singleValueExtendedProperties` of the event.
 * @param id - Property id; Graph may change its letter case.
 * @returns The string value, if present.
 */
function readGraphProperty(properties: readonly unknown[], id: string) {
  const property = properties.find((candidate) =>
    isObject(candidate) &&
    typeof candidate.id === 'string' &&
    candidate.id.toLowerCase() === id.toLowerCase()
  )
  const value = isObject(property) ? property.value : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Accepts a recorded IANA time zone that the runtime knows.
 *
 * @param value - Recorded time zone.
 * @returns The time zone, or `undefined` when it is missing or unknown.
 */
function readTimeZone(value: string | undefined) {
  if (value === undefined || value.length > 64) return undefined
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return value
  } catch {
    return undefined
  }
}

/**
 * Converts event boundaries to inclusive local dates. An all-day end, and a timed end at
 * midnight, belong to the previous day.
 *
 * @param start - Event start.
 * @param end - Event end.
 * @returns Inclusive dates; the end is never before the start.
 */
function readEventSchedule(start: EventTime, end: EventTime): ConnectorEventSchedule {
  const startDate = readDatePart(start.value)
  let endDate = readDatePart(end.value)
  const endsAtMidnight = end.allDay || /^\d{4}-\d{2}-\d{2}T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})?$/u
    .test(end.value)
  if (endsAtMidnight && endDate > startDate) endDate = addDays(endDate, -1)
  if (endDate < startDate) endDate = startDate
  return { startDate, endDate }
}

/**
 * Takes the local calendar date at the start of a date or date-time string.
 *
 * @param value - Provider date or date-time.
 * @returns A real `YYYY-MM-DD` date.
 */
function readDatePart(value: string) {
  const date = value.slice(0, 10)
  if (!isCalendarDate(date)) throw malformed('Calendar event date is invalid.')
  return date
}

/**
 * Adds days to a calendar date in UTC arithmetic.
 *
 * @param date - `YYYY-MM-DD` date.
 * @param days - Days to add; negative subtracts.
 * @returns The shifted date.
 */
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/**
 * Checks a `YYYY-MM-DD` string names a real date.
 *
 * @param value - Candidate date.
 * @returns Whether the value round-trips through UTC.
 */
function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Requires inclusive dates on a calendar mutation.
 *
 * @param schedule - Mutation dates.
 * @returns Validated dates.
 */
function requireSchedule(schedule: ConnectorEventSchedule | undefined) {
  if (
    !schedule ||
    !isCalendarDate(schedule.startDate) ||
    !isCalendarDate(schedule.endDate) ||
    schedule.endDate < schedule.startDate
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorCalendarScheduleRequired',
      'A calendar event needs the Work Item dates.',
    )
  }
  return schedule
}

/**
 * Validates a provider ETag, which is the event version: it changes on every modification and
 * makes updates conditional.
 *
 * @param value - Google `etag` or Graph `@odata.etag`.
 * @returns The ETag.
 */
function readVersion(value: unknown) {
  if (typeof value !== 'string' || value === '' || value.length > 512 || hasControlCharacter(value)) {
    throw malformed('Calendar event ETag is invalid.')
  }
  return value
}

/**
 * Builds the `If-Match` header of a conditional update.
 *
 * @param version - ETag read last, if any.
 * @returns Request headers, or nothing for an unconditional write.
 */
function ifMatch(version: string | undefined) {
  return version === undefined ? {} : { headers: { 'If-Match': readVersion(version) } }
}

/**
 * Error for an event that changed since Mukuroji last read it. The next poll reads the change and
 * records a conflict when the Work Item changed too.
 *
 * @returns A non-retryable runtime error.
 */
function eventChanged() {
  return new ConnectorRuntimeError(
    'ConnectorExternalVersionChanged',
    'The calendar event changed since it was last read.',
  )
}

/**
 * Validates a provider event ID.
 *
 * @param value - Event ID.
 * @returns The ID.
 */
function readEventId(value: unknown) {
  if (typeof value !== 'string' || value === '' || value.length > 1_024 || hasControlCharacter(value)) {
    throw malformed('Calendar event ID is invalid.')
  }
  return value
}

/**
 * Validates the provider link of an event.
 *
 * @param value - Event URL.
 * @returns The HTTPS URL.
 */
function readHttpsUrl(value: unknown) {
  if (typeof value !== 'string') throw malformed('Calendar event link is missing.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw malformed('Calendar event link is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw malformed('Calendar event link must be an HTTPS URL.')
  }
  return url.toString()
}

/**
 * Fits a Work Item title into an event title.
 *
 * @param value - Work Item title.
 * @returns A non-empty title.
 */
function readTitle(value: string | undefined) {
  const title = (value ?? '').trim()
  return (title === '' ? 'Mukuroji' : title).slice(0, TITLE_MAX_LENGTH)
}

/**
 * Fits a Work Item description into an event description.
 *
 * @param value - Work Item description.
 * @returns The description, cut at the provider-safe length.
 */
function readDescription(value: string | undefined) {
  return (value ?? '').slice(0, DESCRIPTION_MAX_LENGTH)
}

/**
 * Derives a Google event ID from an operation ID. Google accepts base32hex characters, and a
 * lowercase hex digest uses only those.
 *
 * @param operationId - Stable operation ID.
 * @returns An ID of 66 characters.
 */
function createGoogleEventId(operationId: string) {
  return `mk${hashOperation(operationId)}`
}

/**
 * Hashes an operation ID for provider-side idempotency.
 *
 * @param operationId - Stable operation ID.
 * @returns Lowercase hex SHA-256.
 */
function hashOperation(operationId: string) {
  if (!operationId) {
    throw new ConnectorRuntimeError('ConnectorOperationIdInvalid', 'Connector operation ID is required.')
  }
  return createHash('sha256').update(`calendar-event-create-v1\0${operationId}`).digest('hex')
}

/**
 * Validates a page cursor.
 *
 * @param value - Provider cursor.
 * @returns The cursor.
 */
function readCursor(value: string) {
  if (value === '' || value.length > CURSOR_MAX_LENGTH || hasControlCharacter(value)) {
    throw malformed('Calendar event page cursor is invalid.')
  }
  return value
}

/**
 * Keeps only the query string of a Graph next link, so the next request still goes to the
 * configured API origin.
 *
 * @param nextLink - `@odata.nextLink` URL.
 * @returns The query string, starting with `?`.
 */
function toGraphCursor(nextLink: string) {
  let url: URL
  try {
    url = new URL(nextLink)
  } catch {
    throw malformed('Microsoft Graph next link is invalid.')
  }
  if (url.protocol !== 'https:' || !url.pathname.endsWith('/me/events') || url.search === '') {
    throw malformed('Microsoft Graph next link is invalid.')
  }
  return readCursor(url.search)
}

/**
 * Turns a Graph cursor back into query parameters.
 *
 * @param cursor - Query string from {@link toGraphCursor}.
 * @returns The parameters.
 */
function readGraphCursor(cursor: string) {
  if (!readCursor(cursor).startsWith('?')) throw malformed('Microsoft Graph cursor is invalid.')
  return Object.fromEntries(new URLSearchParams(cursor.slice(1)))
}

/**
 * Rejects resource types other than calendar events.
 *
 * @param resourceType - Requested resource type.
 */
function requireCalendarResource(resourceType: ExternalResourceType) {
  if (resourceType !== 'calendar-event') {
    throw new ConnectorRuntimeError(
      'ConnectorCapabilityUnsupported',
      `Calendar connectors do not support ${resourceType} resources.`,
    )
  }
}

/**
 * Error for an event that no longer exists in the calendar.
 *
 * @returns A non-retryable runtime error.
 */
function missingEvent() {
  return new ConnectorRuntimeError(
    'ConnectorExternalResourceMissing',
    'The linked calendar event no longer exists.',
    { providerStatus: 404 },
  )
}

/**
 * Requires a JSON object.
 *
 * @param value - Provider value.
 * @param label - Name for errors.
 * @returns The object.
 */
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw malformed(`${label} must be an object.`)
  return value
}

/**
 * Checks for a plain JSON object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Error for a provider response Mukuroji cannot read.
 *
 * @param message - Secret-free reason.
 * @returns A non-retryable runtime error.
 */
function malformed(message: string) {
  return new ConnectorRuntimeError('ConnectorProviderResponseMalformed', message)
}

/**
 * Checks for control characters, which no provider ID or cursor contains.
 *
 * @param value - Candidate text.
 * @returns Whether the text has a character below U+0020 or U+007F.
 */
function hasControlCharacter(value: string) {
  return [...value].some((character) => character < ' ' || character === '\x7f')
}
