import {
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageBulkActionResult,
  type TriageBulkItemResult,
  type TriageBulkOperation,
  type TriageConfiguration,
  type TriageEntry,
  type TriageEntryCapabilities,
  type TriageEntryEvent,
  type TriageEntryPage,
  type TriageEntryState,
  type TriageMergeReceipt,
  type TriageMutationReceipt,
  type TriageOwnerRotation,
  type TriageOwnerStrategy,
  type TriagePermission,
  type TriagePermissionVisibility,
  type TriageRequester,
  type TriageRetention,
  type TriageRouting,
  type TriageRoutingCandidate,
  type TriageRoutingRule,
  type TriageSla,
  type TriageSlaPolicy,
  type TriageSourceKind,
  type TriageSourcePreview,
  type TriageSourceReference,
  type TriageWorkItemReference,
  type TriageWorkItemSourcePage,
} from '@mukuroji/contracts'
import { TriageApiError } from './errors'

const invalidContractMessage = 'The Team triage response did not match the expected contract.'

/**
 * Validates and constructs one cursor page returned by the triage queue.
 *
 * @param value - Unknown JSON response body.
 * @returns A validated triage queue page.
 */
export function readTriageEntryPage(value: unknown): TriageEntryPage {
  const record = requireRecord(value)
  const nextCursor = readOptionalString(record.nextCursor)
  const canManageConfiguration = record.canManageConfiguration === undefined
    ? undefined
    : requireBoolean(record.canManageConfiguration)
  return {
    allowedBulkActions: readAllowedBulkActions(record.allowedBulkActions),
    entries: requireArray(record.entries).map(readTriageEntry),
    ...(canManageConfiguration === undefined ? {} : { canManageConfiguration }),
    ...(nextCursor ? { nextCursor } : {}),
  }
}

/**
 * Validates one reverse Triage source page attached to a canonical Work Item.
 *
 * @param value - Unknown JSON response body.
 * @returns A validated reverse source page.
 */
export function readTriageWorkItemSourcePage(value: unknown): TriageWorkItemSourcePage {
  const record = requireRecord(value)
  const nextCursor = readOptionalString(record.nextCursor)
  return {
    entries: requireArray(record.entries).map(readTriageEntry),
    ...(nextCursor ? { nextCursor } : {}),
  }
}

/**
 * Validates and constructs one Team triage entry.
 *
 * @param value - Unknown JSON response body.
 * @returns A validated triage entry.
 */
