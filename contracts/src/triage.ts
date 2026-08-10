/** Current persisted and public schema version for triage entries. */
export const TRIAGE_ENTRY_SCHEMA_VERSION = 1

/** Current persisted and public schema version for team triage configuration. */
export const TRIAGE_CONFIGURATION_SCHEMA_VERSION = 1

/** Maximum number of entries accepted by one bulk triage operation. */
export const TRIAGE_BULK_ACTION_LIMIT = 100

/** A channel that can contribute an item to the shared triage queue. */
export type TriageSourceKind =
  | 'form'
  | 'chat'
  | 'email'
  | 'webhook'
  | 'manual-handoff'

/** The complete lifecycle state of a triage entry. */
export type TriageEntryState =
  | 'pending'
  | 'accepted'
  | 'duplicate'
  | 'declined'
  | 'snoozed'
  | 'needs-information'

/** The amount of source content the current principal may view. */
export type TriagePermissionVisibility = 'full' | 'metadata-only' | 'denied'

/** A stable provider-neutral reference to the source that created an entry. */
export type TriageSourceReference = {
  /** The source channel. */
  kind: TriageSourceKind
  /** The source-owned stable identifier used for duplicate ingestion protection. */
  sourceId: string
  /** The external provider name, such as Slack or Microsoft Teams. */
  provider?: string
  /** The provider-owned container, conversation, mailbox, or endpoint identifier. */
  containerId?: string
  /** The provider-owned message or event identifier when it differs from sourceId. */
  messageId?: string
  /** The Request Intake form identifier for form submissions. */
  formId?: string
  /** The Request Intake submission identifier for form submissions. */
  submissionId?: string
  /** The developer-platform connector identifier for webhook sources. */
  connectorId?: string
}

/** An allowlisted summary of source content safe to persist in the queue row. */
export type TriageSourcePreview = {
  /** The concise source title shown in queue rows. */
  title: string
  /** The bounded plain-text body preview. */
  body: string
  /** A user-facing channel or integration label. */
  channelLabel?: string
  /** A permission-filtered HTTPS link to the original source. */
  permalink?: string
  /** The number of attachments retained by the source owner. */
  attachmentCount: number
  /** The number of source comments or messages known at projection time. */
  commentCount: number
  /** The number of source watchers known at projection time. */
  watcherCount: number
  /** Whether unsafe markup or provider-only content was removed. */
  sanitized: boolean
  /** Whether the title or body was shortened to fit the queue projection. */
  truncated: boolean
}

/** Requester identity projected from the source without exposing provider credentials. */
export type TriageRequester = {
  /** The display name safe to show under the entry permission projection. */
  displayName: string
  /** The requester email address when the active permission projection allows it. */
  email?: string
  /** A short-lived or public avatar URL when the source permits it. */
  avatarUrl?: string
  /** The provider-owned actor identifier used for traceability. */
  externalId?: string
  /** Whether the requester is represented as a Workspace guest. */
  guest: boolean
}

/** Live source permission and reply capability projected for an entry. */
export type TriagePermission = {
  /** The content visibility available to the current queue projection. */
  visibility: TriagePermissionVisibility
  /** Whether the source supports and currently authorizes a reply. */
  canReply: boolean
  /** Whether the allowlisted projection may be shown to a Workspace guest. */
  guestVisible: boolean
  /** A stable reason code explaining a restricted permission projection. */
  reasonCode?: string
  /** The last time source authorization was evaluated. */
  checkedAt: string
}

/** A team or project considered by routing. */
export type TriageRoutingCandidate = {
  /** The candidate Team identifier. */
  teamId: string
  /** The candidate Project identifier when routing was project-specific. */
  projectId?: string
  /** A human-readable explanation of why this candidate matched. */
  reason: string
  /** The routing rule that contributed this candidate. */
  ruleId?: string
  /** A normalized ranking score from zero through one. */
  score?: number
  /** Whether the entry may currently be routed to this destination. */
  permitted: boolean
}

