import { createHash, randomUUID } from 'node:crypto'
import {
  assertValidAuditQueryFilters,
  auditEventsToNdjson,
  type AuditActorKind,
  type AuditEventPage,
  type AuditEventQuery,
} from './audit'

/** Events written to one NDJSON part object. */
export const AUDIT_EXPORT_EVENTS_PER_PART = 5_000

/** Query pages one processing step may evaluate before it checkpoints. */
export const AUDIT_EXPORT_PAGES_PER_STEP = 50

/** Approximate serialized bytes one part may hold before it is closed. */
export const AUDIT_EXPORT_PART_BYTE_BUDGET = 32 * 1024 * 1024

/**
 * Seconds a job waits after its snapshot time before reading events, so events
 * committed before the snapshot have propagated to the eventually consistent indexes.
 */
export const AUDIT_EXPORT_SETTLE_SECONDS = 30
/** Largest number of events one export job may contain. */
export const AUDIT_EXPORT_MAX_EVENTS = 1_000_000
/**
 * Largest number of parts one export job may contain.
 *
 * Highly selective filters can close a part after only a few matches, so the event
 * limit alone does not bound the part list stored in the job.
 */
export const AUDIT_EXPORT_MAX_PARTS = 10_000
/**
 * Hours a job may spend processing before it fails.
 *
 * The bucket lifecycle expires each object a fixed number of days after its own
 * write, so bounding the last write bounds how long any artifact can outlive its job.
 */
export const AUDIT_EXPORT_PROCESSING_HOURS = 24
/** Seconds before a step retries while the tenant is not active (the SQS maximum delay). */
const AUDIT_EXPORT_INACTIVE_TENANT_RETRY_SECONDS = 900
/** Days a job and its artifacts remain downloadable. */
export const AUDIT_EXPORT_RETENTION_DAYS = 7
/** Events read from the audit index per query page. */
const AUDIT_EXPORT_QUERY_PAGE_SIZE = 100
/** Longest accepted `Idempotency-Key` header. */
const AUDIT_EXPORT_IDEMPOTENCY_KEY_MAX_LENGTH = 255

/**
 * Minimum days the `audit.export-requested` event is kept, whatever the audit retention.
 *
 * The event is the key's receipt, so it must outlive the job (7 days) and every artifact the
 * bucket lifecycle can still hold (8 days after the last write plus 1 day for old versions).
 */
export const AUDIT_EXPORT_RECEIPT_RETENTION_DAYS = 17

/** Maximum number of part download links returned by one download request. */
export const AUDIT_EXPORT_DOWNLOAD_LINKS_PER_PAGE = 100
/** Filter fields an export job may store. */
const AUDIT_EXPORT_FILTER_KEYS = new Set([
  'actorId', 'actorKind', 'entityType', 'entityId', 'targetType', 'targetId', 'eventTypes', 'from', 'to',
])
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
   * Writes one NDJSON part under a content-addressed key, so a concurrent step
   * with different content can never replace the object a committed job references.
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
   * Creates a short-lived download URL for one part of one export.
   *
   * @param workspaceId - Workspace that owns the export.
   * @param exportId - Export the part belongs to.
   * @param part - Part to download.
   * @returns A presigned URL.
   * @throws TypeError when the part key is outside that export.
   */
  createPartDownloadUrl(workspaceId: string, exportId: string, part: AuditExportPart): Promise<string>
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
   * @param delaySeconds - Optional delivery delay, at most 900 seconds.
   */
  enqueue(workspaceId: string, exportId: string, delaySeconds?: number): Promise<void>
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
  /**
   * Reports whether the Workspace is active. Steps for closing or closed tenants
   * stop without writing, so exports cannot recreate data after tenant closure.
   */
  readonly isTenantActive?: (workspaceId: string) => Promise<boolean>
  /** Events per part; overridable for tests. */
  readonly eventsPerPart?: number
  /** Query pages per step; overridable for tests. */
  readonly pagesPerStep?: number
  /** Serialized byte budget per part; overridable for tests. */
  readonly partByteBudget?: number
  /** Settle delay after the snapshot time; overridable for tests. */
  readonly settleSeconds?: number
  /** Maximum events per export; overridable for tests. */
  readonly maxEvents?: number
  /** Overrides the part limit for tests. */
  readonly maxParts?: number
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
export type AuditExportStepResult = 'advanced' | 'completed' | 'deferred' | 'failed' | 'skipped'

