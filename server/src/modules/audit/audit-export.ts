import { createHash, randomUUID } from 'node:crypto'
import {
  assertValidAuditQueryFilters,
  auditEventsToNdjson,
  type AuditActorKind,
  type AuditEventCountPage,
  type AuditEventCountQuery,
  type AuditEventPage,
  type AuditEventQuery,
} from './audit'

/** Events written to one NDJSON part object. */
export const AUDIT_EXPORT_EVENTS_PER_PART = 5_000

/** Query pages one processing step may evaluate before it checkpoints. */
export const AUDIT_EXPORT_PAGES_PER_STEP = 50

/**
 * Consistent base-table count pages one step may read.
 *
 * The count reads the whole Workspace audit partition with strongly consistent reads of up
 * to 1 MB per page, so steps take smaller bites to leave the partition's read capacity to
 * the API and audit writers.
 */
export const AUDIT_EXPORT_VERIFICATION_PAGES_PER_STEP = 10

/** Approximate serialized bytes one part may hold before it is closed. */
export const AUDIT_EXPORT_PART_BYTE_BUDGET = 32 * 1024 * 1024

/**
 * Seconds a job waits after its snapshot time before reading events, so events
 * committed before the snapshot have usually propagated to the eventually consistent
 * indexes. Completeness does not depend on it: the consistent count before completion does.
 */
export const AUDIT_EXPORT_SETTLE_SECONDS = 30
/**
 * Index scans one job may run before it fails as incomplete.
 *
 * A scan whose event count disagrees with the consistent base-table count is discarded
 * and started again, because the index had not yet received every event of the snapshot.
 */
export const AUDIT_EXPORT_MAX_SCAN_ATTEMPTS = 3
/**
 * Seconds without a job write after which reading the job schedules its next step again.
 *
 * Longer than the SQS maximum delay (900 seconds) plus the worker timeout (5 minutes), so
 * a healthy chain always writes first; only a job whose continuation was lost is resumed.
 */
export const AUDIT_EXPORT_STALE_SECONDS = 20 * 60
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
  /** One-based index scan attempt; a failed completeness check starts the next one. */
  readonly scanAttempt: number
  /**
   * Consistent base-table count in progress after the index scan reached the snapshot.
   * The job completes only when the final count equals `eventCount`.
   */
  readonly verification?: {
    /** Durable matching events counted on the base table so far. */
    readonly count: number
    /** Opaque count cursor where the next page starts. */
    readonly cursor?: string
  }
  /**
   * Queue message that committed the latest step. A redelivery of that message finds its
   * step already applied and only sends the continuation again.
   */
  readonly lastStepMessageId?: string
  /**
   * Set when a read resumed a stale job and its continuation may not have been sent yet.
   * Cleared once the send succeeds or the next step commits, so a failed send leaves the
   * job resumable by the very next read instead of hiding it for another stale period.
   */
  readonly continuationPending?: true
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
   * @param maxLifetimeSeconds - Longest the URL may stay valid; the adapter may use less.
   * @returns A presigned URL.
   * @throws TypeError when the part key is outside that export.
   */
  createPartDownloadUrl(
    workspaceId: string,
    exportId: string,
    part: AuditExportPart,
    maxLifetimeSeconds: number,
  ): Promise<string>
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
    // A padded ID would address another tenant prefix and be skipped as missing, not dead-lettered.
    typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.trim() !== workspaceId || workspaceId.length > 256 ||
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
 * Counts one page of matching events on the base table with strongly consistent reads.
 *
 * @param query - Filters, durability threshold, and optional cursor.
 * @returns The page count and the next cursor.
 */
export type AuditExportEventCounter = (query: AuditEventCountQuery) => Promise<AuditEventCountPage>

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
  /** Consistent counter that verifies a finished index scan before the job completes. */
  readonly countEvents: AuditExportEventCounter
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
  /** Consistent count pages per step; overridable for tests. */
  readonly verificationPagesPerStep?: number
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
  /** ISO time the request was first recorded; a retry keeps it as the snapshot time. */
  readonly requestedAt?: string
}