/** The routing explanation and ordered candidates retained for operator review. */
export type TriageRouting = {
  /** The primary explanation shown in the queue. */
  reason: string
  /** Ordered candidate destinations considered at ingestion time. */
  candidates: TriageRoutingCandidate[]
}

/** Retention metadata applied to source-owned and queue-owned content. */
export type TriageRetention = {
  /** The policy identifier used to derive the retention deadline. */
  policyId?: string
  /** The ISO 8601 instant when content must be redacted or removed. */
  expiresAt: string
  /** The ISO 8601 instant when sensitive projection fields were redacted. */
  redactedAt?: string
}

/** SLA and escalation timing retained on a triage entry. */
export type TriageSla = {
  /** The SLA policy that produced these deadlines. */
  policyId: string
  /** The ISO 8601 instant when the entry first breaches its response SLA. */
  dueAt: string
  /** The ISO 8601 instant when an SLA breach was recorded. */
  breachedAt?: string
  /** The ISO 8601 instant when the entry should be escalated. */
  escalationDueAt?: string
  /** The ISO 8601 instant when escalation was recorded. */
  escalatedAt?: string
}

/** A canonical Work Item associated with an accepted or duplicate entry. */
export type TriageWorkItemReference = {
  /** The owning Team identifier. */
  teamId: string
  /** The canonical Work Item identifier. */
  workItemId: string
  /** The currently assigned Project identifier when one exists. */
  projectId?: string
}

/** Counts proving which permission-safe source metadata was attached to a canonical Work Item. */
export type TriageMergeReceipt = {
  /** The canonical Work Item that received the context. */
  canonicalWorkItemId: string
  /** The number of source references attached. */
  mergedSourceCount: number
  /** The number of comments or source messages represented by retained metadata. */
  mergedCommentCount: number
  /** The number of attachments represented by retained metadata. */
  mergedAttachmentCount: number
  /** The number of source watchers represented by retained metadata. */
  mergedWatcherCount: number
  /** The ISO 8601 instant when merge orchestration completed. */
  completedAt: string
}

/** An immutable audit-friendly event in an entry history. */
export type TriageEntryEvent = {
  /** The stable event identifier. */
  id: string
  /** The stable event type. */
  type:
    | 'created'
    | 'assigned'
    | 'accepted'
    | 'linked'
    | 'duplicate'
    | 'declined'
    | 'snoozed'
    | 'information-requested'
    | 'activity-received'
    | 'resurfaced'
    | 'sla-breached'
    | 'escalated'
    | 'retention-redacted'
  /** The member, service, or system actor that produced the event. */
  actorId: string
  /** A bounded display summary that contains no provider secret. */
  summary: string
  /** The ISO 8601 event creation instant. */
  createdAt: string
}

/** Server-computed operations available to the current principal. */
export type TriageEntryCapabilities = {
  /** Whether the principal may change the owner or routed project. */
  canAssign: boolean
  /** Whether the principal may create a Work Item from the entry. */
  canAcceptCreate: boolean
  /** Whether the principal may link the entry to an existing Work Item. */
  canAcceptLink: boolean
  /** Whether the principal may mark the entry as duplicate. */
  canMarkDuplicate: boolean
  /** Whether the principal may decline the entry. */
  canDecline: boolean
  /** Whether the principal may snooze the entry. */
  canSnooze: boolean
  /** Whether the principal may request more information. */
  canRequestInformation: boolean
  /** Whether the principal may reply through the source. */
  canReply: boolean
  /** Whether the principal may view internal routing and decision context. */
  canViewInternalContext: boolean
}

