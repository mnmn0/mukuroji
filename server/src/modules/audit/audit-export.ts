import { createHash, randomUUID } from 'node:crypto'
import {
  auditEventsToNdjson,
  type AuditActorKind,
  type AuditEventPage,
  type AuditEventQuery,
} from './audit'

/** Events written to one NDJSON part object. */
export const AUDIT_EXPORT_EVENTS_PER_PART = 5_000
/** Largest number of events one export job may contain. */
export const AUDIT_EXPORT_MAX_EVENTS = 1_000_000
/** Days a job and its artifacts remain downloadable. */
export const AUDIT_EXPORT_RETENTION_DAYS = 7
/** Events read from the audit index per query page. */
const AUDIT_EXPORT_QUERY_PAGE_SIZE = 100
/** Longest accepted `Idempotency-Key` header. */
const AUDIT_EXPORT_IDEMPOTENCY_KEY_MAX_LENGTH = 255
/** Shape of every export identifier. */
const AUDIT_EXPORT_ID_PATTERN = /^[0-9a-f]{32}$/u

/**
 * Audit query filters captured by an export job.
 */
export type AuditExportFilters = {
  /** Actor ID filter. */
  readonly actorId?: string
  /** Actor kind filter. */
  readonly actorKind?: AuditActorKind
  /** Activity entity type filter, paired with `entityId`. */
  readonly entityType?: string
  /** Activity entity ID filter. */
  readonly entityId?: string
  /** Mutation target type filter, paired with `targetId`. */
  readonly targetType?: string
  /** Mutation target ID filter. */
  readonly targetId?: string
  /** Event types to include. */
  readonly eventTypes?: readonly string[]
  /** Inclusive lower bound as an ISO 8601 timestamp. */
  readonly from?: string
  /** Inclusive upper bound as an ISO 8601 timestamp; queries never go past the request time. */
  readonly to?: string
}

/** Lifecycle state of an export job. */
export type AuditExportStatus = 'queued' | 'running' | 'completed' | 'failed'

/**
 * One NDJSON object written by an export job.
 */
export type AuditExportPart = {
  /** One-based part number in event order. */
  readonly index: number
  /** Object key of the part within the export bucket. */
  readonly key: string
  /** Events contained in the part. */
  readonly eventCount: number
  /** Size of the part in bytes. */
  readonly byteLength: number
  /** Hex SHA-256 digest of the part body. */
  readonly sha256: string
}

/**
 * Durable state of one asynchronous audit export.
 */
export type AuditExportJob = {
  /** Job document schema version. */
  readonly schemaVersion: 1
  /** Workspace whose audit log is exported. */
  readonly workspaceId: string
  /** Opaque export identifier. */
  readonly exportId: string
  /** Current lifecycle state. */
  readonly status: AuditExportStatus
  /** Filters applied to every query page. */
  readonly filters: AuditExportFilters
  /** Digest of the filters, used to detect idempotency-key reuse with other filters. */
  readonly requestFingerprint: string
  /** Request time; events after it are never included. */
  readonly snapshotAt: string
  /** Member who requested the export. */
  readonly requestedBy: {
    /** Workspace member key of the requester. */
    readonly userKey: string
    /** Display name shown in the export list. */
    readonly displayName: string
  }
  /** Creation time as an ISO 8601 timestamp. */
  readonly createdAt: string
  /** Last state change as an ISO 8601 timestamp. */
  readonly updatedAt: string
  /** Time after which the job and its parts are no longer served. */
  readonly expiresAt: string
  /** Events written so far. */
  readonly eventCount: number
  /** Parts written so far, in order. */
  readonly parts: readonly AuditExportPart[]
  /** Opaque audit query cursor where the next part starts. */
  readonly nextCursor?: string
  /** Terminal failure reported to the requester. */
  readonly failure?: {
    /** Stable error code. */
    readonly code: string
    /** Safe human-readable message. */
    readonly message: string
  }
}

/**
 * Job document read together with its optimistic-concurrency version.
 */
export type StoredAuditExportJob = {
  /** Current job state. */
  readonly job: AuditExportJob
  /** Opaque version that a replacement must match. */
  readonly version: string
}

/**
 * Persistence for export jobs and their NDJSON parts.
 */
