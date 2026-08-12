import type {
  TriageActionInput,
  TriageEntry,
  TriageEntryCapabilities,
  TriageEntryEvent,
  TriageEntryState,
  TriageConfiguration,
  TriageMergeReceipt,
  TriageWorkItemReference,
} from '@mukuroji/contracts'

/** Maximum recent events retained in the entry projection. */
export const TRIAGE_ENTRY_EVENT_LIMIT = 100

/** Stable application error produced by the triage domain. */
export class TriageError extends Error {
  /** HTTP status suitable for an adapter response. */
  readonly status: number

  /** Stable machine-readable failure code. */
  readonly code: string

  /** Creates a triage application error.
   *
   * @param status The HTTP-compatible status.
   * @param code The stable error code.
   * @param message The safe failure message.
   * @param options Optional native error options.
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TriageError'
    this.status = status
    this.code = code
  }
}

/** Context supplied after authorization and dependent resource validation. */
export type ApplyTriageActionContext = {
  /** The stable member or service actor identifier. */
  actorId: string
  /** The ISO 8601 mutation instant. */
  now: string
  /** The canonical Work Item resolved for accept and duplicate actions. */
  canonicalWorkItem?: TriageWorkItemReference
  /** Proof that duplicate context was preserved. */
  mergeReceipt?: TriageMergeReceipt
}

/** New source activity used to update and potentially resurface an entry. */
export type TriageSourceActivity = {
  /** The provider-stable activity identifier. */
  activityId: string
  /** The ISO 8601 activity instant. */
  occurredAt: string
  /** A bounded summary that is safe for internal history. */
  summary: string
  /** The service actor recording the activity. */
  actorId: string
}

/** Schedule evaluation result for one entry. */
export type TriageScheduleEvaluation = {
  /** The resulting entry. */
  entry: TriageEntry
  /** Whether the lifecycle state was resurfaced. */
  resurfaced: boolean
  /** Whether the response SLA was newly marked breached. */
  breached: boolean
  /** Whether escalation was newly marked complete. */
  escalated: boolean
  /** Whether permission-filtered source content was newly redacted. */
  redacted: boolean
}

/** Conditional owner-rotation reservation produced during admission. */
export type TriageAdmissionRotationReservation = {
  /** Updated configuration to persist in the source transaction. */
  configuration: TriageConfiguration
  /** Zero-based rotation position used by the DynamoDB condition path. */
  rotationIndex: number
  /** Configuration revision observed by the pure evaluation. */
  expectedRevision: number
  /** Rotation cursor observed by the pure evaluation. */
  expectedNextIndex: number
}

/** Result of applying current Team configuration to a new source entry. */
export type TriageAdmissionEvaluation = {
  /** Entry with routing, ownership, SLA, and retention derived from configuration. */
  entry: TriageEntry
  /** Atomic rotation reservation when the matched rule uses a rotation. */
  rotationReservation?: TriageAdmissionRotationReservation
}

/** Returns whether a triage state is operator-terminal.
 *
 * @param state The lifecycle state to evaluate.
 * @returns Whether normal operator mutations must be rejected.
 */
export function isTerminalTriageState(state: TriageEntryState): boolean {
  return state === 'accepted' || state === 'duplicate' || state === 'declined'
}

/** Computes capabilities from state and source permission.
 *
 * @param entry The canonical entry projection.
 * @param canViewInternalContext Whether the current principal may see internal context.
 * @returns Server-computed mutation capabilities.
 */
export function createTriageCapabilities(
  entry: Pick<TriageEntry, 'state' | 'permission'>,
  canViewInternalContext = true,
): TriageEntryCapabilities {
  const mutable = !isTerminalTriageState(entry.state)
  const operable = mutable && entry.permission.visibility !== 'denied'
  const replyCapable = mutable && entry.permission.visibility === 'full' && entry.permission.canReply
  return {
    canAssign: operable,
    canAcceptCreate: operable,
    canAcceptLink: operable,
    canMarkDuplicate: operable,
    canDecline: operable,
    canSnooze: operable,
    canRequestInformation: replyCapable,
    canReply: replyCapable,
    canViewInternalContext,
  }
}

/** Applies current Team routing and service policy to a newly admitted entry.
 *
 * @param configuration The current persisted Team configuration.
 * @param entry The normalized source entry before Team configuration is applied.
 * @param nowValue The ISO 8601 admission instant.
 * @returns The configured entry and an optional conditional rotation reservation.
 */
export function evaluateTriageAdmission(
  configuration: TriageConfiguration,
  entry: TriageEntry,
  nowValue: string,
): TriageAdmissionEvaluation {
  const now = requireIsoInstant(nowValue, 'Triage admission time')
  if (configuration.workspaceId !== entry.workspaceId || configuration.teamId !== entry.teamId) {
    throw new TriageError(
      500,
      'InvalidTriageConfiguration',
      'The Triage configuration scope is invalid.',
    )
  }
  const searchableText = `${entry.sourcePreview.title}\n${entry.sourcePreview.body}`
    .toLocaleLowerCase('en-US')
  const rule = [...configuration.rules]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .find((candidate) =>
      candidate.enabled &&
      candidate.sourceKinds.includes(entry.source.kind) &&
      (
        candidate.keywords.length === 0 ||
        candidate.keywords.some((keyword) =>
          searchableText.includes(keyword.toLocaleLowerCase('en-US'))
        )
      )
    )
  if (rule && rule.teamId !== entry.teamId) {
    throw new TriageError(
      500,
      'InvalidTriageConfiguration',
      'A persisted Triage routing rule targets another Team.',
    )
  }

  let ownerUserId = entry.ownerUserId
  let rotationReservation: TriageAdmissionRotationReservation | undefined
  if (rule?.owner.type === 'fixed') {
    ownerUserId = normalizeTriageMemberKey(rule.owner.ownerUserId)
  } else if (rule?.owner.type === 'rotation') {
    const rotationId = rule.owner.rotationId
    const rotationIndex = configuration.rotations.findIndex((candidate) =>
      candidate.id === rotationId
    )
    const rotation = configuration.rotations[rotationIndex]
    if (!rotation || rotation.memberUserIds.length === 0 ||
      !Number.isSafeInteger(rotation.nextIndex) || rotation.nextIndex < 0 ||
      rotation.nextIndex >= rotation.memberUserIds.length) {
      throw new TriageError(
        500,
        'InvalidTriageConfiguration',
        'The persisted Triage owner rotation is invalid.',
      )
    }
    ownerUserId = normalizeTriageMemberKey(rotation.memberUserIds[rotation.nextIndex])
    const nextIndex = (rotation.nextIndex + 1) % rotation.memberUserIds.length
    rotationReservation = {
      configuration: {
        ...configuration,
        rotations: configuration.rotations.map((candidate, index) =>
          index === rotationIndex ? { ...candidate, nextIndex } : candidate
        ),
        revision: configuration.revision,
        updatedAt: configuration.updatedAt,
      },
      rotationIndex,
      expectedRevision: configuration.revision,
      expectedNextIndex: rotation.nextIndex,
    }
  } else if (rule?.owner.type === 'unowned') {
    ownerUserId = undefined
  }

  const slaPolicy = configuration.slaPolicies.find((policy) =>
    policy.sourceKinds.includes(entry.source.kind)
  )
  const slaDueAt = slaPolicy
    ? new Date(Date.parse(now) + slaPolicy.responseMinutes * 60_000)
    : undefined
  const escalationDueAt = slaDueAt && slaPolicy?.escalationMinutes !== undefined
    ? new Date(slaDueAt.getTime() + slaPolicy.escalationMinutes * 60_000)
    : undefined
  const retentionExpiresAt = new Date(now)
  retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + configuration.retentionDays)
  const projectId = rule?.projectId ?? entry.projectId
  const next: TriageEntry = {
    ...entry,
    routing: rule
      ? {
          reason: `Matched Team Triage routing rule "${rule.name}".`,
          candidates: [{
            teamId: entry.teamId,
            ...(projectId ? { projectId } : {}),
            reason: `Matched routing rule "${rule.name}".`,
            ruleId: rule.id,
            score: 1,
            permitted: true,
          }],
        }
      : entry.routing,
    retention: {
      ...entry.retention,
      expiresAt: retentionExpiresAt.toISOString(),
    },
    capabilities: createTriageCapabilities(entry),
  }
  delete next.projectId
  delete next.ownerUserId
  delete next.sla
  if (projectId) next.projectId = projectId
  if (ownerUserId) next.ownerUserId = ownerUserId
  if (slaPolicy && slaDueAt) {
    next.sla = {
      policyId: slaPolicy.id,
      dueAt: slaDueAt.toISOString(),
      ...(escalationDueAt ? { escalationDueAt: escalationDueAt.toISOString() } : {}),
      ...(slaPolicy.escalationOwnerUserId
        ? { escalationOwnerUserId: normalizeTriageMemberKey(slaPolicy.escalationOwnerUserId) }
        : {}),
    }
  }
  return {
    entry: next,
    ...(rotationReservation ? { rotationReservation } : {}),
  }
}

