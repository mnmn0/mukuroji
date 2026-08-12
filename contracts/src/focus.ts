import type { CanonicalWorkItem } from './work-items'

/** Current schema version of the Focus queue contract. */
export const FOCUS_SCHEMA_VERSION = 1

/** Schema version carried by every versioned Focus resource. */
export type FocusSchemaVersion = typeof FOCUS_SCHEMA_VERSION

/** Attention signals supported by the first Focus queue schema. */
export type FocusSignalType =
  | 'blocker'
  | 'urgent'
  | 'overdue'
  | 'due-soon'
  | 'approval'
  | 'review-request'
  | 'mention'
  | 'sla'
  | 'cycle'

/** Canonical source kinds from which a Focus signal can be projected. */
export type FocusSignalSourceKind =
  | 'work-item'
  | 'work-item-relation'
  | 'planning-dependency'
  | 'approval'
  | 'review-request'
  | 'comment-mention'
  | 'notification'
  | 'service-level-policy'
  | 'planning-cycle'

/** Durable source evidence that produced a Focus signal. */
export type FocusSignalSource = {
  /** Kind of canonical source that produced the signal. */
  kind: FocusSignalSourceKind
  /** Stable identifier of the source record or relationship. */
  id: string
  /** Audit or notification event identifier shared with the Inbox when available. */
  eventId?: string
  /** ISO 8601 timestamp when the source event occurred. */
  occurredAt: string
  /** Authorized application-relative link used by the open-source action. */
  deepLink?: string
}

/** Evidence showing when a Focus signal was last checked against its source. */
export type FocusSignalFreshness = {
  /** ISO 8601 timestamp of the latest source evaluation. */
  evaluatedAt: string
  /** ISO 8601 timestamp after which the signal must be evaluated again. */
  validUntil?: string
  /** Monotonic source revision observed during the evaluation when one exists. */
  sourceVersion?: number
}

/** Machine-readable condition that removes an active Focus signal. */
export type FocusSignalResolutionCondition =
  | 'work-item-completed'
  | 'priority-lowered'
  | 'deadline-changed'
  | 'dependency-removed'
  | 'blocker-completed'
  | 'approval-decided'
  | 'review-completed'
  | 'mention-acknowledged'
  | 'sla-restored'
  | 'cycle-changed'
  | 'source-removed'

/** Current resolution state and condition of a Focus signal. */
export type FocusSignalResolution = {
  /** Condition whose satisfaction resolves the signal. */
  condition: FocusSignalResolutionCondition
  /** Whether the condition is still open or has been satisfied. */
  status: 'open' | 'resolved'
  /** ISO 8601 timestamp when the signal was resolved. */
  resolvedAt?: string
}

/** Permission-safe actions exposed for one Focus signal source. */
export type FocusSignalPermission = {
  /** Whether the caller may open the canonical source from the current snapshot. */
  canOpenSource: boolean
}

/** One deduplicated reason that a Work Item requires attention. */
export type FocusSignal = {
  /** Stable cause identifier used to deduplicate repeated source events. */
  id: string
  /** Attention category represented by this signal. */
  type: FocusSignalType
  /** Canonical record and event that produced this signal. */
  source: FocusSignalSource
  /** Latest evidence that the signal still reflects its source. */
  freshness: FocusSignalFreshness
  /** Current permission projection for the canonical source. */
  permission: FocusSignalPermission
  /** Condition and state used to remove or retain the signal. */
  resolution: FocusSignalResolution
}

/** Sections exposed by the Focus queue in their stable display order. */
export type FocusQueueSection = 'now' | 'next' | 'waiting' | 'snoozed' | 'done'

/** One auditable contribution to the deterministic Focus rank. */
export type FocusRankComponent = {
  /** Signal whose policy weight produced this contribution. */
  signalId: string
  /** Signal category used to select the effective weight. */
  signalType: FocusSignalType
  /** Effective policy weight applied to the signal. */
  weight: number
  /** Normalized signal value multiplied by the weight. */
  value: number
  /** Exact contribution added to the total score. */
  contribution: number
}

/** Transparent deterministic rank assigned to a Focus item. */
export type FocusRankBreakdown = {
  /** Sum of all component contributions. */
  score: number
  /** Stable component order used to explain the score. */
  components: FocusRankComponent[]
  /** Opaque deterministic value used when two items have the same score. */
  tieBreaker: string
}

/** Server-authorized actions available for one Focus item. */
export type FocusItemCapabilities = {
  /** Whether the caller can complete the Work Item. */
  complete: boolean
  /** Whether the caller can change the assignee. */
  assign: boolean
  /** Whether the caller can change the workflow status. */
  changeStatus: boolean
  /** Whether the caller can change the canonical schedule. */
  schedule: boolean
  /** Whether the caller can snooze or unsnooze the Focus item. */
  snooze: boolean
  /** Whether the caller can subscribe to or unsubscribe from the Work Item. */
  watch: boolean
  /** Whether at least one signal source can be opened. */
  openSource: boolean
}