/** A canonical queue entry shared by all supported intake sources. */
export type TriageEntry = {
  /** The public schema version. */
  schemaVersion: typeof TRIAGE_ENTRY_SCHEMA_VERSION
  /** The stable triage entry identifier. */
  id: string
  /** The owning Workspace directory identifier. */
  workspaceId: string
  /** The stable source reference. */
  source: TriageSourceReference
  /** The allowlisted queue preview. */
  sourcePreview: TriageSourcePreview
  /** The projected requester identity. */
  requester: TriageRequester
  /** The ISO 8601 instant when the source was first received. */
  receivedAt: string
  /** The ISO 8601 instant of the most recent source activity. */
  lastActivityAt: string
  /** The current lifecycle state. */
  state: TriageEntryState
  /** The retained routing decision. */
  routing: TriageRouting
  /** The Team currently owning the queue entry. */
  teamId: string
  /** The currently selected Project. */
  projectId?: string
  /** The currently assigned Workspace user, or absent when unowned. */
  ownerUserId?: string
  /** The source permission and reply projection. */
  permission: TriagePermission
  /** The active SLA and escalation clocks. */
  sla?: TriageSla
  /** The wake instant while the entry is snoozed. */
  snoozedUntil?: string
  /** The source and queue retention boundary. */
  retention: TriageRetention
  /** The canonical Work Item after acceptance or duplicate resolution. */
  canonicalWorkItem?: TriageWorkItemReference
  /** Proof that duplicate context was preserved. */
  mergeReceipt?: TriageMergeReceipt
  /** Operations available to the current principal. */
  capabilities: TriageEntryCapabilities
  /** A bounded recent event projection. */
  events: TriageEntryEvent[]
  /** The optimistic concurrency revision. */
  revision: number
  /** The ISO 8601 creation instant. */
  createdAt: string
  /** The ISO 8601 last mutation instant. */
  updatedAt: string
}

/** Cursor-paginated Team triage queue response. */
export type TriageEntryPage = {
  /** Queue entries ordered by most recent activity first. */
  entries: TriageEntry[]
  /** Permission-safe bulk operation kinds currently enabled for the Team. */
  allowedBulkActions: TriageBulkOperation['action'][]
  /** Whether the current principal may edit Team Triage configuration. */
  canManageConfiguration?: boolean
  /** Opaque scope-bound cursor for the next page. */
  nextCursor?: string
}

/** Filters accepted by a Team triage queue query. */
export type TriageQueueSlaFilter = 'on-track' | 'due-soon' | 'breached' | 'paused'

/** Filters accepted by a Team triage queue query. */
export type TriageEntryListInput = {
  /** Case-insensitive text matched against the permission-safe queue projection. */
  query?: string
  /** A single lifecycle state to include. */
  state?: TriageEntryState
  /** A single source kind to include. */
  sourceKind?: TriageSourceKind
  /** The derived SLA condition to include. */
  sla?: TriageQueueSlaFilter
  /** A specific owner, or the literal `unowned`. */
  ownerUserId?: string | 'unowned'
  /** Maximum entries to return. */
  limit?: number
  /** Opaque scope-bound cursor from a previous page. */
  cursor?: string
}

/** Assigns or clears the entry owner and optionally changes the selected Project. */
export type AssignTriageAction = {
  /** The action discriminator. */
  action: 'assign'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The new owner, or null to leave the entry unowned. */
  ownerUserId: string | null
  /** The selected Project, or null to clear it. */
  projectId?: string | null
}

/** Accepts an entry by atomically creating a canonical Work Item. */
export type AcceptCreateTriageAction = {
  /** The action discriminator. */
  action: 'accept'
  /** The acceptance mode. */
  mode: 'create'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The Project to assign to the new Work Item. */
  projectId?: string
}

/** Accepts an entry by linking it to an existing canonical Work Item. */
export type AcceptLinkTriageAction = {
  /** The action discriminator. */
  action: 'accept'
  /** The acceptance mode. */
  mode: 'link'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The existing Work Item identifier. */
  workItemId: string
}

/** Marks an entry as duplicate and attaches its context to a canonical Work Item. */
export type DuplicateTriageAction = {
  /** The action discriminator. */
  action: 'duplicate'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The canonical Work Item receiving all retained context. */
  canonicalWorkItemId: string
}

/** Declines an entry with an operator-visible reason. */
export type DeclineTriageAction = {
  /** The action discriminator. */
  action: 'decline'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The bounded decline reason. */
  reason: string
}