/** Applies the stored source permission to an API response projection.
 *
 * @param entry The canonical stored entry.
 * @returns A permission-safe response that never exposes unavailable source content.
 */
export function projectTriageEntryForResponse(
  entry: TriageEntry,
  nowValue = new Date().toISOString(),
): TriageEntry {
  const retentionSafeEntry = redactExpiredTriageEntry(entry, nowValue)
  if (retentionSafeEntry.permission.visibility === 'full') {
    const projected = retentionSafeEntry.sourcePreview.permalink !== undefined &&
      !isSafeHttpsUrl(retentionSafeEntry.sourcePreview.permalink)
      ? { ...retentionSafeEntry, sourcePreview: removePermalink(retentionSafeEntry.sourcePreview) }
      : retentionSafeEntry
    return { ...projected, capabilities: createTriageCapabilities(projected) }
  }
  const sourcePreview = removePermalink(retentionSafeEntry.sourcePreview)
  const requester = removeRequesterContact(retentionSafeEntry.requester)
  if (retentionSafeEntry.permission.visibility === 'metadata-only') {
    const projected: TriageEntry = {
      ...retentionSafeEntry,
      sourcePreview: { ...sourcePreview, body: '' },
      requester,
    }
    return { ...projected, capabilities: createTriageCapabilities(projected) }
  }
  const restrictedPreview = removeChannelLabel(sourcePreview)
  const projected: TriageEntry = {
    ...retentionSafeEntry,
    sourcePreview: {
      ...restrictedPreview,
      title: 'Restricted source',
      body: '',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Restricted requester', guest: false },
    routing: { reason: 'Source access is unavailable.', candidates: [] },
    events: [],
  }
  return {
    ...projected,
    capabilities: createTriageCapabilities(projected, false),
  }
}

/** Redacts expired source content before a read or mutation consumes an entry.
 *
 * The scheduled retention worker persists an audit event and revision, but queue reads and
 * actions must remain safe while that worker is delayed or disabled. This boundary projection
 * intentionally preserves the current revision so a subsequent action can persist its own
 * revision-fenced update without exposing or copying expired content.
 *
 * @param entry The canonical entry to protect.
 * @param nowValue The ISO 8601 boundary evaluation instant.
 * @returns The original entry or a content-redacted detached projection.
 */
export function redactExpiredTriageEntry(
  entry: TriageEntry,
  nowValue: string,
): TriageEntry {
  const now = requireIsoInstant(nowValue, 'Triage retention evaluation time')
  const redactedAt = entry.retention.redactedAt
  if (!redactedAt && Date.parse(entry.retention.expiresAt) > Date.parse(now)) {
    return entry
  }
  const sourcePreview = removePermalink(entry.sourcePreview)
  const permission: TriageEntry['permission'] = {
    visibility: 'metadata-only',
    canReply: false,
    guestVisible: false,
    reasonCode: 'retention-expired',
    checkedAt: redactedAt ?? now,
  }
  return {
    ...entry,
    sourcePreview: {
      ...sourcePreview,
      title: 'Retained source',
      body: '',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: {
      displayName: 'Redacted requester',
      guest: entry.requester.guest,
    },
    permission,
    retention: { ...entry.retention, redactedAt: redactedAt ?? now },
    capabilities: createTriageCapabilities({
      ...entry,
      permission,
    }),
  }
}

/** Applies an authorized optimistic-concurrency action to an entry.
 *
 * @param entry The current canonical entry.
 * @param action The validated operator action.
 * @param context The authorized mutation context and resolved dependencies.
 * @returns The next canonical entry.
 */
export function applyTriageAction(
  entry: TriageEntry,
  action: TriageActionInput,
  context: ApplyTriageActionContext,
): TriageEntry {
  requireRevision(entry, action.expectedRevision)
  if (isTerminalTriageState(entry.state)) {
    throw new TriageError(409, 'TriageEntryTerminal', 'The triage entry is already resolved.')
  }
  if (entry.permission.visibility === 'denied') {
    throw new TriageError(
      409,
      'TriageSourceUnavailable',
      'The source permission must be restored before this entry can be changed.',
    )
  }
  const now = requireIsoInstant(context.now, 'Triage action time')
  const actorId = requireText(context.actorId, 'Triage actor ID', 160)
  let next: TriageEntry

  if (action.action === 'assign') {
    const ownerBase = action.ownerUserId === null
      ? withoutOwner(entry)
      : { ...entry, ownerUserId: normalizeTriageMemberKey(action.ownerUserId) }
    const assignmentBase = action.projectId === null
      ? withoutProject(ownerBase)
      : action.projectId === undefined
        ? ownerBase
        : { ...ownerBase, projectId: action.projectId }
    const event = createEvent(
      `assigned:${entry.revision + 1}:${now}`,
      'assigned',
      actorId,
      action.ownerUserId === null ? 'Triage entry was left unowned.' : 'Triage entry owner changed.',
      now,
    )
    next = {
      ...assignmentBase,
      events: appendEvent(entry.events, event),
      revision: entry.revision + 1,
      updatedAt: now,
    }
  } else if (action.action === 'snooze') {
    const until = requireIsoInstant(action.until, 'Triage snooze deadline')
    if (Date.parse(until) <= Date.parse(now)) {
      throw new TriageError(400, 'InvalidTriageAction', 'A snooze deadline must be in the future.')
    }
    next = transitionEntry(
      entry,
      'snoozed',
      createEvent(
        `snoozed:${entry.revision + 1}:${now}`,
        'snoozed',
        actorId,
        'Triage entry was snoozed.',
        now,
      ),
      now,
      { snoozedUntil: until },
    )
  } else if (action.action === 'request-information') {
    if (!entry.permission.canReply || entry.permission.visibility !== 'full') {
      throw new TriageError(
        409,
        'TriageReplyUnavailable',
        'The source does not currently permit a reply.',
      )
    }
    requireText(action.message, 'Information request', 8_000)
    next = transitionEntry(
      entry,
      'needs-information',
      createEvent(
        `information-requested:${entry.revision + 1}:${now}`,
        'information-requested',
        actorId,
        'Additional information was requested.',
        now,
      ),
      now,
    )
  } else if (action.action === 'decline') {
    const reason = requireText(action.reason, 'Decline reason', 2_000)
    next = transitionEntry(
      entry,
      'declined',
      createEvent(
        `declined:${entry.revision + 1}:${now}`,
        'declined',
        actorId,
        reason,
        now,
      ),
      now,
    )
  } else if (action.action === 'duplicate') {
    const canonicalWorkItem = requireCanonicalWorkItem(context.canonicalWorkItem)
    const mergeReceipt = context.mergeReceipt
    if (!mergeReceipt || mergeReceipt.canonicalWorkItemId !== canonicalWorkItem.workItemId) {
      throw new TriageError(
        409,
        'TriageMergeIncomplete',
        'Duplicate context must be retained before resolving the entry.',
      )
    }
    next = transitionEntry(
      entry,
      'duplicate',
      createEvent(
        `duplicate:${entry.revision + 1}:${now}`,
        'duplicate',
        actorId,
        'Triage entry was attached to its canonical Work Item.',
        now,
      ),
      now,
      { canonicalWorkItem, mergeReceipt },
    )
  } else {
    const canonicalWorkItem = requireCanonicalWorkItem(context.canonicalWorkItem)
    next = transitionEntry(
      entry,
      'accepted',
      createEvent(
        `${action.mode === 'create' ? 'accepted' : 'linked'}:${entry.revision + 1}:${now}`,
        action.mode === 'create' ? 'accepted' : 'linked',
        actorId,
        action.mode === 'create'
          ? 'Triage entry created a Work Item.'
          : 'Triage entry was linked to a Work Item.',
        now,
      ),
      now,
      { canonicalWorkItem },
    )
  }

  return { ...next, capabilities: createTriageCapabilities(next) }
}

/** Appends provider activity and resurfaces only snoozed or information-waiting entries.
 *
 * @param entry The current canonical entry.
 * @param activity The normalized provider activity.
 * @returns The next canonical entry, including terminal history without reopening it.
 */
export function recordTriageSourceActivity(
  entry: TriageEntry,
  activity: TriageSourceActivity,
): TriageEntry {
  const occurredAt = requireIsoInstant(activity.occurredAt, 'Triage activity time')
  const lastActivityAt = latestInstant(entry.lastActivityAt, occurredAt)
  const updatedAt = latestInstant(entry.updatedAt, occurredAt)
  const event = createEvent(
    requireText(activity.activityId, 'Triage activity ID', 200),
    'activity-received',
    requireText(activity.actorId, 'Triage activity actor ID', 160),
    requireText(activity.summary, 'Triage activity summary', 2_000),
    occurredAt,
  )
  const received = {
    ...entry,
    lastActivityAt,
    events: appendEvent(entry.events, event),
    revision: entry.revision + 1,
    updatedAt,
  }
  if (entry.state !== 'snoozed' && entry.state !== 'needs-information') {
    return { ...received, capabilities: createTriageCapabilities(received) }
  }
  const transitionAt = findCurrentWaitingTransitionAt(entry)
  if (Date.parse(occurredAt) <= Date.parse(transitionAt)) {
    return { ...received, capabilities: createTriageCapabilities(received) }
  }
  const withoutWake = removeSnooze(received)
  const resurfaced: TriageEntry = {
    ...withoutWake,
    state: 'pending',
    events: appendEvent(
      withoutWake.events,
      createEvent(
        `resurfaced:${withoutWake.revision}:${occurredAt}`,
        'resurfaced',
        activity.actorId,
        'New source activity returned the entry to the queue.',
        occurredAt,
      ),
    ),
  }
  return { ...resurfaced, capabilities: createTriageCapabilities(resurfaced) }
}

/** Finds the transition instant for the current source-waiting state.
 *
 * The transition event normally remains in the bounded history. Persisted entries whose
 * older transition event has already aged out use `updatedAt` as a conservative fallback
 * so delayed provider deliveries cannot reopen the entry without proof that they are new.
 *
 * @param entry The current snoozed or information-waiting entry.
 * @returns The latest matching transition instant, or the current update instant.
 */
function findCurrentWaitingTransitionAt(
  entry: Pick<TriageEntry, 'events' | 'state' | 'updatedAt'>,
): string {
  const transitionType = entry.state === 'snoozed'
    ? 'snoozed'
    : 'information-requested'
  for (let index = entry.events.length - 1; index >= 0; index -= 1) {
    const event = entry.events[index]
    if (event?.type === transitionType) return event.createdAt
  }
  return entry.updatedAt
}

/** Returns the later of two canonical ISO instants.
 *
 * @param first The first validated instant.
 * @param second The second validated instant.
 * @returns The chronologically later instant without changing its canonical representation.
 */
function latestInstant(first: string, second: string): string {
  return Date.parse(first) >= Date.parse(second) ? first : second
}

/** Normalizes a Workspace member key before it enters a Triage owner field.
 *
 * @param value The validated member identifier.
 * @returns The canonical lowercase member key.
 */
function normalizeTriageMemberKey(value: string): string {
  return value.trim().toLowerCase()
}

/** Evaluates snooze, SLA, and escalation deadlines at a schedule instant.
 *
 * @param entry The strongly read entry candidate.
 * @param nowValue The ISO 8601 schedule instant.
 * @returns The updated projection and which deadlines fired.
 */
export function evaluateTriageSchedule(
  entry: TriageEntry,
  nowValue: string,
): TriageScheduleEvaluation {
  const now = requireIsoInstant(nowValue, 'Triage schedule time')
  let next = entry
  let resurfaced = false
  let breached = false
  let escalated = false
  let redacted = false

  if (!next.retention.redactedAt && Date.parse(next.retention.expiresAt) <= Date.parse(now)) {
    const preview = removePermalink(next.sourcePreview)
    next = {
      ...next,
      sourcePreview: {
        ...preview,
        title: 'Retained source',
        body: '',
        attachmentCount: 0,
        commentCount: 0,
        watcherCount: 0,
        sanitized: true,
        truncated: false,
      },
      requester: {
        displayName: 'Redacted requester',
        guest: next.requester.guest,
      },
      permission: {
        visibility: 'metadata-only',
        canReply: false,
        guestVisible: false,
        reasonCode: 'retention-expired',
        checkedAt: now,
      },
      retention: { ...next.retention, redactedAt: now },
      events: appendEvent(
        next.events,
        createEvent(
          `retention-redacted:${next.revision + 1}:${now}`,
          'retention-redacted',
          'system:triage-schedule',
          'Retained source content was redacted.',
          now,
        ),
      ),
      revision: next.revision + 1,
      updatedAt: now,
    }
    redacted = true
  }

  if (isTerminalTriageState(next.state)) {
    return {
      entry: { ...next, capabilities: createTriageCapabilities(next) },
      resurfaced,
      breached,
      escalated,
      redacted,
    }
  }

  if (
    next.state === 'snoozed' &&
    next.snoozedUntil !== undefined &&
    Date.parse(next.snoozedUntil) <= Date.parse(now)
  ) {
    const withoutWake = removeSnooze(next)
    next = {
      ...withoutWake,
      state: 'pending',
      events: appendEvent(
        withoutWake.events,
        createEvent(
          `resurfaced:${withoutWake.revision + 1}:${now}`,
          'resurfaced',
          'system:triage-schedule',
          'The snooze deadline returned the entry to the queue.',
          now,
        ),
      ),
      revision: withoutWake.revision + 1,
      updatedAt: now,
    }
    resurfaced = true
  }

  const snoozeActive = next.state === 'snoozed'

  if (
    !snoozeActive &&
    next.sla &&
    !next.sla.breachedAt &&
    Date.parse(next.sla.dueAt) <= Date.parse(now)
  ) {
    next = {
      ...next,
      sla: { ...next.sla, breachedAt: now },
      events: appendEvent(
        next.events,
        createEvent(
          `sla-breached:${next.revision + 1}:${now}`,
          'sla-breached',
          'system:triage-schedule',
          'The triage response SLA was breached.',
          now,
        ),
      ),
      revision: next.revision + 1,
      updatedAt: now,
    }
    breached = true
  }

  if (
    !snoozeActive &&
    next.sla?.escalationDueAt &&
    !next.sla.escalatedAt &&
    Date.parse(next.sla.escalationDueAt) <= Date.parse(now)
  ) {
    next = {
      ...next,
      sla: { ...next.sla, escalatedAt: now },
      events: appendEvent(
        next.events,
        createEvent(
          `escalated:${next.revision + 1}:${now}`,
          'escalated',
          'system:triage-schedule',
          'The triage entry was escalated.',
          now,
        ),
      ),
      revision: next.revision + 1,
      updatedAt: now,
    }
    escalated = true
  }

  return {
    entry: { ...next, capabilities: createTriageCapabilities(next) },
    resurfaced,
    breached,
    escalated,
    redacted,
  }
}

/** Requires the viewed revision to match the canonical entry revision.
 *
 * @param entry The canonical entry.
 * @param expectedRevision The client-observed revision.
 */
function requireRevision(entry: TriageEntry, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TriageError(400, 'InvalidTriageAction', 'The expected revision is invalid.')
  }
  if (entry.revision !== expectedRevision) {
    throw new TriageError(409, 'TriageRevisionConflict', 'The triage entry changed.')
  }
}

/** Transitions an entry and removes stale snooze metadata.
 *
 * @param entry The current entry.
 * @param state The next lifecycle state.
 * @param event The immutable event projection.
 * @param now The mutation instant.
 * @param additions State-specific fields to add.
 * @returns The next entry before capability recomputation.
 */
function transitionEntry(
  entry: TriageEntry,
  state: TriageEntryState,
  event: TriageEntryEvent,
  now: string,
  additions: Partial<Pick<TriageEntry, 'snoozedUntil' | 'canonicalWorkItem' | 'mergeReceipt'>> = {},
): TriageEntry {
  const base = state === 'snoozed' ? entry : removeSnooze(entry)
  return {
    ...base,
    ...additions,
    state,
    events: appendEvent(base.events, event),
    revision: entry.revision + 1,
    updatedAt: now,
  }
}

/** Removes the owner field without assigning undefined.
 *
 * @param entry The source entry.
 * @returns A partial entry without an owner.
 */
function withoutOwner(entry: TriageEntry): Omit<TriageEntry, 'ownerUserId'> {
  const { ownerUserId: _ownerUserId, ...remaining } = entry
  return remaining
}

/** Removes the project field without assigning undefined.
 *
 * @param entry The source entry.
 * @returns A partial entry without a project.
 */
function withoutProject(entry: TriageEntry): Omit<TriageEntry, 'projectId'> {
  const { projectId: _projectId, ...remaining } = entry
  return remaining
}

/** Removes the snooze deadline from an entry.
 *
 * @param entry The source entry.
 * @returns The entry without a snooze deadline.
 */
function removeSnooze(entry: TriageEntry): TriageEntry {
  const { snoozedUntil: _snoozedUntil, ...remaining } = entry
  return remaining
}

/** Removes a permission-sensitive source permalink.
 *
 * @param preview The current source preview.
 * @returns The preview without its permalink.
 */
function removePermalink(
  preview: TriageEntry['sourcePreview'],
): Omit<TriageEntry['sourcePreview'], 'permalink'> {
  const { permalink: _permalink, ...remaining } = preview
  return remaining
}

/** Removes requester contact and provider identity fields.
 *
 * @param requester The current requester projection.
 * @returns The requester display projection without contact fields.
 */
function removeRequesterContact(
  requester: TriageEntry['requester'],
): Pick<TriageEntry['requester'], 'displayName' | 'guest'> {
  return { displayName: requester.displayName, guest: requester.guest }
}

/** Removes a provider-facing channel label from a restricted preview.
 *
 * @param preview The preview after permalink removal.
 * @returns The preview without its provider-facing label.
 */
function removeChannelLabel(
  preview: Omit<TriageEntry['sourcePreview'], 'permalink'>,
): Omit<TriageEntry['sourcePreview'], 'permalink' | 'channelLabel'> {
  const { channelLabel: _channelLabel, ...remaining } = preview
  return remaining
}

/** Checks whether a response permalink is a bounded credential-free HTTPS URL.
 *
 * @param value The stored URL candidate.
 * @returns Whether the URL may be included in an API response.
 */
function isSafeHttpsUrl(value: string): boolean {
  if (value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Requires a resolved canonical Work Item.
 *
 * @param value The optional resolved reference.
 * @returns The required reference.
 */
function requireCanonicalWorkItem(
  value: TriageWorkItemReference | undefined,
): TriageWorkItemReference {
  if (!value) {
    throw new TriageError(
      409,
      'TriageWorkItemUnresolved',
      'A canonical Work Item must be resolved before this action.',
    )
  }
  return value
}

/** Appends one event while retaining a bounded recent projection.
 *
 * @param current Existing event projection.
 * @param event Event to append.
 * @returns The bounded event projection.
 */
function appendEvent(
  current: readonly TriageEntryEvent[],
  event: TriageEntryEvent,
): TriageEntryEvent[] {
  const next = [...current, event]
  return next.length <= TRIAGE_ENTRY_EVENT_LIMIT
    ? next
    : next.slice(next.length - TRIAGE_ENTRY_EVENT_LIMIT)
}

/** Creates a normalized event projection.
 *
 * @param id The stable event ID.
 * @param type The event type.
 * @param actorId The stable actor ID.
 * @param summary The safe event summary.
 * @param createdAt The event instant.
 * @returns The canonical event.
 */
function createEvent(
  id: string,
  type: TriageEntryEvent['type'],
  actorId: string,
  summary: string,
  createdAt: string,
): TriageEntryEvent {
  return { id, type, actorId, summary, createdAt }
}

/** Requires a bounded non-empty text value.
 *
 * @param value The value to validate.
 * @param label The error label.
 * @param maximumLength The maximum number of UTF-16 code units.
 * @returns The normalized text.
 */
function requireText(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return normalized
}

/** Requires a parseable ISO-style instant.
 *
 * @param value The instant to validate.
 * @param label The error label.
 * @returns The normalized ISO 8601 instant.
 */
function requireIsoInstant(value: string, label: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return parsed.toISOString()
}