/** Reason that a Focus item cannot currently offer a primary work action. */
export type FocusActionabilityReason =
  | 'blocked'
  | 'awaiting-external-action'
  | 'no-permitted-primary-action'
  | 'work-item-completed'

/** Current actionability of a Focus item after permission and source evaluation. */
export type FocusActionability = {
  /** Whether the caller can make progress through a primary Work Item action. */
  actionable: boolean
  /** Stable reasons explaining a non-actionable or waiting item. */
  reasons: FocusActionabilityReason[]
}

/** Effective rank weight for every supported Focus signal category. */
export type FocusSignalWeights = {
  /** Weight assigned to unresolved blocker signals. */
  blocker: number
  /** Weight assigned to urgent priority signals. */
  urgent: number
  /** Weight assigned to overdue deadline signals. */
  overdue: number
  /** Weight assigned to upcoming deadline signals. */
  dueSoon: number
  /** Weight assigned to pending approval signals. */
  approval: number
  /** Weight assigned to review request signals. */
  reviewRequest: number
  /** Weight assigned to mention signals. */
  mention: number
  /** Weight assigned to service-level signals. */
  sla: number
  /** Weight assigned to cycle signals. */
  cycle: number
}

/** Optional signal weights replaced by one Team or user policy layer. */
export type FocusSignalWeightOverrides = {
  /** Optional blocker weight override. */
  blocker?: number
  /** Optional urgent weight override. */
  urgent?: number
  /** Optional overdue weight override. */
  overdue?: number
  /** Optional due-soon weight override. */
  dueSoon?: number
  /** Optional approval weight override. */
  approval?: number
  /** Optional review-request weight override. */
  reviewRequest?: number
  /** Optional mention weight override. */
  mention?: number
  /** Optional service-level weight override. */
  sla?: number
  /** Optional cycle weight override. */
  cycle?: number
}

/** Fully resolved settings used to rank and section Focus items. */
export type FocusPolicySettings = {
  /** Effective weight for every signal category. */
  weights: FocusSignalWeights
  /** Number of local calendar days before a deadline becomes due soon. */
  dueSoonDays: number
  /** Number of local calendar days before a cycle boundary becomes due soon. */
  cycleDueSoonDays: number
  /** Number of elapsed hours before an unfinished owned Work Item breaches its active SLA. */
  slaHours: number
  /** Inclusive score threshold that places an actionable item in Now. */
  nowScoreThreshold: number
}

/** Settings supplied by one policy layer while unspecified values inherit. */
export type FocusPolicyOverrides = {
  /** Signal-specific weight replacements. */
  weights?: FocusSignalWeightOverrides
  /** Optional due-soon window replacement in local calendar days. */
  dueSoonDays?: number
  /** Optional cycle due-soon window replacement in local calendar days. */
  cycleDueSoonDays?: number
  /** Optional unfinished Work Item SLA window replacement in elapsed hours. */
  slaHours?: number
  /** Optional Now-section score threshold replacement. */
  nowScoreThreshold?: number
}

/** Policy target that receives a user or Team-specific override. */
export type FocusPolicyTarget =
  | {
      /** Identifies the current user's personal policy. */
      type: 'user'
    }
  | {
      /** Identifies a Team policy. */
      type: 'team'
      /** Team whose members inherit the policy. */
      teamId: string
    }

/** Versioned policy override stored for a user or Team. */
export type FocusPolicy = {
  /** Contract schema version. */
  schemaVersion: FocusSchemaVersion
  /** Stable policy identifier. */
  id: string
  /** User or Team scope changed by this policy. */
  target: FocusPolicyTarget
  /** Optimistic concurrency version of this stored policy. */
  version: number
  /** Complete replacement set of inherited overrides. */
  overrides: FocusPolicyOverrides
  /** ISO 8601 timestamp of the latest policy update. */
  updatedAt: string
}

/** Ordered policy layer that contributed to an effective policy. */
export type FocusPolicyProvenance =
  | {
      /** Identifies the product default layer. */
      source: 'default'
      /** Version of the product defaults. */
      version: number
    }
  | {
      /** Identifies a Team override layer. */
      source: 'team'
      /** Stable identifier of the Team policy. */
      policyId: string
      /** Team whose policy contributed to the result. */
      teamId: string
      /** Version of the contributing Team policy. */
      version: number
    }
  | {
      /** Identifies the current user's override layer. */
      source: 'user'
      /** Stable identifier of the user policy. */
      policyId: string
      /** Version of the contributing user policy. */
      version: number
    }

/** Resolved policy and provenance used by returned Focus items. */
export type FocusEffectivePolicy = {
  /** Stable identifier referenced by each ranked item. */
  id: string
  /** Opaque fingerprint that changes when any contributing layer changes. */
  fingerprint: string
  /** Team whose policy layer was resolved when applicable. */
  teamId?: string
  /** Product defaults inherited by the Team policy editor. */
  baseSettings: FocusPolicySettings
  /** Settings after the Team layer and before personal overrides. */
  teamSettings: FocusPolicySettings
  /** Fully resolved ranking and section settings. */
  settings: FocusPolicySettings
  /** Layers applied from the lowest to the highest precedence. */
  provenance: FocusPolicyProvenance[]
}