/** Snoozes an entry until a future instant or new source activity. */
export type SnoozeTriageAction = {
  /** The action discriminator. */
  action: 'snooze'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The future ISO 8601 wake instant. */
  until: string
}

/** Requests additional information through a reply-capable source. */
export type RequestInformationTriageAction = {
  /** The action discriminator. */
  action: 'request-information'
  /** The revision the operator viewed. */
  expectedRevision: number
  /** The bounded message delivered through the source adapter. */
  message: string
}

/** A supported optimistic-concurrency triage mutation. */
export type TriageActionInput =
  | AssignTriageAction
  | AcceptCreateTriageAction
  | AcceptLinkTriageAction
  | DuplicateTriageAction
  | DeclineTriageAction
  | SnoozeTriageAction
  | RequestInformationTriageAction

/** The result of a replay-safe entry mutation. */
export type TriageMutationReceipt = {
  /** The resulting entry. */
  entry: TriageEntry
  /** Whether this response came from an existing idempotency receipt. */
  replayed: boolean
}

/** An entry and revision included in a bulk mutation. */
export type TriageBulkTarget = {
  /** The target entry identifier. */
  entryId: string
  /** The revision the operator viewed. */
  expectedRevision: number
}

/** Assignment operation applied consistently to every bulk target. */
export type TriageBulkAssignOperation = {
  /** The operation discriminator. */
  action: 'assign'
  /** The new owner, or null to leave entries unowned. */
  ownerUserId: string | null
  /** The selected Project, or null to clear it. */
  projectId?: string | null
}

/** Decline operation applied consistently to every bulk target. */
export type TriageBulkDeclineOperation = {
  /** The operation discriminator. */
  action: 'decline'
  /** The bounded decline reason. */
  reason: string
}

/** Snooze operation applied consistently to every bulk target. */
export type TriageBulkSnoozeOperation = {
  /** The operation discriminator. */
  action: 'snooze'
  /** The future ISO 8601 wake instant. */
  until: string
}

/** One operation applied consistently to every bulk target. */
export type TriageBulkOperation =
  | TriageBulkAssignOperation
  | TriageBulkDeclineOperation
  | TriageBulkSnoozeOperation

/** Input for a bounded, independently conditional bulk action. */
export type TriageBulkActionInput = {
  /** Entries and revisions to mutate. */
  targets: TriageBulkTarget[]
  /** The operation applied to each target. */
  operation: TriageBulkOperation
}

/** The status of one target in a bulk operation. */
export type TriageBulkItemResult = {
  /** The target entry identifier. */
  entryId: string
  /** The independently evaluated result status. */
  status: 'succeeded' | 'conflict' | 'failed'
  /** The resulting entry when the action succeeded. */
  entry?: TriageEntry
  /** A stable error code when the target failed. */
  errorCode?: string
}

/** Result of a bulk action with partial-conflict visibility. */
export type TriageBulkActionResult = {
  /** One result for every requested target. */
  results: TriageBulkItemResult[]
}

/** Routing strategy that intentionally leaves a new entry unowned. */
export type TriageUnownedOwnerStrategy = {
  /** The strategy discriminator. */
  type: 'unowned'
}

/** Routing strategy that assigns one fixed Workspace user. */
export type TriageFixedOwnerStrategy = {
  /** The strategy discriminator. */
  type: 'fixed'
  /** The fixed Workspace user identifier. */
  ownerUserId: string
}

/** Routing strategy that advances a configured owner rotation. */
export type TriageRotationOwnerStrategy = {
  /** The strategy discriminator. */
  type: 'rotation'
  /** The referenced rotation identifier. */
  rotationId: string
}

/** How a routing rule chooses an initial owner. */
export type TriageOwnerStrategy =
  | TriageUnownedOwnerStrategy
  | TriageFixedOwnerStrategy
  | TriageRotationOwnerStrategy