export interface AuditExportStore {
  /**
   * Creates a job document only when no document exists for its ID.
   *
   * @param job - New job state.
   * @returns `created`, or `exists` when another document already uses the ID.
   */
  createJob(job: AuditExportJob): Promise<'created' | 'exists'>
  /**
   * Reads one job with its version.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   * @returns The stored job, or undefined when it does not exist.
   */
  readJob(workspaceId: string, exportId: string): Promise<StoredAuditExportJob | undefined>
  /**
   * Replaces a job only when its stored version still matches.
   *
   * @param job - Next job state.
   * @param expectedVersion - Version read before computing the next state.
   * @returns Whether the replacement was applied.
   */
  replaceJob(job: AuditExportJob, expectedVersion: string): Promise<boolean>
  /**
   * Lists the newest jobs of a Workspace.
   *
   * @param workspaceId - Workspace that owns the jobs.
   * @param limit - Maximum number of jobs.
   * @returns Jobs ordered from newest to oldest.
   */
  listJobs(workspaceId: string, limit: number): Promise<AuditExportJob[]>
  /**
   * Writes one NDJSON part; rewriting the same index replaces it.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   * @param index - One-based part number.
   * @param body - NDJSON content.
   * @returns The stored part key, size, and digest.
   */
  putPart(
    workspaceId: string,
    exportId: string,
    index: number,
    body: string,
  ): Promise<Omit<AuditExportPart, 'index' | 'eventCount'>>
  /**
   * Creates a short-lived download URL for one part.
   *
   * @param part - Part to download.
   * @returns A presigned URL.
   */
  createPartDownloadUrl(part: AuditExportPart): Promise<string>
}

/**
 * Queue that schedules the next export step.
 */
export interface AuditExportQueue {
  /**
   * Schedules processing of one export job.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   */
  enqueue(workspaceId: string, exportId: string): Promise<void>
}

/**
 * Queue message that schedules one export step.
 */
export type AuditExportQueueMessage = {
  /** Message contract version. */
  readonly version: 1
  /** Workspace that owns the job. */
  readonly workspaceId: string
  /** Export identifier. */
  readonly exportId: string
}

/**
 * Parses a queue message body.
 *
 * @param body - Raw SQS message body.
 * @returns The message, or undefined when it is malformed.
 */
export function parseAuditExportQueueMessage(body: string): AuditExportQueueMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const version: unknown = Reflect.get(value, 'version')
  const workspaceId: unknown = Reflect.get(value, 'workspaceId')
  const exportId: unknown = Reflect.get(value, 'exportId')
  if (
    version !== 1 ||
    typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 256 ||
    typeof exportId !== 'string' || !/^[0-9a-f]{32}$/u.test(exportId)
  ) {
    return undefined
  }
  return { version: 1, workspaceId, exportId }
}

/**
 * Reads one page of audit events.
 *
 * @param query - Audit query including the cursor and page size.
 * @returns The page of events.
 */
export type AuditExportEventReader = (query: AuditEventQuery) => Promise<AuditEventPage>

/**
 * Failure returned to the API caller with a stable status and code.
 */
export class AuditExportError extends Error {
  /** HTTP status that represents the failure. */
  readonly status: 400 | 404 | 409 | 503
  /** Stable machine-readable error code. */
  readonly code: string

  /**
   * Creates an export failure.
   *
   * @param status - HTTP status that represents the failure.
   * @param code - Stable machine-readable error code.
   * @param message - Safe human-readable message.
   */
  constructor(status: 400 | 404 | 409 | 503, code: string, message: string) {
    super(message)
    this.name = 'AuditExportError'
    this.status = status
    this.code = code
  }
}

/**
 * Dependencies of the audit export service.
 */
export type AuditExportServiceDependencies = {
  /** Job and part persistence. */
  readonly store: AuditExportStore
  /** Queue that schedules processing steps. */
  readonly queue: AuditExportQueue
  /** Audit event reader shared with the synchronous API. */
  readonly readEvents: AuditExportEventReader
  /** Clock used for timestamps. */
  readonly now?: () => Date
  /** Identifier factory used when no idempotency key is supplied. */
  readonly createId?: () => string
  /** Events per part; overridable for tests. */
  readonly eventsPerPart?: number
  /** Maximum events per export; overridable for tests. */
  readonly maxEvents?: number
}