/** Result of one processing step. */
export type AuditExportStepResult = 'advanced' | 'completed' | 'deferred' | 'failed' | 'restarted' | 'skipped'

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
  const verificationPagesPerStep = dependencies.verificationPagesPerStep ?? AUDIT_EXPORT_VERIFICATION_PAGES_PER_STEP
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
      const requestedAt = resolveRequestTime(request.requestedAt, now())
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
        scanAttempt: 1,
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
      const stored = await readVisibleJob(workspaceId, exportId)
      await resumeIfStale(stored)
      return stored.job
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
      const jobs = (await dependencies.store.listJobs(workspaceId, 20))
        .filter((job) => job.workspaceId === workspaceId && !isExpired(job, current))
      for (const job of jobs) {
        if (!isStale(job, current)) continue
        const stored = await dependencies.store.readJob(workspaceId, job.exportId)
        if (stored && stored.job.workspaceId === workspaceId) await resumeIfStale(stored)
      }
      return jobs.map((job) => presentAuditExportJob(job, current))
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
      // A link must not outlive the job: parts are no longer served after it expires.
      const remainingSeconds = Math.floor((Date.parse(job.expiresAt) - now().getTime()) / 1000)
      if (remainingSeconds <= 0) {
        throw new AuditExportError(404, 'AuditExportNotFound', 'Audit export was not found.')
      }
      const end = fromPart + AUDIT_EXPORT_DOWNLOAD_LINKS_PER_PAGE
      const parts = await Promise.all(job.parts.slice(fromPart, end).map(async (part) => ({
        index: part.index,
        eventCount: part.eventCount,
        byteLength: part.byteLength,
        sha256: part.sha256,
        url: await dependencies.store.createPartDownloadUrl(job.workspaceId, job.exportId, part, remainingSeconds),
      })))
      return { parts, ...(end < job.parts.length ? { nextPart: end } : {}) }
    },

    /**
     * Runs the next step of an export and schedules the following one.
     *
     * A step first scans the eventually consistent index for the next part. Once the scan
     * reaches the snapshot, it counts the same events on the base table with strongly
     * consistent reads, and the job completes only when both counts agree. A disagreement
     * means the index had not yet received an event of the snapshot, so the scan restarts.
     *
     * @param workspaceId - Workspace that owns the job.
     * @param exportId - Export identifier.
     * @param messageId - Queue message that carries this step. A redelivery of the message
     * that committed the current state only sends the continuation again.
     * @returns What the step did.
     */
    async processExport(workspaceId: string, exportId: string, messageId?: string): Promise<AuditExportStepResult> {
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
      if (messageId !== undefined && job.lastStepMessageId === messageId) {
        // This delivery already committed its step, and its continuation may never have been
        // sent. Advancing again would duplicate work; sending the continuation is enough.
        await enqueueContinuation(job)
        return 'advanced'
      }
      const settleRemainingSeconds = Math.ceil(
        (Date.parse(job.snapshotAt) + settleSeconds * 1000 - current.getTime()) / 1000,
      )
      if (settleRemainingSeconds > 0) {
        // Index reads are eventually consistent; most pre-snapshot events propagate within the delay.
        await dependencies.queue.enqueue(job.workspaceId, job.exportId, Math.min(settleRemainingSeconds, 900))
        return 'deferred'
      }

      let pages = 0
      let scanned = job
      if (!job.verification) {
        const events: AuditEventPage['events'] = []
        let cursor = job.nextCursor
        let hasMore = true
        let approximateBytes = 0
        try {
          while (events.length < eventsPerPart && pages < pagesPerStep && approximateBytes < partByteBudget) {
            const page = await dependencies.readEvents({
              ...createSnapshotQuery(job),
              direction: 'ascending',
              limit: Math.min(AUDIT_EXPORT_QUERY_PAGE_SIZE, eventsPerPart - events.length),
              ...(cursor ? { cursor } : {}),
            })
            pages += 1
            // Events that TTL may delete before the deadline are outside the snapshot: the
            // consistent count could not tell a missed one from a deleted one.
            const retained = page.events.filter((event) => isRetainedThroughJob(event, job))
            events.push(...retained)
            for (const event of retained) approximateBytes += JSON.stringify(event).length
            cursor = page.nextCursor
            if (!cursor) {
              hasMore = false
              break
            }
          }
        } catch (error) {
          return await failInvalidQuery(job, version, error, messageId)
        }

        if (job.eventCount + events.length > maxEvents) {
          return await finish(job, version, failJob(
            job,
            now(),
            'AuditExportTooLarge',
            `Audit export exceeds ${maxEvents} events. Narrow the filters or period.`,
          ), messageId)
        }

        if (events.length > 0 && job.parts.length >= maxParts) {
          return await finish(job, version, failJob(
            job,
            now(),
            'AuditExportTooManyParts',
            `Audit export exceeds ${maxParts} parts. Narrow the filters or period.`,
          ), messageId)
        }

        const parts = [...job.parts]
        // Reading can take most of the Lambda timeout; never start a write past the deadline.
        if (isPastProcessingDeadline(job, now()) || isExpired(job, now())) return 'skipped'
        if (events.length > 0) {
          const index = parts.length + 1
          const part = await dependencies.store.putPart(
            job.workspaceId,
            job.exportId,
            index,
            await auditEventsToNdjson(events),
          )
          parts.push({ index, eventCount: events.length, ...part })
        }
        const { nextCursor: _previousCursor, ...withoutCursor } = job
        void _previousCursor
        scanned = {
          ...withoutCursor,
          status: 'running',
          parts,
          eventCount: job.eventCount + events.length,
          updatedAt: now().toISOString(),
          ...(hasMore && cursor ? { nextCursor: cursor } : { verification: { count: 0 } }),
        }
        if (scanned.nextCursor !== undefined) return await finish(job, version, scanned, messageId)
      }

      // The index scan reached the snapshot; count the same events on the base table.
      let verification = scanned.verification ?? { count: 0 }
      let verified = false
      let countPages = 0
      try {
        while (pages < pagesPerStep && countPages < verificationPagesPerStep) {
          const page = await dependencies.countEvents({
            ...createSnapshotQuery(job),
            durableAfter: durabilityThreshold(job),
            ...(verification.cursor ? { cursor: verification.cursor } : {}),
          })
          pages += 1
          countPages += 1
          verification = {
            count: verification.count + page.count,
            ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
          }
          if (!page.nextCursor) {
            verified = true
            break
          }
        }
      } catch (error) {
        return await failInvalidQuery(job, version, error, messageId)
      }
      const updatedAt = now().toISOString()
      if (!verified) {
        return await finish(job, version, { ...scanned, verification, updatedAt }, messageId)
      }
      const { verification: _verification, ...withoutVerification } = scanned
      void _verification
      if (verification.count === scanned.eventCount) {
        return await finish(job, version, { ...withoutVerification, status: 'completed', updatedAt }, messageId)
      }
      if (scanned.scanAttempt >= AUDIT_EXPORT_MAX_SCAN_ATTEMPTS) {
        return await finish(job, version, failJob(
          scanned,
          now(),
          'AuditExportIncomplete',
          'Audit events of the snapshot were still arriving. Request the export again.',
        ), messageId)
      }
      // The index missed events the base table already holds; discard the scan and start again.
      return await finish(job, version, {
        ...withoutVerification,
        status: 'queued',
        parts: [],
        eventCount: 0,
        scanAttempt: scanned.scanAttempt + 1,
        updatedAt,
      }, messageId)
    },
  }

  /**
   * Ends a step whose read failed: only filters the query layer rejects are terminal.
   *
   * Other errors, such as a malformed persisted audit row or a throttled read, propagate
   * so the message retries and finally reaches the DLQ.
   *
   * @param job - Job state read at the start of the step.
   * @param version - Version read at the start of the step.
   * @param error - Error raised by the read.
   * @param messageId - Queue message that carries this step.
   * @returns The failed step result.
   */
  async function failInvalidQuery(
    job: AuditExportJob,
    version: string,
    error: unknown,
    messageId: string | undefined,
  ): Promise<AuditExportStepResult> {
    if ((error instanceof TypeError || error instanceof RangeError) && !areQueryFiltersValid(job)) {
      return await finish(job, version, failJob(job, now(), 'AuditExportQueryInvalid', 'Audit export filters could not be evaluated.'), messageId)
    }
    throw error
  }

  /**
   * Schedules the step that continues an unfinished job.
   *
   * @param job - Job to continue; a restarted (queued) scan waits for the settle delay again.
   */
  async function enqueueContinuation(job: AuditExportJob): Promise<void> {
    if (job.status === 'queued') {
      await dependencies.queue.enqueue(job.workspaceId, job.exportId, settleSeconds)
      return
    }
    await dependencies.queue.enqueue(job.workspaceId, job.exportId)
  }

  /**
   * Schedules an unfinished job again when no step has written it for a long time.
   *
   * A continuation can be lost when its send keeps failing until the delivering message
   * reaches the DLQ. The job is first claimed with a conditional write that also records
   * `continuationPending`, so concurrent reads resume it once instead of starting several
   * chains. The marker is cleared only after the send succeeds; if the send fails, the
   * marker keeps the job stale and the next read sends it again.
   *
   * @param stored - Job read with its version.
   */
  async function resumeIfStale(stored: StoredAuditExportJob): Promise<void> {
    const { job, version } = stored
    const current = now()
    if (!isStale(job, current) || isExpired(job, current) || isPastProcessingDeadline(job, current)) return
    if (dependencies.isTenantActive && !await dependencies.isTenantActive(job.workspaceId)) return
    const claimed: AuditExportJob = { ...job, updatedAt: current.toISOString(), continuationPending: true }
    if (!await dependencies.store.replaceJob(claimed, version)) return
    await enqueueContinuation(claimed)
    // The send succeeded. Clear the marker unless a step or another read already rewrote the job;
    // a later step also drops it, so losing this race is harmless.
    const sent = await dependencies.store.readJob(job.workspaceId, job.exportId)
    if (!sent || !sent.job.continuationPending || sent.job.updatedAt !== claimed.updatedAt) return
    const { continuationPending: _pending, ...cleared } = sent.job
    void _pending
    await dependencies.store.replaceJob(cleared, sent.version)
  }

  /**
   * Applies the next job state and schedules another step when work remains.
   *
   * @param current - Job state read at the start of the step.
   * @param version - Version read at the start of the step.
   * @param next - Next job state.
   * @param messageId - Queue message that carries this step, recorded with the new state.
   * @returns What the step did.
   */
  async function finish(
    current: AuditExportJob,
    version: string,
    next: AuditExportJob,
    messageId: string | undefined,
  ): Promise<AuditExportStepResult> {
    // Rewriting job.json restarts its lifecycle clock, so nothing is written past the deadline.
    const writeTime = now()
    if (isPastProcessingDeadline(current, writeTime) || isExpired(current, writeTime)) return 'skipped'
    // A committed step proves the chain is alive, so a pending resume marker is dropped too.
    const { lastStepMessageId: _previousMessage, continuationPending: _pending, ...withoutMessage } = next
    void _previousMessage
    void _pending
    const recorded: AuditExportJob = {
      ...withoutMessage,
      ...(messageId !== undefined && (next.status === 'running' || next.status === 'queued')
        ? { lastStepMessageId: messageId }
        : {}),
    }
    if (!await dependencies.store.replaceJob(recorded, version)) return 'skipped'
    if (recorded.status === 'running' || recorded.status === 'queued') {
      await enqueueContinuation(recorded)
      return recorded.status === 'running' ? 'advanced' : 'restarted'
    }
    return recorded.status === 'completed' ? 'completed' : 'failed'
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
 * Chooses the snapshot time of a request.
 *
 * @param recordedAt - When the request was first recorded, if known.
 * @param current - Current time.
 * @returns The recorded time when it is a valid past instant, otherwise the current time.
 */
function resolveRequestTime(recordedAt: string | undefined, current: Date): Date {
  const recorded = recordedAt === undefined ? Number.NaN : Date.parse(recordedAt)
  return Number.isFinite(recorded) && recorded <= current.getTime() ? new Date(recorded) : current
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
  // Like the synchronous audit query, a type may be filtered alone, but an ID needs its type.
  if (filters.entityId !== undefined && filters.entityType === undefined) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'entityId requires entityType.')
  }
  if (filters.targetId !== undefined && filters.targetType === undefined) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'targetId requires targetType.')
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
 * Builds the filters every read of a job applies, capped at its snapshot time.
 *
 * The index scan and the consistent count use the same predicate, so their totals agree
 * exactly when the scan saw every event of the snapshot.
 *
 * @param job - Stored job.
 * @returns Workspace, filters, and upper bound.
 */