/** An ordered Team routing rule. */
export type TriageRoutingRule = {
  /** The stable rule identifier. */
  id: string
  /** The operator-facing rule name. */
  name: string
  /** Whether the rule participates in routing. */
  enabled: boolean
  /** Lower values are evaluated first. */
  order: number
  /** Source kinds eligible for this rule. */
  sourceKinds: TriageSourceKind[]
  /** Case-insensitive plain-text terms, any of which may match. */
  keywords: string[]
  /** The target Team identifier. */
  teamId: string
  /** The target Project identifier. */
  projectId?: string
  /** The initial ownership strategy. */
  owner: TriageOwnerStrategy
}

/** A deterministic owner rotation used by routing. */
export type TriageOwnerRotation = {
  /** The stable rotation identifier. */
  id: string
  /** The operator-facing rotation name. */
  name: string
  /** Ordered eligible Workspace user identifiers. */
  memberUserIds: string[]
  /** The next member index, advanced with a conditional write. */
  nextIndex: number
}

/** Team response and escalation timing policy. */
export type TriageSlaPolicy = {
  /** The stable policy identifier. */
  id: string
  /** The operator-facing policy name. */
  name: string
  /** Source kinds covered by the policy. */
  sourceKinds: TriageSourceKind[]
  /** Minutes from receipt until response breach. */
  responseMinutes: number
  /** Additional minutes from breach until escalation. */
  escalationMinutes?: number
  /** The user notified on escalation. */
  escalationOwnerUserId?: string
}

/** Versioned Team-level triage routing and service configuration. */
export type TriageConfiguration = {
  /** The public schema version. */
  schemaVersion: typeof TRIAGE_CONFIGURATION_SCHEMA_VERSION
  /** The owning Workspace identifier. */
  workspaceId: string
  /** The configured Team identifier. */
  teamId: string
  /** Ordered routing rules. */
  rules: TriageRoutingRule[]
  /** Owner rotations referenced by routing rules. */
  rotations: TriageOwnerRotation[]
  /** SLA policies evaluated in order. */
  slaPolicies: TriageSlaPolicy[]
  /** Bulk operation kinds enabled for this Team; an empty list disables bulk mutations. */
  allowedBulkActions: TriageBulkOperation['action'][]
  /** Default retention duration for projected source content. */
  retentionDays: number
  /** The optimistic concurrency revision. */
  revision: number
  /** The ISO 8601 last mutation instant. */
  updatedAt: string
}

/** Input replacing a Team triage configuration. */
export type UpdateTriageConfigurationInput = {
  /** The revision the operator viewed. */
  expectedRevision: number
  /** Ordered routing rules. */
  rules: TriageRoutingRule[]
  /** Owner rotations referenced by routing rules. */
  rotations: TriageOwnerRotation[]
  /** SLA policies evaluated in order. */
  slaPolicies: TriageSlaPolicy[]
  /** Bulk operation kinds enabled for this Team; an empty list disables bulk mutations. */
  allowedBulkActions: TriageBulkOperation['action'][]
  /** Default retention duration for projected source content. */
  retentionDays: number
}

/** Input for an internal user handing an item to a Team queue. */
export type CreateManualTriageEntryInput = {
  /** A retry-stable handoff identifier selected by the caller. */
  sourceId: string
  /** The entry title. */
  title: string
  /** The bounded plain-text request body. */
  body: string
  /** The requester display name. */
  requesterDisplayName: string
  /** The requester email when it may be retained. */
  requesterEmail?: string
  /** The selected Project identifier. */
  projectId?: string
  /** The routing explanation retained for operators. */
  routingReason: string
  /** The initial owner, or absent for an unowned entry. */
  ownerUserId?: string
  /** Optional SLA policy identifier applied by the caller after configuration lookup. */
  slaPolicyId?: string
  /** Optional response deadline derived from the selected SLA policy. */
  slaDueAt?: string
  /** Optional escalation deadline derived from the selected SLA policy. */
  escalationDueAt?: string
  /** The content retention deadline. */
  retentionExpiresAt: string
}

/** Reverse source trace page for a canonical Work Item. */
export type TriageWorkItemSourcePage = {
  /** Entries associated with the canonical Work Item. */
  entries: TriageEntry[]
  /** Opaque scope-bound cursor for the next page. */
  nextCursor?: string
}