/**
 * Input of an export request.
 */
export type AuditExportRequest = {
  /** Workspace whose audit log is exported. */
  readonly workspaceId: string
  /** Member who requests the export. */
  readonly requestedBy: AuditExportJob['requestedBy']
  /** Filters applied to the export. */
  readonly filters: AuditExportFilters
  /** Optional client idempotency key. */
  readonly idempotencyKey?: string
}

/** Result of one processing step. */
export type AuditExportStepResult = 'advanced' | 'completed' | 'failed' | 'skipped'

/**
 * Asynchronous audit export operations.
 */
export type AuditExportService = ReturnType<typeof createAuditExportService>

/**
 * Creates the asynchronous audit export service.
 *
 * Each processing step writes at most one part and advances the job with an
 * optimistic-concurrency replacement, so duplicate queue deliveries rewrite the
 * same deterministic part and only one of them schedules the next step.
 *
 * @param dependencies - Store, queue, event reader, and optional overrides.
 * @returns Export request, read, download, and processing operations.
 */
export function createAuditExportService(dependencies: AuditExportServiceDependencies) {
  const now = dependencies.now ?? (() => new Date())
  const createId = dependencies.createId ?? (() => randomUUID().replaceAll('-', ''))
  const eventsPerPart = dependencies.eventsPerPart ?? AUDIT_EXPORT_EVENTS_PER_PART
  const maxEvents = dependencies.maxEvents ?? AUDIT_EXPORT_MAX_EVENTS

  /**
   * Reads a job that is visible to the caller.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   * @returns The stored job.
   */
  async function readVisibleJob(workspaceId: string, exportId: string) {
    if (!AUDIT_EXPORT_ID_PATTERN.test(exportId)) {
      throw new AuditExportError(404, 'AuditExportNotFound', 'Audit export was not found.')
    }
    const stored = await dependencies.store.readJob(workspaceId, exportId)
    if (!stored || stored.job.workspaceId !== workspaceId || isExpired(stored.job, now())) {
      throw new AuditExportError(404, 'AuditExportNotFound', 'Audit export was not found.')
    }
    return stored
  }

  return {
    /**
     * Creates an export job, or returns the job already created with the same idempotency key.
     *
     * @param request - Workspace, requester, filters, and optional idempotency key.
     * @returns The job and whether this call created it.
     */
    async requestExport(request: AuditExportRequest) {
      const filters = normalizeAuditExportFilters(request.filters)
      const requestedAt = now()
      const snapshotAt = requestedAt.toISOString()
      const idempotencyKey = request.idempotencyKey?.trim()
      if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > AUDIT_EXPORT_IDEMPOTENCY_KEY_MAX_LENGTH)) {
        throw new AuditExportError(400, 'InvalidIdempotencyKey', 'Idempotency-Key must be 1 to 255 characters.')
      }
      const exportId = idempotencyKey
        ? createHash('sha256')
          .update(`${request.workspaceId}\0${request.requestedBy.userKey}\0${idempotencyKey}`)
          .digest('hex')
          .slice(0, 32)
        : createId()
      if (!AUDIT_EXPORT_ID_PATTERN.test(exportId)) {
        throw new TypeError('Audit export identifiers must be 32 lowercase hexadecimal digits.')
      }
      const requestFingerprint = createHash('sha256').update(stableStringify(filters)).digest('hex')
      const job: AuditExportJob = {
        schemaVersion: 1,
        workspaceId: request.workspaceId,
        exportId,
        status: 'queued',
        filters,
        requestFingerprint,
        snapshotAt,
        requestedBy: request.requestedBy,
        createdAt: snapshotAt,
        updatedAt: snapshotAt,
        expiresAt: new Date(requestedAt.getTime() + AUDIT_EXPORT_RETENTION_DAYS * 86_400_000).toISOString(),
        eventCount: 0,
        parts: [],
      }
      if (await dependencies.store.createJob(job) === 'created') {
        await dependencies.queue.enqueue(job.workspaceId, job.exportId)
        return { job, created: true }
      }
      const existing = await readVisibleJob(request.workspaceId, exportId)
      if (
        existing.job.requestedBy.userKey !== request.requestedBy.userKey ||
        existing.job.requestFingerprint !== requestFingerprint
      ) {
        throw new AuditExportError(
          409,
          'AuditExportIdempotencyConflict',
          'Idempotency-Key was already used for a different audit export.',
        )
      }
      if (existing.job.status === 'queued') {
        // A previous attempt may have stored the job but failed to enqueue it.
        await dependencies.queue.enqueue(existing.job.workspaceId, existing.job.exportId)
      }
      return { job: existing.job, created: false }
    },

    /**
     * Reads one export job.
     *
     * @param workspaceId - Workspace that owns the job.
     * @param exportId - Export identifier.
     * @returns The job.
     */
    async getExport(workspaceId: string, exportId: string) {
      return (await readVisibleJob(workspaceId, exportId)).job
    },

    /**
     * Lists the newest unexpired export jobs of a Workspace.
     *
     * @param workspaceId - Workspace that owns the jobs.
     * @returns Up to twenty jobs, newest first.
     */
    async listExports(workspaceId: string) {
      const current = now()
      return (await dependencies.store.listJobs(workspaceId, 20))
        .filter((job) => job.workspaceId === workspaceId && !isExpired(job, current))
    },

    /**
     * Creates download URLs for every part of a completed job.
     *
     * @param job - Completed export job.
     * @returns Part metadata with short-lived URLs.
     */
    async createDownloadLinks(job: AuditExportJob) {
      if (job.status !== 'completed') {
        throw new AuditExportError(409, 'AuditExportNotReady', 'Audit export has not completed.')
      }
      return await Promise.all(job.parts.map(async (part) => ({
        index: part.index,
        eventCount: part.eventCount,
        byteLength: part.byteLength,
        sha256: part.sha256,
        url: await dependencies.store.createPartDownloadUrl(part),
      })))
    },

    /**
     * Writes the next part of an export and schedules the following step.
     *
     * @param workspaceId - Workspace that owns the job.
     * @param exportId - Export identifier.
     * @returns What the step did.
     */
    async processExport(workspaceId: string, exportId: string): Promise<AuditExportStepResult> {
      if (!AUDIT_EXPORT_ID_PATTERN.test(exportId)) return 'skipped'
      const stored = await dependencies.store.readJob(workspaceId, exportId)
      if (!stored || stored.job.workspaceId !== workspaceId) return 'skipped'
      const { job, version } = stored
      if (job.status === 'completed' || job.status === 'failed') return 'skipped'
      if (isExpired(job, now())) {
        return await finish(job, version, failJob(job, now(), 'AuditExportExpired', 'Audit export expired before it completed.'))
      }

      const events: AuditEventPage['events'] = []
      let cursor = job.nextCursor
      let hasMore = true
      try {
        while (events.length < eventsPerPart) {
          const page = await dependencies.readEvents({
            workspaceId: job.workspaceId,
            ...job.filters,
            to: capAtSnapshot(job.filters.to, job.snapshotAt),
            direction: 'ascending',
            limit: Math.min(AUDIT_EXPORT_QUERY_PAGE_SIZE, eventsPerPart - events.length),
            ...(cursor ? { cursor } : {}),
          })
          events.push(...page.events)
          cursor = page.nextCursor
          if (!cursor) {
            hasMore = false
            break
          }
        }
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return await finish(job, version, failJob(job, now(), 'AuditExportQueryInvalid', 'Audit export filters could not be evaluated.'))
        }
        throw error
      }

      if (job.eventCount + events.length > maxEvents) {
        return await finish(job, version, failJob(
          job,
          now(),
          'AuditExportTooLarge',
          `Audit export exceeds ${maxEvents} events. Narrow the filters or period.`,
        ))
      }

      const parts = [...job.parts]
      if (events.length > 0) {
        const index = parts.length + 1
        const stored = await dependencies.store.putPart(
          job.workspaceId,
          job.exportId,
          index,
          await auditEventsToNdjson(events),
        )
        parts.push({ index, eventCount: events.length, ...stored })
      }
      const { nextCursor: _previousCursor, ...withoutCursor } = job
      void _previousCursor
      const next: AuditExportJob = {
        ...withoutCursor,
        status: hasMore ? 'running' : 'completed',
        parts,
        eventCount: job.eventCount + events.length,
        updatedAt: now().toISOString(),
        ...(hasMore && cursor ? { nextCursor: cursor } : {}),
      }
      return await finish(job, version, next)
    },
  }

  /**
   * Applies the next job state and schedules another step when work remains.
   *
   * @param current - Job state read at the start of the step.
   * @param version - Version read at the start of the step.
   * @param next - Next job state.
   * @returns What the step did.
   */
  async function finish(
    current: AuditExportJob,
    version: string,
    next: AuditExportJob,
  ): Promise<AuditExportStepResult> {
    if (!await dependencies.store.replaceJob(next, version)) return 'skipped'
    if (next.status === 'running') {
      await dependencies.queue.enqueue(current.workspaceId, current.exportId)
      return 'advanced'
    }
    return next.status === 'completed' ? 'completed' : 'failed'
  }
}