function createSnapshotQuery(job: AuditExportJob) {
  return { workspaceId: job.workspaceId, ...job.filters, to: capAtSnapshot(job.filters.to, job.snapshotAt) }
}

/**
 * Computes the TTL threshold of events an export contains.
 *
 * DynamoDB TTL never deletes an item before its `expiresAt`, and the job writes nothing
 * after its processing deadline, so an event expiring later stays readable for the whole
 * job and the consistent count can prove the scan saw it. An event that may expire
 * mid-job could be missed by the scan and deleted before the count, leaving both totals
 * equal, so such events are excluded from the export and from the count alike.
 *
 * @param job - Stored job.
 * @returns Epoch seconds of the processing deadline.
 */
function durabilityThreshold(job: AuditExportJob): number {
  return Math.ceil((Date.parse(job.createdAt) + AUDIT_EXPORT_PROCESSING_HOURS * 3_600_000) / 1000)
}

/**
 * Checks whether an event is retained for the whole job and therefore belongs to its snapshot.
 *
 * @param event - Event read from the index.
 * @param job - Stored job.
 * @returns Whether the event has no TTL or expires after the processing deadline.
 */
function isRetainedThroughJob(event: { readonly expiresAt?: number }, job: AuditExportJob): boolean {
  return event.expiresAt === undefined || event.expiresAt > durabilityThreshold(job)
}

