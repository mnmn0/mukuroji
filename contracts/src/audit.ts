/**
 * Kind of principal that performed an audited mutation.
 */
export type AuditActorKind = 'user' | 'system' | 'service' | 'break-glass'

/**
 * Actor kinds accepted by audit filters, in display order.
 */
export const AUDIT_ACTOR_KINDS: readonly AuditActorKind[] = ['user', 'service', 'system', 'break-glass']

/**
 * JSON value stored in the before or after side of an audit field change.
 */
export type AuditValue = null | boolean | number | string | AuditValue[] | { [key: string]: AuditValue }

/**
 * Principal snapshot of an audit event.
 */
export type AuditEventActorView = {
  /** Stable principal ID, such as the Cognito subject, used by the actor filter. */
  id: string
  /** Kind of principal. */
  kind: AuditActorKind
  /** Display name recorded when the event happened. */
  displayName?: string
}

/**
 * Resource an audit event belongs to or directly changed.
 */
export type AuditEventResourceView = {
  /** Resource type such as `work-item` or `member`. */
  type: string
  /** Resource ID within the Workspace. */
  id: string
}

/**
 * Before and after values of one field changed by an audited mutation.
 */
export type AuditFieldChangeView = {
  /** Dot-separated field path from the resource root. */
  field: string
  /** Value before the mutation; absent when the field was created. */
  before?: AuditValue
  /** Value after the mutation; absent when the field was removed. */
  after?: AuditValue
  /** Whether the values were replaced because they are sensitive. */
  redacted?: boolean
}

/**
 * Origin of an audited mutation.
 */
export type AuditEventSourceView = {
  /** Path that produced the mutation. */
  kind: 'api' | 'backfill' | 'migration' | 'system'
  /** API gateway or application request ID. */
  requestId?: string
  /** HTTP method that accepted the mutation. */
  method?: string
  /** Route that accepted the mutation. */
  route?: string
  /** Client IP address of the request. */
  ipAddress?: string
  /** User agent of the request. */
  userAgent?: string
}

/**
 * Public view of one audit event returned by `GET /api/audit/events`.
 */
export type AuditEventView = {
  /** Public event ID. */
  eventId: string
  /** Past-tense domain event name such as `work-item.updated`. */
  eventType: string
  /** ISO 8601 time the mutation was committed. */
  occurredAt: string
  /** Principal that performed the mutation. */
  actor: AuditEventActorView
  /** Resource whose activity groups the event. */
  entity: AuditEventResourceView
  /** Resource the mutation directly changed. */
  target: AuditEventResourceView
  /** Field-level before and after values. */
  changes: AuditFieldChangeView[]
  /** Short action identifier such as `created`. */
  action: string
  /** ID shared by the events of one request. */
  correlationId: string
  /** Origin of the mutation. */
  source: AuditEventSourceView
  /** Short description or reason recorded with the event. */
  summary?: string
  /** Allowlisted diagnostic metadata. */
  metadata?: { [key: string]: AuditValue }
}

/**
 * One page of audit events, newest first unless ascending order was requested.
 */
export type AuditEventPageView = {
  /** Events on this page. */
  events: AuditEventView[]
  /** Opaque cursor of the next page, absent on the last page. */
  nextCursor?: string
}

/**
 * Filters of an audit search or asynchronous export.
 */
export type AuditEventFilters = {
  /** Actor ID to match. */
  actorId?: string
  /** Actor kind to match; asynchronous exports only. */
  actorKind?: AuditActorKind
  /** Direct mutation target type; may be given alone. */
  targetType?: string
  /** Direct mutation target ID; requires `targetType`. */
  targetId?: string
  /** Event types to include, at most `AUDIT_EVENT_TYPE_FILTER_LIMIT`. */
  eventTypes?: string[]
  /** Inclusive lower bound as an ISO 8601 time. */
  from?: string
  /** Inclusive upper bound as an ISO 8601 time. */
  to?: string
}

/**
 * Largest number of event types one audit query accepts.
 */
export const AUDIT_EVENT_TYPE_FILTER_LIMIT = 20

/**
 * State of an asynchronous audit export.
 */
export type AuditExportStatus = 'queued' | 'running' | 'completed' | 'failed'

/**
 * Public view of an asynchronous audit export job.
 */
export type AuditExportView = {
  /** Export ID. */
  exportId: string
  /** Current state. */
  status: AuditExportStatus
  /** Filters the export was requested with. */
  filters: AuditEventFilters
  /** Upper time bound fixed when the export was requested. */
  snapshotAt: string
  /** Member who requested the export. */
  requestedBy: {
    /** Display name of the requester. */
    displayName: string
  }
  /** ISO 8601 time the job was created. */
  createdAt: string
  /** ISO 8601 time the job last changed. */
  updatedAt: string
  /** ISO 8601 time the export and its files are removed. */
  expiresAt: string
  /** Events written so far. */
  eventCount: number
  /** NDJSON parts written so far. */
  partCount: number
  /** Failure reported by a failed job. */
  failure?: {
    /** Stable error code. */
    code: string
    /** Safe human-readable message. */
    message: string
  }
}

/**
 * Signed download link of one NDJSON part of a completed export.
 */
export type AuditExportDownloadPartView = {
  /** One-based part number in event order. */
  index: number
  /** Events in the part. */
  eventCount: number
  /** Size of the part in bytes. */
  byteLength: number
  /** Hex SHA-256 digest of the part. */
  sha256: string
  /** Short-lived signed URL of the part. */
  url: string
}

/**
 * One page of download links returned by `GET /api/audit/exports/:exportId/download`.
 */
export type AuditExportDownloadView = {
  /** Export the links belong to. */
  export: AuditExportView
  /** Links of this page. */
  parts: AuditExportDownloadPartView[]
  /** `fromPart` of the next page, absent on the last page. */
  nextPart?: number
}