/**
 * Asynchronous audit export operations.
 */
export type AuditExportService = ReturnType<typeof createAuditExportService>

/**
 * Creates the asynchronous audit export service.
 *
 * Each processing step evaluates a bounded number of query pages, writes at most one
 * content-addressed part, and advances the job with an optimistic-concurrency
 * replacement. Duplicate queue deliveries therefore never overwrite the part a
 * committed job references, and only one of them schedules the next step.
 *
 * @param dependencies - Store, queue, event reader, and optional overrides.
 * @returns Export request, read, download, and processing operations.
 */
export function createAuditExportService(dependencies: AuditExportServiceDependencies) {
  const now = dependencies.now ?? (() => new Date())
  const createId = dependencies.createId ?? (() => randomUUID().replaceAll('-', ''))
  const eventsPerPart = dependencies.eventsPerPart ?? AUDIT_EXPORT_EVENTS_PER_PART
  const maxEvents = dependencies.maxEvents ?? AUDIT_EXPORT_MAX_EVENTS
  const maxParts = dependencies.maxParts ?? AUDIT_EXPORT_MAX_PARTS
  const pagesPerStep = dependencies.pagesPerStep ?? AUDIT_EXPORT_PAGES_PER_STEP
  const partByteBudget = dependencies.partByteBudget ?? AUDIT_EXPORT_PART_BYTE_BUDGET
  const settleSeconds = dependencies.settleSeconds ?? AUDIT_EXPORT_SETTLE_SECONDS

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
    const current = now()
    if (!stored || stored.job.workspaceId !== workspaceId || isExpired(stored.job, current)) {
      throw new AuditExportError(404, 'AuditExportNotFound', 'Audit export was not found.')
    }
    return { ...stored, job: presentAuditExportJob(stored.job, current) }
  }

  return {
    /**
     * Creates an export job, or returns the job already created with the same idempotency key.
     *
     * @param request - Workspace, requester, filters, and optional idempotency key.
     * @returns The job and whether this call created it.
     */
    async requestExport(request: AuditExportRequest) {
      const requestedAt = now()
      const filters = normalizeAuditExportFilters(request.filters, requestedAt)
      const snapshotAt = requestedAt.toISOString()
      const idempotencyKey = request.idempotencyKey === undefined ? undefined : requireIdempotencyKey(request.idempotencyKey)
      const exportId = idempotencyKey
        ? deriveAuditExportId(request.workspaceId, request.requestedBy.userKey, idempotencyKey)
        : createId()
      if (!AUDIT_EXPORT_ID_PATTERN.test(exportId)) {
        throw new TypeError('Audit export identifiers must be 32 lowercase hexadecimal digits.')
      }
      const requestFingerprint = createAuditExportRequestFingerprint(filters)
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
        try {
          await dependencies.queue.enqueue(job.workspaceId, job.exportId, settleSeconds)
        } catch (error) {
          // With an idempotency key, retrying the request re-enqueues the queued job.
          // Without one a retry creates a new job, so this one must not stay queued forever.
          const stored = idempotencyKey ? undefined : await dependencies.store.readJob(job.workspaceId, job.exportId)
          if (stored) {
            await dependencies.store.replaceJob(
              failJob(stored.job, now(), 'AuditExportEnqueueFailed', 'The export could not be scheduled. Request it again.'),
              stored.version,
            )
          }
          throw error
        }
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
        await dependencies.queue.enqueue(existing.job.workspaceId, existing.job.exportId, settleSeconds)
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
     * Validates a keyed export request without side effects.
     *
     * Resolves the export identifier the request will use and rejects a key that was
     * already used for a different export, so callers can record the request first.
     *
     * @param request - Workspace, requester, filters, and idempotency key.
     * @returns The export identifier, the normalized filters, their fingerprint, and whether
     * the job still exists.
     */
    async prepareExport(request: AuditExportRequest & { readonly idempotencyKey: string }) {
      const filters = normalizeAuditExportFilters(request.filters, now())
      const idempotencyKey = requireIdempotencyKey(request.idempotencyKey)
      const exportId = deriveAuditExportId(request.workspaceId, request.requestedBy.userKey, idempotencyKey)
      const existing = await dependencies.store.readJob(request.workspaceId, exportId)
      if (
        existing &&
        (existing.job.requestedBy.userKey !== request.requestedBy.userKey ||
          existing.job.requestFingerprint !== createAuditExportRequestFingerprint(filters))
      ) {
        throw new AuditExportError(
          409,
          'AuditExportIdempotencyConflict',
          'Idempotency-Key was already used for a different audit export.',
        )
      }
      if (existing && isExpired(existing.job, now())) {
        // The job object outlives its API lifetime until the bucket lifecycle removes it.
        throw auditExportIdempotencyKeyExpired()
      }
      return { exportId, filters, requestFingerprint: createAuditExportRequestFingerprint(filters), jobExists: existing !== undefined }
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
        .map((job) => presentAuditExportJob(job, current))
    },

    /**
     * Creates download URLs for one page of parts of a completed job.
     *
     * @param job - Completed export job.
     * @param fromPart - Index of the first part to sign.
     * @returns Part metadata with short-lived URLs, and the next page's first part when more remain.
     */
    async createDownloadLinks(job: AuditExportJob, fromPart = 0) {
      if (job.status !== 'completed') {
        throw new AuditExportError(409, 'AuditExportNotReady', 'Audit export has not completed.')
      }
      if (!Number.isSafeInteger(fromPart) || fromPart < 0 || (fromPart > 0 && fromPart >= job.parts.length)) {
        throw new AuditExportError(400, 'InvalidAuditExportPart', 'fromPart must be the index of an existing part.')
      }
      const end = fromPart + AUDIT_EXPORT_DOWNLOAD_LINKS_PER_PAGE
      const parts = await Promise.all(job.parts.slice(fromPart, end).map(async (part) => ({
        index: part.index,
        eventCount: part.eventCount,
        byteLength: part.byteLength,
        sha256: part.sha256,
        url: await dependencies.store.createPartDownloadUrl(job.workspaceId, job.exportId, part),
      })))
      return { parts, ...(end < job.parts.length ? { nextPart: end } : {}) }
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
      const tenantActive = dependencies.isTenantActive ? await dependencies.isTenantActive(workspaceId) : true
      const stored = await dependencies.store.readJob(workspaceId, exportId)
      if (!stored || stored.job.workspaceId !== workspaceId) return 'skipped'
      const { job, version } = stored
      if (job.status === 'completed' || job.status === 'failed') return 'skipped'
      const current = now()
      if (!tenantActive) {
        // A closing tenant may still be restored, so keep the job resumable without writing.
        // Once closure deletes the export namespace the job is gone, and past the processing
        // deadline nothing would be written anyway, so the chain ends.
        if (isExpired(job, current) || isPastProcessingDeadline(job, current)) return 'skipped'
        await dependencies.queue.enqueue(job.workspaceId, job.exportId, AUDIT_EXPORT_INACTIVE_TENANT_RETRY_SECONDS)
        return 'deferred'
      }
      if (isExpired(job, current) || isPastProcessingDeadline(job, current)) {
        // Past the write deadline nothing is written, not even the failure: rewriting job.json
        // would restart the bucket's expiration clock. Readers present the job as timed out.
        return 'skipped'
      }
      const settleRemainingSeconds = Math.ceil(
        (Date.parse(job.snapshotAt) + settleSeconds * 1000 - current.getTime()) / 1000,
      )
      if (settleRemainingSeconds > 0) {
        // Index reads are eventually consistent; wait until pre-snapshot events have propagated.
        await dependencies.queue.enqueue(job.workspaceId, job.exportId, Math.min(settleRemainingSeconds, 900))
        return 'deferred'
      }

      const events: AuditEventPage['events'] = []
      let cursor = job.nextCursor
      let hasMore = true
      let pages = 0
      let approximateBytes = 0
      try {
        while (events.length < eventsPerPart && pages < pagesPerStep && approximateBytes < partByteBudget) {
          const page = await dependencies.readEvents({
            workspaceId: job.workspaceId,
            ...job.filters,
            to: capAtSnapshot(job.filters.to, job.snapshotAt),
            direction: 'ascending',
            limit: Math.min(AUDIT_EXPORT_QUERY_PAGE_SIZE, eventsPerPart - events.length),
            ...(cursor ? { cursor } : {}),
          })
          pages += 1
          events.push(...page.events)
          for (const event of page.events) approximateBytes += JSON.stringify(event).length
          cursor = page.nextCursor
          if (!cursor) {
            hasMore = false
            break
          }
        }
      } catch (error) {
        // Only filters the query layer rejects are terminal. Other TypeErrors, such as a
        // malformed persisted audit row, propagate so the message retries and reaches the DLQ.
        if ((error instanceof TypeError || error instanceof RangeError) && !areQueryFiltersValid(job)) {
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

      if (events.length > 0 && job.parts.length >= maxParts) {
        return await finish(job, version, failJob(
          job,
          now(),
          'AuditExportTooManyParts',
          `Audit export exceeds ${maxParts} parts. Narrow the filters or period.`,
        ))
      }

      const parts = [...job.parts]
      // Reading can take most of the Lambda timeout; never start a write past the deadline.
      if (isPastProcessingDeadline(job, now()) || isExpired(job, now())) return 'skipped'
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
    // Rewriting job.json restarts its lifecycle clock, so nothing is written past the deadline.
    const writeTime = now()
    if (isPastProcessingDeadline(current, writeTime) || isExpired(current, writeTime)) return 'skipped'
    if (!await dependencies.store.replaceJob(next, version)) return 'skipped'
    if (next.status === 'running') {
      await dependencies.queue.enqueue(current.workspaceId, current.exportId)
      return 'advanced'
    }
    return next.status === 'completed' ? 'completed' : 'failed'
  }
}

/**
 * Builds the error for a key whose export already expired.
 *
 * @returns The stable 409 error.
 */
export function auditExportIdempotencyKeyExpired(): AuditExportError {
  return new AuditExportError(
    409,
    'AuditExportIdempotencyKeyExpired',
    'This Idempotency-Key belongs to an export that has expired. Use a new key.',
  )
}

/**
 * Reads a stored ISO timestamp.
 *
 * @param value - Stored value.
 * @param label - Field name for errors.
 * @returns The timestamp text.
 */
function requireInstant(value: unknown, label: string): string {
  const text = requireString(value, label)
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp.`)
  return text
}

/**
 * Derives the export identifier that a keyed request always uses.
 *
 * @param workspaceId - Workspace that owns the export.
 * @param userKey - Member who requests the export.
 * @param idempotencyKey - Client idempotency key.
 * @returns 32 lowercase hexadecimal digits.
 */
function deriveAuditExportId(workspaceId: string, userKey: string, idempotencyKey: string): string {
  return createHash('sha256')
    .update(`${workspaceId}\0${userKey}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Validates and trims a client idempotency key.
 *
 * @param value - Raw key.
 * @returns The trimmed key.
 */
function requireIdempotencyKey(value: string): string {
  const key = value.trim()
  if (!key || key.length > AUDIT_EXPORT_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new AuditExportError(400, 'InvalidIdempotencyKey', 'Idempotency-Key must be 1 to 255 characters.')
  }
  return key
}

/**
 * Fingerprints normalized filters so a reused key with different filters is detected.
 *
 * @param filters - Normalized filters.
 * @returns Hex SHA-256 of the canonical filter JSON.
 */
export function createAuditExportRequestFingerprint(filters: AuditExportFilters): string {
  return createHash('sha256').update(stableStringify(filters)).digest('hex')
}

/**
 * Validates export filters against the request time.
 *
 * The worker caps the upper bound at the snapshot time, so a lower bound after the
 * request time could never match and is rejected here instead of failing the job.
 *
 * @param filters - Filters parsed from the request.
 * @param requestedAt - Request time that becomes the snapshot time.
 * @returns Filters with empty values removed.
 */
export function normalizeAuditExportFilters(filters: AuditExportFilters, requestedAt: Date): AuditExportFilters {
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
  if (filters.from && Date.parse(filters.from) > requestedAt.getTime()) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'from must not be in the future.')
  }
  // A supplied but empty value must not silently drop a restriction; only {"filters":{}}
  // requests an unfiltered export.
  for (const [key, value] of Object.entries(filters)) {
    if ((typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0)) {
      throw new AuditExportError(400, 'InvalidAuditExportFilters', `${key} must not be empty; omit it to leave it unrestricted.`)
    }
  }
  const normalized: AuditExportFilters = Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  )
  try {
    // Reject at request time what the worker's queries would reject later.
    assertValidAuditQueryFilters({ workspaceId: 'validation', ...normalized })
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new AuditExportError(400, 'InvalidAuditExportFilters', error.message)
    }
    throw error
  }
  return normalized
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
 * Checks whether a job's stored filters are accepted by the audit query layer.
 *
 * @param job - Stored job.
 * @returns Whether the filters are valid.
 */
function areQueryFiltersValid(job: AuditExportJob): boolean {
  try {
    assertValidAuditQueryFilters({ workspaceId: job.workspaceId, ...job.filters, to: capAtSnapshot(job.filters.to, job.snapshotAt) })
    return true
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false
    throw error
  }
}

/**
 * Checks whether a job has passed its processing deadline.
 *
 * @param job - Stored job.
 * @param current - Current time.
 * @returns Whether the job may no longer write parts.
 */
function isPastProcessingDeadline(job: AuditExportJob, current: Date) {
  return Date.parse(job.createdAt) + AUDIT_EXPORT_PROCESSING_HOURS * 3_600_000 <= current.getTime()
}

/**
 * Presents an unfinished job past its processing deadline as timed out.
 *
 * The worker stops writing at the deadline so the stored job keeps its last write time,
 * which bounds how long the bucket retains it; readers derive the failure instead.
 *
 * @param job - Stored job.
 * @param current - Current time.
 * @returns The job as callers should see it.
 */
function presentAuditExportJob(job: AuditExportJob, current: Date): AuditExportJob {
  if (job.status === 'completed' || job.status === 'failed' || !isPastProcessingDeadline(job, current)) return job
  const deadline = new Date(Date.parse(job.createdAt) + AUDIT_EXPORT_PROCESSING_HOURS * 3_600_000)
  return failJob(
    job,
    deadline,
    'AuditExportProcessingTimedOut',
    `Audit export did not finish within ${AUDIT_EXPORT_PROCESSING_HOURS} hours. Request it again.`,
  )
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
  // Deadlines are enforced from these times, so an unreadable or reordered pair is corrupt.
  const parsedFilters = parseFilters(filters)
  const requestFingerprint = requireString(record.requestFingerprint, 'requestFingerprint')
  // The fingerprint guards key reuse, so it must describe the filters the worker will run.
  if (requestFingerprint !== createAuditExportRequestFingerprint(parsedFilters)) {
    throw new TypeError('Audit export job filters do not match their fingerprint.')
  }
  const createdAt = requireInstant(record.createdAt, 'createdAt')
  const expiresAt = requireInstant(record.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new TypeError('Audit export job expires before it was created.')
  }
  return {
    schemaVersion: 1,
    workspaceId: requireString(record.workspaceId, 'workspaceId'),
    exportId,
    status,
    filters: parsedFilters,
    requestFingerprint,
    snapshotAt: requireInstant(record.snapshotAt, 'snapshotAt'),
    requestedBy: {
      userKey: requireString(requestedBy.userKey, 'requestedBy.userKey'),
      displayName: requireString(requestedBy.displayName, 'requestedBy.displayName'),
    },
    createdAt,
    updatedAt: requireInstant(record.updatedAt, 'updatedAt'),
    expiresAt,
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
  // A stored key this version does not know could be a restriction that would otherwise be dropped.
  const unknownKey = Object.keys(filters).find((key) => !AUDIT_EXPORT_FILTER_KEYS.has(key))
  if (unknownKey !== undefined) throw new TypeError(`Audit export filters contain an unknown field: ${unknownKey}.`)
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
