/** Time tracking contract schema version. */
export const TIME_TRACKING_SCHEMA_VERSION = 1 as const

/** Lifecycle state of a time entry. */
export type TimeEntryStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'locked'

/** Origin of a time entry. */
export type TimeEntrySource = 'manual' | 'timer'

/** Grouping dimension supported by a time tracking report. */
export type TimeTrackingGroupBy = 'day' | 'week' | 'user' | 'project' | 'work-item'

/** A recorded interval of work. */
export type TimeEntry = {
  /** Contract schema version. */
  schemaVersion: typeof TIME_TRACKING_SCHEMA_VERSION
  /** Stable time entry identifier. */
  id: string
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Optional Project associated with the work. */
  projectId?: string
  /** Canonical Work Item associated with the work. */
  workItemId: string
  /** Workspace member who recorded the time. */
  userId: string
  /** Inclusive interval start as an ISO 8601 instant. */
  startAt: string
  /** Exclusive interval end as an ISO 8601 instant. */
  endAt: string
  /** Rounded duration in minutes used for reporting. */
  durationMinutes: number
  /** Optional explanation supplied by the member. */
  description?: string
  /** Whether the interval is chargeable. */
  billable: boolean
  /** ISO 4217 currency code for confidential money fields. */
  currency: string
  /** Approval lifecycle state. */
  status: TimeEntryStatus
  /** How the interval was recorded. */
  source: TimeEntrySource
  /** Optimistic concurrency revision. */
  revision: number
  /** Confidential hourly rate in minor currency units. */
  hourlyRateMinor?: number
  /** Confidential calculated cost in minor currency units. */
  actualCostMinor?: number
  /** Creation timestamp. */
  createdAt: string
  /** Last update timestamp. */
  updatedAt: string
  /** Submission timestamp. */
  submittedAt?: string
  /** Approval timestamp. */
  approvedAt?: string
  /** Rejection timestamp. */
  rejectedAt?: string
  /** Lock timestamp after approval. */
  lockedAt?: string
}

/** A durable running timer that has not yet produced a time entry. */
export type RunningTimer = {
  /** Contract schema version. */
  schemaVersion: typeof TIME_TRACKING_SCHEMA_VERSION
  /** Stable timer identifier. */
  id: string
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Optional Project associated with the timer. */
  projectId?: string
  /** Canonical Work Item associated with the timer. */
  workItemId: string
  /** Workspace member who owns the timer. */
  userId: string
  /** Timer start as an ISO 8601 instant. */
  startedAt: string
  /** Optional explanation to copy to the created entry. */
  description?: string
  /** Whether the resulting interval is chargeable. */
  billable: boolean
  /** Optimistic concurrency revision. */
  revision: number
  /** Last durable update timestamp. */
  updatedAt: string
}

/** Immutable history record for a time entry lifecycle change. */
export type TimeEntryHistory = {
  /** Stable history identifier. */
  id: string
  /** Time entry identifier. */
  entryId: string
  /** Lifecycle operation that created the record. */
  action: 'created' | 'updated' | 'submitted' | 'approved' | 'rejected' | 'locked'
  /** Previous lifecycle state when applicable. */
  fromStatus?: TimeEntryStatus
  /** New lifecycle state when applicable. */
  toStatus?: TimeEntryStatus
  /** Actor who performed the operation. */
  actorUserId: string
  /** Optional rejection or edit explanation. */
  reason?: string
  /** History creation timestamp. */
  occurredAt: string
}

/** An estimate attached to a canonical Work Item. */
export type TimeEstimate = {
  /** Contract schema version. */
  schemaVersion: typeof TIME_TRACKING_SCHEMA_VERSION
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Planned effort in minutes. */
  estimateMinutes: number
  /** Member who last changed the estimate. */
  updatedBy: string
  /** Last update timestamp. */
  updatedAt: string
}

/** A budget for a Team or Project and optional local-date period. */
export type TimeBudget = {
  /** Contract schema version. */
  schemaVersion: typeof TIME_TRACKING_SCHEMA_VERSION
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Budget scope. */
  scopeType: 'team' | 'project'
  /** Team or Project identifier selected by scopeType. */
  scopeId: string
  /** Budget amount in minor currency units. */
  amountMinor: number
  /** ISO 4217 currency code. */
  currency: string
  /** Inclusive local period start. */
  periodFrom?: string
  /** Inclusive local period end. */
  periodTo?: string
  /** Optimistic concurrency revision. */
  revision: number
  /** Last update timestamp. */
  updatedAt: string
}

/** A single grouped time tracking report row. */
export type TimeSummaryGroup = {
  /** Stable group key. */
  key: string
  /** Human-readable group label. */
  label: string
  /** Total duration in minutes. */
  minutes: number
  /** Billable duration in minutes. */
  billableMinutes: number
  /** Number of entries contributing to the group. */
  entryCount: number
  /** Estimate in minutes when the group is a Work Item or Project report. */
  estimateMinutes?: number
  /** Confidential actual cost in minor currency units. */
  actualCostMinor?: number
}

/** Aggregated time tracking report. */
export type TimeTrackingSummary = {
  /** Inclusive period start as an ISO 8601 instant. */
  from: string
  /** Exclusive period end as an ISO 8601 instant. */
  to: string
  /** IANA timezone used for calendar grouping. */
  timeZone: string
  /** Grouping dimension used by the report. */
  groupBy: TimeTrackingGroupBy
  /** Grouped report rows. */
  groups: TimeSummaryGroup[]
  /** Total duration in minutes. */
  totalMinutes: number
  /** Total billable duration in minutes. */
  totalBillableMinutes: number
  /** Total estimate in minutes visible to the caller. */
  totalEstimateMinutes: number
  /** Confidential total actual cost in minor currency units. */
  totalActualCostMinor?: number
  /** Budget for the requested scope, when configured and authorized. */
  budget?: TimeBudget
  /** Whether money fields were withheld from this response. */
  costsRedacted: boolean
}

/** Daily and weekly timesheet view. */
export type TimeSheet = {
  /** Inclusive local period start. */
  from: string
  /** Inclusive local period end. */
  to: string
  /** IANA timezone used to split intervals. */
  timeZone: string
  /** Daily rows in local-date order. */
  days: TimeSummaryGroup[]
  /** Weekly rows in local-week order. */
  weeks: TimeSummaryGroup[]
  /** Whether money fields were withheld from this response. */
  costsRedacted: boolean
}