/**
 * Checks whether an unfinished job has gone without a write for longer than any healthy step takes.
 *
 * @param job - Stored job.
 * @param current - Current time.
 * @returns Whether the job's continuation may have been lost.
 */
function isStale(job: AuditExportJob, current: Date): boolean {
  return (job.status === 'queued' || job.status === 'running') &&
    (job.continuationPending === true ||
      Date.parse(job.updatedAt) + AUDIT_EXPORT_STALE_SECONDS * 1000 <= current.getTime())
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
    assertValidAuditQueryFilters(createSnapshotQuery(job))
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
  const {
    nextCursor: _cursor,
    verification: _verification,
    lastStepMessageId: _message,
    continuationPending: _pending,
    ...rest
  } = job
  void _pending
  void _cursor
  void _verification
  void _message
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
  // Only failJob writes a failure, together with the failed status, so any other pairing is corrupt.
  if ((status === 'failed') !== (failure !== undefined)) {
    throw new TypeError('Audit export job status does not match its failure.')
  }
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
  const snapshotAt = requireInstant(record.snapshotAt, 'snapshotAt')
  // Every writer takes the snapshot when it records the request; a later snapshot would export
  // events created after the request, and a far-future one would defer the job until it expires.
  if (snapshotAt !== createdAt) {
    throw new TypeError('Audit export job snapshot does not match its creation time.')
  }
  const eventCount = requireCount(record.eventCount, 'eventCount')
  const parsedParts = parts.map((entry: unknown, position: number) => {
    const part = requireObject(entry, 'Audit export part')
    const index = requireCount(part.index, 'part.index')
    // Parts are written in order from 1, so a gap, duplicate, or reordering means another writer.
    if (index !== position + 1) throw new TypeError('Audit export parts must be numbered from 1 in order.')
    const sha256 = requireString(part.sha256, 'part.sha256')
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError('Audit export part checksum must be a SHA-256 hex digest.')
    return {
      index,
      key: requireString(part.key, 'part.key'),
      eventCount: requireCount(part.eventCount, 'part.eventCount'),
      byteLength: requireCount(part.byteLength, 'part.byteLength'),
      sha256,
    }
  })
  // Only a running job continues, either from a scan cursor or from a verification count,
  // and never both; any other combination would restart the query, skip the completeness
  // check, or resume a finished job, so it is corrupt.
  const nextCursor = record.nextCursor === undefined ? undefined : requireString(record.nextCursor, 'nextCursor')
  if (nextCursor === '') throw new TypeError('Audit export job status does not match its cursor.')
  const verification = record.verification === undefined
    ? undefined
    : parseVerification(requireObject(record.verification, 'Audit export verification'))
  if ((status === 'running') !== ((nextCursor !== undefined) !== (verification !== undefined))) {
    throw new TypeError('Audit export job status does not match its cursor.')
  }
  if (status !== 'running' && (nextCursor !== undefined || verification !== undefined)) {
    throw new TypeError('Audit export job status does not match its cursor.')
  }
  const scanAttempt = requireCount(record.scanAttempt, 'scanAttempt')
  if (scanAttempt < 1) throw new TypeError('Audit export scanAttempt must be at least 1.')
  const lastStepMessageId = record.lastStepMessageId === undefined
    ? undefined
    : requireString(record.lastStepMessageId, 'lastStepMessageId')
  if (record.continuationPending !== undefined && record.continuationPending !== true) {
    throw new TypeError('Audit export continuationPending must be true when present.')
  }
  const continuationPending = record.continuationPending === true
  // Only an unfinished job can wait for its continuation.
  if (continuationPending && status !== 'queued' && status !== 'running') {
    throw new TypeError('Audit export job status does not match its pending continuation.')
  }
  // A queued job has not read anything yet; stored progress would be appended to a fresh scan.
  if (status === 'queued' && (parts.length > 0 || record.eventCount !== 0)) {
    throw new TypeError('Queued audit export job already has progress.')
  }
  // The event limit is enforced from the job total, so it must account for every part.
  if (parsedParts.reduce((total, part) => total + part.eventCount, 0) !== eventCount) {
    throw new TypeError('Audit export job event count does not match its parts.')
  }
  return {
    schemaVersion: 1,
    workspaceId: requireString(record.workspaceId, 'workspaceId'),
    exportId,
    status,
    filters: parsedFilters,
    requestFingerprint,
    snapshotAt,
    requestedBy: {
      userKey: requireString(requestedBy.userKey, 'requestedBy.userKey'),
      displayName: requireString(requestedBy.displayName, 'requestedBy.displayName'),
    },
    createdAt,
    updatedAt: requireInstant(record.updatedAt, 'updatedAt'),
    expiresAt,
    eventCount,
    parts: parsedParts,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    scanAttempt,
    ...(verification === undefined ? {} : { verification }),
    ...(lastStepMessageId === undefined ? {} : { lastStepMessageId }),
    ...(continuationPending ? { continuationPending: true } : {}),
    ...(failure
      ? { failure: { code: requireString(failure.code, 'failure.code'), message: requireString(failure.message, 'failure.message') } }
      : {}),
  }
}

/**
 * Validates a stored completeness count in progress.
 *
 * @param record - Stored verification object.
 * @returns The validated verification state.
 */
function parseVerification(record: Record<string, unknown>): NonNullable<AuditExportJob['verification']> {
  const count = requireCount(record.count, 'verification.count')
  if (record.cursor === undefined) return { count }
  const cursor = requireString(record.cursor, 'verification.cursor')
  if (!cursor) throw new TypeError('Audit export verification has an empty cursor.')
  return { count, cursor }
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
  /**
   * Reads one optional filter value, rejecting empty or non-string values.
   * Empty stored values would be dropped by the query and widen the export, so they are corrupt.
   * @param key Filter field name to read.
   * @returns A partial filter object holding the value, or an empty object when the field is absent.
   */
  const optional = (key: string) => {
    const value = filters[key]
    if (value === undefined) return {}
    const text = requireString(value, `filters.${key}`)
    if (text.trim() === '') throw new TypeError(`Audit export filters.${key} must not be empty.`)
    return { [key]: text }
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
  if (eventTypes !== undefined && (eventTypes.length === 0 || eventTypes.some((entry) => typeof entry === 'string' && entry.trim() === ''))) {
    throw new TypeError('Audit export eventTypes must not be empty.')
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
