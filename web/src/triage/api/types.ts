export type {
  AcceptCreateTriageAction,
  AcceptLinkTriageAction,
  DeclineTriageAction,
  DuplicateTriageAction,
  RequestInformationTriageAction,
  SnoozeTriageAction,
  TriageActionInput,
  TriageBulkActionInput,
  TriageBulkActionResult,
  TriageBulkItemResult,
  TriageBulkOperation,
  TriageBulkTarget,
  TriageConfiguration,
  TriageEntry,
  TriageEntryCapabilities,
  TriageEntryEvent,
  TriageEntryListInput,
  TriageEntryPage,
  TriageEntryState,
  TriageMergeReceipt,
  TriageMutationReceipt,
  TriageOwnerRotation,
  TriageOwnerStrategy,
  TriagePermission,
  TriagePermissionVisibility,
  TriageRequester,
  TriageRetention,
  TriageRouting,
  TriageRoutingCandidate,
  TriageRoutingRule,
  TriageSla,
  TriageSlaPolicy,
  TriageSourceKind,
  TriageSourcePreview,
  TriageSourceReference,
  TriageWorkItemReference,
  UpdateTriageConfigurationInput,
} from '@mukuroji/contracts'

/** SLA conditions derived by the Web presentation model. */
export type TriageSlaFilter = 'on-track' | 'due-soon' | 'breached' | 'paused'

/** URL-backed filters supported by the Team triage workbench. */
export type TriageQueueFilters = {
  /** Free-text query applied to the bounded visible projection. */
  readonly query?: string
  /** Exact lifecycle state sent to the queue API. */
  readonly state?: import('@mukuroji/contracts').TriageEntryState
  /** Exact source channel sent to the queue API. */
  readonly source?: import('@mukuroji/contracts').TriageSourceKind
  /** Ownership scope applied to the queue. */
  readonly owner?: 'all' | 'mine' | 'unowned'
  /** SLA condition applied to the visible queue projection. */
  readonly sla?: TriageSlaFilter
}

/** Queue metrics derived from the visible permission-filtered projection. */
export type TriageQueueCounts = {
  /** Number of pending visible entries. */
  readonly pending: number
  /** Number of visible entries without an owner. */
  readonly unowned: number
  /** Number of visible entries with a recorded SLA breach. */
  readonly breached: number
}