export function readTriageEntry(value: unknown): TriageEntry {
  const record = requireRecord(value)
  const projectId = readOptionalString(record.projectId)
  const ownerUserId = readOptionalString(record.ownerUserId)
  const sla = record.sla === undefined ? undefined : readSla(record.sla)
  const snoozedUntil = readOptionalString(record.snoozedUntil)
  const canonicalWorkItem = record.canonicalWorkItem === undefined
    ? undefined
    : readWorkItemReference(record.canonicalWorkItem)
  const mergeReceipt = record.mergeReceipt === undefined
    ? undefined
    : readMergeReceipt(record.mergeReceipt)
  const customerId = readOptionalString(record.customerId)
  const contactId = readOptionalString(record.contactId)
  const customerRequestId = readOptionalString(record.customerRequestId)

  if (record.schemaVersion !== TRIAGE_ENTRY_SCHEMA_VERSION) {
    throw invalidContractError()
  }

  return {
    capabilities: readCapabilities(record.capabilities),
    createdAt: requireString(record.createdAt),
    events: requireArray(record.events).map(readEntryEvent),
    id: requireString(record.id),
    lastActivityAt: requireString(record.lastActivityAt),
    permission: readPermission(record.permission),
    receivedAt: requireString(record.receivedAt),
    requester: readRequester(record.requester),
    retention: readRetention(record.retention),
    revision: requireNonNegativeInteger(record.revision),
    routing: readRouting(record.routing),
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    source: readSourceReference(record.source),
    sourcePreview: readSourcePreview(record.sourcePreview),
    state: requireEntryState(record.state),
    teamId: requireString(record.teamId),
    updatedAt: requireString(record.updatedAt),
    workspaceId: requireString(record.workspaceId),
    ...(canonicalWorkItem ? { canonicalWorkItem } : {}),
    ...(contactId ? { contactId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(customerRequestId ? { customerRequestId } : {}),
    ...(mergeReceipt ? { mergeReceipt } : {}),
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sla ? { sla } : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  }
}

/**
 * Validates the replay-safe receipt returned by a single-entry action.
 *
 * @param value - Unknown JSON response body.
 * @returns A validated mutation receipt.
 */
export function readTriageMutationReceipt(value: unknown): TriageMutationReceipt {
  const record = requireRecord(value)
  return {
    entry: readTriageEntry(record.entry),
    replayed: requireBoolean(record.replayed),
  }
}

/**
 * Validates the result returned by a bounded bulk triage action.
 *
 * @param value - Unknown JSON response body.
 * @returns A validated bulk action result.
 */
export function readTriageBulkActionResult(value: unknown): TriageBulkActionResult {
  const record = requireRecord(value)
  return { results: requireArray(record.results).map(readBulkItemResult) }
}

/**
 * Validates and constructs Team triage configuration.
 *
 * @param value - Unknown JSON response body.
 * @returns Validated Team triage configuration.
 */
export function readTriageConfiguration(value: unknown): TriageConfiguration {
  const record = requireRecord(value)
  if (record.schemaVersion !== TRIAGE_CONFIGURATION_SCHEMA_VERSION) {
    throw invalidContractError()
  }
  return {
    allowedBulkActions: readAllowedBulkActions(record.allowedBulkActions),
    retentionDays: requireNonNegativeInteger(record.retentionDays),
    revision: requireNonNegativeInteger(record.revision),
    rotations: requireArray(record.rotations).map(readOwnerRotation),
    rules: requireArray(record.rules).map(readRoutingRule),
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    slaPolicies: requireArray(record.slaPolicies).map(readSlaPolicy),
    teamId: requireString(record.teamId),
    updatedAt: requireString(record.updatedAt),
    workspaceId: requireString(record.workspaceId),
  }
}

/** Validates the unique bulk operation names enabled by Team settings. */
function readAllowedBulkActions(value: unknown): TriageBulkOperation['action'][] {
  const actions = requireArray(value).map((action) => {
    if (action === 'assign' || action === 'decline' || action === 'snooze') return action
    throw invalidContractError()
  })
  if (new Set(actions).size !== actions.length) throw invalidContractError()
  return actions
}

/** Validates a provider-neutral source reference. */
function readSourceReference(value: unknown): TriageSourceReference {
  const record = requireRecord(value)
  const provider = readOptionalString(record.provider)
  const containerId = readOptionalString(record.containerId)
  const messageId = readOptionalString(record.messageId)
  const formId = readOptionalString(record.formId)
  const submissionId = readOptionalString(record.submissionId)
  const connectorId = readOptionalString(record.connectorId)
  return {
    kind: requireSourceKind(record.kind),
    sourceId: requireString(record.sourceId),
    ...(connectorId ? { connectorId } : {}),
    ...(containerId ? { containerId } : {}),
    ...(formId ? { formId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(provider ? { provider } : {}),
    ...(submissionId ? { submissionId } : {}),
  }
}

/** Validates a permission-filtered source preview. */
function readSourcePreview(value: unknown): TriageSourcePreview {
  const record = requireRecord(value)
  const channelLabel = readOptionalString(record.channelLabel)
  const permalink = readOptionalHttpsUrl(record.permalink)
  return {
    attachmentCount: requireNonNegativeInteger(record.attachmentCount),
    body: requireString(record.body),
    commentCount: requireNonNegativeInteger(record.commentCount),
    sanitized: requireBoolean(record.sanitized),
    title: requireString(record.title),
    truncated: requireBoolean(record.truncated),
    watcherCount: requireNonNegativeInteger(record.watcherCount),
    ...(channelLabel ? { channelLabel } : {}),
    ...(permalink ? { permalink } : {}),
  }
}

/** Validates a projected requester identity. */
function readRequester(value: unknown): TriageRequester {
  const record = requireRecord(value)
  const email = readOptionalString(record.email)
  const avatarUrl = readOptionalString(record.avatarUrl)
  const externalId = readOptionalString(record.externalId)
  return {
    displayName: requireString(record.displayName),
    guest: requireBoolean(record.guest),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(email ? { email } : {}),
    ...(externalId ? { externalId } : {}),
  }
}

/** Validates a source permission projection. */
function readPermission(value: unknown): TriagePermission {
  const record = requireRecord(value)
  const reasonCode = readOptionalString(record.reasonCode)
  return {
    canReply: requireBoolean(record.canReply),
    checkedAt: requireString(record.checkedAt),
    guestVisible: requireBoolean(record.guestVisible),
    visibility: requirePermissionVisibility(record.visibility),
    ...(reasonCode ? { reasonCode } : {}),
  }
}

/** Validates an entry routing decision. */
function readRouting(value: unknown): TriageRouting {
  const record = requireRecord(value)
  return {
    candidates: requireArray(record.candidates).map(readRoutingCandidate),
    reason: requireString(record.reason),
  }
}

/** Validates one permission-aware routing candidate. */
function readRoutingCandidate(value: unknown): TriageRoutingCandidate {
  const record = requireRecord(value)
  const projectId = readOptionalString(record.projectId)
  const ruleId = readOptionalString(record.ruleId)
  const score = readOptionalScore(record.score)
  return {
    permitted: requireBoolean(record.permitted),
    reason: requireString(record.reason),
    teamId: requireString(record.teamId),
    ...(projectId ? { projectId } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(score !== undefined ? { score } : {}),
  }
}

/** Validates an entry retention boundary. */
function readRetention(value: unknown): TriageRetention {
  const record = requireRecord(value)
  const policyId = readOptionalString(record.policyId)
  const redactedAt = readOptionalString(record.redactedAt)
  return {
    expiresAt: requireString(record.expiresAt),
    ...(policyId ? { policyId } : {}),
    ...(redactedAt ? { redactedAt } : {}),
  }
}

/** Validates an entry SLA projection. */
function readSla(value: unknown): TriageSla {
  const record = requireRecord(value)
  const breachedAt = readOptionalString(record.breachedAt)
  const escalationDueAt = readOptionalString(record.escalationDueAt)
  const escalatedAt = readOptionalString(record.escalatedAt)
  const escalationOwnerUserId = readOptionalString(record.escalationOwnerUserId)
  return {
    dueAt: requireString(record.dueAt),
    policyId: requireString(record.policyId),
    ...(breachedAt ? { breachedAt } : {}),
    ...(escalatedAt ? { escalatedAt } : {}),
    ...(escalationDueAt ? { escalationDueAt } : {}),
    ...(escalationOwnerUserId ? { escalationOwnerUserId } : {}),
  }
}

/** Validates a canonical Work Item reference. */
function readWorkItemReference(value: unknown): TriageWorkItemReference {
  const record = requireRecord(value)
  const projectId = readOptionalString(record.projectId)
  const workItemTypeId = readOptionalString(record.workItemTypeId)
  return {
    teamId: requireString(record.teamId),
    workItemId: requireString(record.workItemId),
    ...(projectId ? { projectId } : {}),
    ...(workItemTypeId ? { workItemTypeId } : {}),
  }
}

/** Validates context-preservation counts from a merge. */
function readMergeReceipt(value: unknown): TriageMergeReceipt {
  const record = requireRecord(value)
  return {
    canonicalWorkItemId: requireString(record.canonicalWorkItemId),
    completedAt: requireString(record.completedAt),
    mergedAttachmentCount: requireNonNegativeInteger(record.mergedAttachmentCount),
    mergedCommentCount: requireNonNegativeInteger(record.mergedCommentCount),
    mergedSourceCount: requireNonNegativeInteger(record.mergedSourceCount),
    mergedWatcherCount: requireNonNegativeInteger(record.mergedWatcherCount),
  }
}

/** Validates server-computed entry capabilities. */
function readCapabilities(value: unknown): TriageEntryCapabilities {
  const record = requireRecord(value)
  return {
    canAcceptCreate: requireBoolean(record.canAcceptCreate),
    canAcceptLink: requireBoolean(record.canAcceptLink),
    canAssign: requireBoolean(record.canAssign),
    canDecline: requireBoolean(record.canDecline),
    canMarkDuplicate: requireBoolean(record.canMarkDuplicate),
    canReply: requireBoolean(record.canReply),
    canRequestInformation: requireBoolean(record.canRequestInformation),
    canSnooze: requireBoolean(record.canSnooze),
    canViewInternalContext: requireBoolean(record.canViewInternalContext),
  }
}

/** Validates one bounded audit event. */
function readEntryEvent(value: unknown): TriageEntryEvent {
  const record = requireRecord(value)
  const type = record.type
  if (
    type !== 'created' && type !== 'assigned' && type !== 'accepted' &&
    type !== 'linked' && type !== 'duplicate' && type !== 'declined' &&
    type !== 'snoozed' && type !== 'information-requested' &&
    type !== 'activity-received' && type !== 'resurfaced' &&
    type !== 'sla-breached' && type !== 'escalated' &&
    type !== 'retention-redacted' && type !== 'customer-associated'
  ) {
    throw invalidContractError()
  }
  return {
    actorId: requireString(record.actorId),
    createdAt: requireString(record.createdAt),
    id: requireString(record.id),
    summary: requireString(record.summary),
    type,
  }
}

/** Validates one independently evaluated bulk result. */
function readBulkItemResult(value: unknown): TriageBulkItemResult {
  const record = requireRecord(value)
  const status = record.status
  if (status !== 'succeeded' && status !== 'conflict' && status !== 'failed') {
    throw invalidContractError()
  }
  const entry = record.entry === undefined ? undefined : readTriageEntry(record.entry)
  const errorCode = readOptionalString(record.errorCode)
  return {
    entryId: requireString(record.entryId),
    status,
    ...(entry ? { entry } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

/** Validates one ordered routing rule. */
function readRoutingRule(value: unknown): TriageRoutingRule {
  const record = requireRecord(value)
  const projectId = readOptionalString(record.projectId)
  return {
    enabled: requireBoolean(record.enabled),
    id: requireString(record.id),
    keywords: requireArray(record.keywords).map(requireString),
    name: requireString(record.name),
    order: requireNonNegativeInteger(record.order),
    owner: readOwnerStrategy(record.owner),
    sourceKinds: requireArray(record.sourceKinds).map(requireSourceKind),
    teamId: requireString(record.teamId),
    ...(projectId ? { projectId } : {}),
  }
}

/** Validates an initial owner strategy. */
function readOwnerStrategy(value: unknown): TriageOwnerStrategy {
  const record = requireRecord(value)
  if (record.type === 'unowned') return { type: 'unowned' }
  if (record.type === 'fixed') {
    return { ownerUserId: requireString(record.ownerUserId), type: 'fixed' }
  }
  if (record.type === 'rotation') {
    return { rotationId: requireString(record.rotationId), type: 'rotation' }
  }
  throw invalidContractError()
}

/** Validates one deterministic owner rotation. */
function readOwnerRotation(value: unknown): TriageOwnerRotation {
  const record = requireRecord(value)
  return {
    id: requireString(record.id),
    memberUserIds: requireArray(record.memberUserIds).map(requireString),
    name: requireString(record.name),
    nextIndex: requireNonNegativeInteger(record.nextIndex),
  }
}

/** Validates one Team SLA policy. */
function readSlaPolicy(value: unknown): TriageSlaPolicy {
  const record = requireRecord(value)
  const escalationMinutes = readOptionalNonNegativeInteger(record.escalationMinutes)
  const escalationOwnerUserId = readOptionalString(record.escalationOwnerUserId)
  return {
    id: requireString(record.id),
    name: requireString(record.name),
    responseMinutes: requireNonNegativeInteger(record.responseMinutes),
    sourceKinds: requireArray(record.sourceKinds).map(requireSourceKind),
    ...(escalationMinutes !== undefined ? { escalationMinutes } : {}),
    ...(escalationOwnerUserId ? { escalationOwnerUserId } : {}),
  }
}

/** Narrows an unknown value to a supported entry state. */
function requireEntryState(value: unknown): TriageEntryState {
  if (
    value === 'pending' || value === 'accepted' || value === 'duplicate' ||
    value === 'declined' || value === 'snoozed' || value === 'needs-information'
  ) return value
  throw invalidContractError()
}

/** Narrows an unknown value to a supported source kind. */
function requireSourceKind(value: unknown): TriageSourceKind {
  if (
    value === 'form' || value === 'chat' || value === 'email' ||
    value === 'webhook' || value === 'manual-handoff'
  ) return value
  throw invalidContractError()
}

/** Narrows an unknown value to a supported visibility level. */
function requirePermissionVisibility(value: unknown): TriagePermissionVisibility {
  if (value === 'full' || value === 'metadata-only' || value === 'denied') return value
  throw invalidContractError()
}

/** Requires a non-array object at a contract boundary. */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidContractError()
  }
  return value
}

/** Checks whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Requires an array at a contract boundary. */
function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidContractError()
  return value
}

/** Requires a string at a contract boundary. */
function requireString(value: unknown): string {
  if (typeof value !== 'string') throw invalidContractError()
  return value
}

/** Reads an optional non-empty string. */
function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requireString(value)
}

/** Requires a boolean at a contract boundary. */
function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidContractError()
  return value
}

/** Requires a non-negative safe integer. */
function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidContractError()
  }
  return value
}

/** Reads an optional non-negative safe integer. */
function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined || value === null
    ? undefined
    : requireNonNegativeInteger(value)
}

/** Reads an optional normalized routing score. */
function readOptionalScore(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidContractError()
  }
  return value
}

/** Reads and normalizes an optional HTTPS URL. */
function readOptionalHttpsUrl(value: unknown): string | undefined {
  const candidate = readOptionalString(value)
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') throw invalidContractError()
    return url.toString()
  } catch (error) {
    if (error instanceof TriageApiError) throw error
    throw invalidContractError()
  }
}

/** Creates the stable error used for malformed successful responses. */
function invalidContractError() {
  return new TriageApiError(502, invalidContractMessage, 'InvalidTriageContract')
}