/**
 * Validates export filters and caps the upper bound at the request time.
 *
 * @param filters - Filters parsed from the request.
 * @returns Filters with empty values removed.
 */
export function normalizeAuditExportFilters(filters: AuditExportFilters): AuditExportFilters {
  if (Boolean(filters.entityType) !== Boolean(filters.entityId)) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'entityType and entityId must be supplied together.')
  }
  if (Boolean(filters.targetType) !== Boolean(filters.targetId)) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'targetType and targetId must be supplied together.')
  }
  for (const [label, value] of [['from', filters.from], ['to', filters.to]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new AuditExportError(400, 'InvalidAuditExportFilters', `${label} must be an ISO 8601 timestamp.`)
    }
  }
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'from must not be later than to.')
  }
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
    ),
  )
}

/**
 * Projects a job into the API response without internal fields.
 *
 * @param job - Stored job.
 * @returns Public job view.
 */
export function toAuditExportView(job: AuditExportJob) {
  return {
    exportId: job.exportId,
    status: job.status,
    filters: job.filters,
    snapshotAt: job.snapshotAt,
    requestedBy: { displayName: job.requestedBy.displayName },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    eventCount: job.eventCount,
    partCount: job.parts.length,
    ...(job.failure ? { failure: job.failure } : {}),
  }
}