/** One recipient-specific aggregate in the Focus queue. */
export type FocusItem = {
  /** Contract schema version. */
  schemaVersion: FocusSchemaVersion
  /** Stable recipient-specific Focus item identifier. */
  id: string
  /** Optimistic concurrency version of the Focus aggregate. */
  version: number
  /** Current durable snooze revision used by the server for recipient-state concurrency. */
  snoozeRevision: number
  /** Current queue section selected after ranking and lifecycle rules. */
  section: FocusQueueSection
  /** Canonical Work Item snapshot authorized for the caller. */
  workItem: CanonicalWorkItem
  /** Deduplicated attention reasons in deterministic display order. */
  signals: FocusSignal[]
  /** Score components and tie-break evidence used for ordering. */
  rank: FocusRankBreakdown
  /** Actions authorized against the current source state. */
  capabilities: FocusItemCapabilities
  /** Whether and why the item currently offers a primary work action. */
  actionability: FocusActionability
  /** Effective policy identifier found in the enclosing queue response. */
  effectivePolicyId: string
  /** ISO 8601 timestamp until which the item remains snoozed. */
  snoozedUntil?: string
  /** Whether the caller currently watches the Work Item. */
  watching: boolean
  /** ISO 8601 timestamp of the latest aggregate recomputation. */
  updatedAt: string
}

/** Items returned for one Focus queue section. */
export type FocusQueueSectionGroup = {
  /** Section represented by this group. */
  section: FocusQueueSection
  /** Rank-ordered Focus items in this section. */
  items: FocusItem[]
}

/** Permission-filtered Workspace metrics derived from canonical Focus signals. */
export type FocusQueueMetrics = {
  /** Number of visible active Work Items with at least one unresolved real blocker. */
  blocked: number
}

/** Policy scopes the current viewer may update from the Focus queue. */
export type FocusPolicyCapabilities = {
  /** Whether the current viewer may replace their personal policy layer. */
  canEditPersonal: boolean
  /** Visible Teams whose policy layer the current viewer may manage. */
  editableTeamIds: string[]
}

/** Response returned by `GET /api/focus`. */
export type FocusQueueResponse = {
  /** Contract schema version. */
  schemaVersion: FocusSchemaVersion
  /** ISO 8601 timestamp at which the queue snapshot was generated. */
  generatedAt: string
  /** Authenticated member key used by permission-bound assign actions. */
  viewerMemberKey: string
  /** Canonical signal metrics independent from recipient queue inclusion rules. */
  metrics: FocusQueueMetrics
  /** Effective policies referenced by the returned items. */
  effectivePolicies: FocusEffectivePolicy[]
  /** Accessible stored Team overrides used by the policy editor. */
  teamPolicies: FocusPolicy[]
  /** Current viewer's stored personal override, omitted before the first update. */
  userPolicy?: FocusPolicy
  /** Policy scopes authorized for the current viewer. */
  policyCapabilities: FocusPolicyCapabilities
  /** Queue groups in stable Now, Next, Waiting, Snoozed, and Done order. */
  sections: FocusQueueSectionGroup[]
}

/** Input that replaces one user or Team Focus policy override. */
export type UpdateFocusPolicyInput = {
  /** User or Team policy to replace. */
  target: FocusPolicyTarget
  /** Observed policy version, or zero when creating the first override. */
  expectedVersion: number
  /** Complete replacement set of overrides for this policy layer. */
  overrides: FocusPolicyOverrides
}

/** Response returned after updating a Focus policy. */
export type UpdateFocusPolicyResponse = {
  /** Stored policy after the successful version-checked update. */
  policy: FocusPolicy
  /** Effective Team policies produced after applying the updated layer. */
  effectivePolicies: FocusEffectivePolicy[]
}

/** Input that snoozes or unsnoozes one Focus item. */
export type UpdateFocusSnoozeInput = {
  /** Observed Focus item version used for optimistic concurrency. */
  expectedVersion: number
  /** ISO 8601 wake time, or null to remove the current snooze. */
  snoozedUntil: string | null
}

/** Response returned after changing a Focus snooze. */
export type UpdateFocusSnoozeResponse = {
  /** Recomputed Focus item after the snooze change. */
  item: FocusItem
}

/** Input that changes the watch state of one Focus Work Item. */
export type UpdateFocusWatchInput = {
  /** Observed Focus item version used for optimistic concurrency. */
  expectedVersion: number
  /** Desired watch state. */
  watching: boolean
}

/** Response returned after changing a Focus watch state. */
export type UpdateFocusWatchResponse = {
  /** Recomputed Focus item after the watch change. */
  item: FocusItem
}