/**
 * Creates the object key prefix that holds one Workspace's exports.
 *
 * The Workspace ID is hashed so object keys do not reveal it.
 *
 * @param workspaceId - Workspace that owns the exports.
 * @returns Prefix ending with `/`.
 */
export function createAuditExportWorkspacePrefix(workspaceId: string) {
  return `audit-exports/${createHash('sha256').update(workspaceId).digest('hex')}/`
}

/**
 * Caps the export upper bound at the request time so later events never enter the export.
 *
 * @param to - Upper bound requested by the caller.
 * @param snapshotAt - Request time.
 * @returns The earlier of the two timestamps.
 */
function capAtSnapshot(to: string | undefined, snapshotAt: string) {
  return to !== undefined && Date.parse(to) < Date.parse(snapshotAt) ? to : snapshotAt
}

/**
 * Checks whether a job is past its retention period.
 *
 * @param job - Job to check.
 * @param current - Current time.
 * @returns `true` when the job expired.
 */
function isExpired(job: AuditExportJob, current: Date) {
  return Date.parse(job.expiresAt) <= current.getTime()
}

/**
 * Builds the failed state of a job.
 *
 * @param job - Current job state.
 * @param at - Failure time.
 * @param code - Stable error code.
 * @param message - Safe message.
 * @returns The failed job state.
 */
function failJob(job: AuditExportJob, at: Date, code: string, message: string): AuditExportJob {
  const { nextCursor: _cursor, ...rest } = job
  void _cursor
  return { ...rest, status: 'failed', updatedAt: at.toISOString(), failure: { code, message } }
}

/**
 * Serializes a value with sorted object keys.
 *
 * @param value - Value to serialize.
 * @returns Deterministic JSON text.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Validates a stored job document.
 *
 * @param value - Parsed JSON read from storage.
 * @returns The validated job.
 */
export function parseAuditExportJob(value: unknown): AuditExportJob {
  const record = requireObject(value, 'Audit export job')
  const status = record.status
  if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed') {
    throw new TypeError('Audit export job has an unknown status.')
  }
  if (record.schemaVersion !== 1) throw new TypeError('Audit export job has an unknown schema version.')
  const requestedBy = requireObject(record.requestedBy, 'Audit export requester')
  const filters = requireObject(record.filters, 'Audit export filters')
  const parts = record.parts
  if (!Array.isArray(parts)) throw new TypeError('Audit export parts must be an array.')
  const failure = record.failure === undefined ? undefined : requireObject(record.failure, 'Audit export failure')
  const exportId = requireString(record.exportId, 'exportId')
  if (!AUDIT_EXPORT_ID_PATTERN.test(exportId)) throw new TypeError('Audit export job has an invalid ID.')
  return {
    schemaVersion: 1,
    workspaceId: requireString(record.workspaceId, 'workspaceId'),
    exportId,
    status,
    filters: parseFilters(filters),
    requestFingerprint: requireString(record.requestFingerprint, 'requestFingerprint'),
    snapshotAt: requireString(record.snapshotAt, 'snapshotAt'),
    requestedBy: {
      userKey: requireString(requestedBy.userKey, 'requestedBy.userKey'),
      displayName: requireString(requestedBy.displayName, 'requestedBy.displayName'),
    },
    createdAt: requireString(record.createdAt, 'createdAt'),
    updatedAt: requireString(record.updatedAt, 'updatedAt'),
    expiresAt: requireString(record.expiresAt, 'expiresAt'),
    eventCount: requireCount(record.eventCount, 'eventCount'),
    parts: parts.map((entry: unknown) => {
      const part = requireObject(entry, 'Audit export part')
      return {
        index: requireCount(part.index, 'part.index'),
        key: requireString(part.key, 'part.key'),
        eventCount: requireCount(part.eventCount, 'part.eventCount'),
        byteLength: requireCount(part.byteLength, 'part.byteLength'),
        sha256: requireString(part.sha256, 'part.sha256'),
      }
    }),
    ...(record.nextCursor === undefined ? {} : { nextCursor: requireString(record.nextCursor, 'nextCursor') }),
    ...(failure
      ? { failure: { code: requireString(failure.code, 'failure.code'), message: requireString(failure.message, 'failure.message') } }
      : {}),
  }
}

/**
 * Validates stored filters.
 *
 * @param filters - Stored filter object.
 * @returns Validated filters.
 */
function parseFilters(filters: Record<string, unknown>): AuditExportFilters {
  const optional = (key: string) => {
    const value = filters[key]
    return value === undefined ? {} : { [key]: requireString(value, `filters.${key}`) }
  }
  const actorKind = filters.actorKind
  if (
    actorKind !== undefined &&
    actorKind !== 'user' && actorKind !== 'system' &&
    actorKind !== 'service' && actorKind !== 'break-glass'
  ) {
    throw new TypeError('Audit export filters have an unknown actor kind.')
  }
  const eventTypes = filters.eventTypes
  if (eventTypes !== undefined && (!Array.isArray(eventTypes) || !eventTypes.every((entry) => typeof entry === 'string'))) {
    throw new TypeError('Audit export eventTypes must be strings.')
  }
  return {
    ...optional('actorId'),
    ...(actorKind === undefined ? {} : { actorKind }),
    ...optional('entityType'),
    ...optional('entityId'),
    ...optional('targetType'),
    ...optional('targetId'),
    ...(eventTypes === undefined ? {} : { eventTypes: eventTypes.filter((entry): entry is string => typeof entry === 'string') }),
    ...optional('from'),
    ...optional('to'),
  }
}

/**
 * Requires a non-array object.
 *
 * @param value - Candidate value.
 * @param label - Name used in the error.
 * @returns The object.
 */
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
  return Object.fromEntries(Object.entries(value))
}

/**
 * Requires a string.
 *
 * @param value - Candidate value.
 * @param label - Name used in the error.
 * @returns The string.
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`)
  return value
}

/**
 * Requires a non-negative safe integer.
 *
 * @param value - Candidate value.
 * @param label - Name used in the error.
 * @returns The integer.
 */
function requireCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`)
  }
  return value
}
