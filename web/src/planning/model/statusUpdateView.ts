import type {
  PlanningHealth,
  PlanningLatestUpdateSummary,
  PlanningUpdate,
  PlanningUpdateCadence,
  PlanningUpdateChange,
  PlanningUpdateEvidence,
  PlanningUpdateScopeSnapshot,
  PlanningUpdateState,
  PlanningUpdateTarget,
  PlanningUpdateTargetSummary,
  PlanningRisk,
  PlanningSnapshot,
  PublishPlanningUpdateInput,
} from '@mukuroji/contracts'
import { PLANNING_UPDATE_CONTENT_VERSION } from '@mukuroji/contracts'
import {
  createPlanningDependencyPath,
  createPlanningPath,
  createTeamIssuesPath,
} from '../../shared/routing/paths'

/** Delivery state of the latest manual planning update. */
export type PlanningUpdateFreshness = PlanningUpdateState

/** Evidence link displayed with one immutable status update. */
export type PlanningUpdateEvidenceView = {
  /** Stable evidence identifier within the update. */
  id: string
  /** Human-readable evidence label. */
  label: string
  /** Same-origin or HTTPS destination supplied by the update author. */
  url?: string
}

/** Canonical Work Item choice exposed by the structured update composer. */
export type PlanningUpdateWorkItemEvidenceCandidate = {
  /** Stable form value scoped by Team and Work Item identity. */
  value: string
  /** Human-readable Work Item title and ID. */
  label: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local canonical Work Item identifier. */
  workItemId: string
}

/** Canonical Planning entity choice exposed by the structured update composer. */
export type PlanningUpdateEntityEvidenceCandidate = {
  /** Stable Planning entity identifier submitted by the form. */
  value: string
  /** Human-readable Planning entity title and ID. */
  label: string
  /** Workspace-local Planning entity identifier. */
  entityId: string
}

/** Canonical evidence choices visible within the selected update target. */
export type PlanningUpdateEvidenceCandidates = {
  /** Work Items visible in the selected target scope. */
  workItems: readonly PlanningUpdateWorkItemEvidenceCandidate[]
  /** Planning entities visible in the selected target scope. */
  planningEntities: readonly PlanningUpdateEntityEvidenceCandidate[]
}

/**
 * Creates a DOM-safe, collision-free value for a Team-qualified Work Item option.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item identifier.
 * @returns JSON tuple suitable for an HTML option value.
 */
export function createPlanningUpdateWorkItemEvidenceValue(
  teamId: string,
  workItemId: string,
) {
  return JSON.stringify([teamId, workItemId])
}

/**
 * Creates canonical evidence choices within one selected update target scope.
 *
 * @param snapshot - Authorized Planning snapshot containing visible canonical records.
 * @param target - Project or Initiative whose composer is open.
 * @returns Work Item and Planning entity choices suitable for typed evidence selectors.
 */
export function createPlanningUpdateEvidenceCandidates(
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTargetView,
): PlanningUpdateEvidenceCandidates {
  const initiative = target.type === 'initiative'
    ? snapshot.entities.find((entity) => entity.id === target.entityId && entity.type === 'initiative')
    : undefined

  return {
    planningEntities: snapshot.entities
      .filter((entity) =>
        !entity.archivedAt && planningEvidenceScopeMatchesTarget(entity, target, initiative))
      .map((entity) => ({
        entityId: entity.id,
        label: `${entity.title} · ${entity.id}`,
        value: entity.id,
      })),
    workItems: snapshot.workItems
      .filter((workItem) => planningEvidenceScopeMatchesTarget(workItem, target, initiative))
      .map((workItem) => ({
        label: `${workItem.title} · ${workItem.id}`,
        teamId: workItem.teamId,
        value: createPlanningUpdateWorkItemEvidenceValue(workItem.teamId, workItem.id),
        workItemId: workItem.id,
      })),
  }
}

/**
 * Applies the selected target's canonical visibility envelope to one scoped record.
 *
 * @param scope - Team and optional Project scope of a visible record.
 * @param target - Selected Project or Initiative target.
 * @param initiative - Initiative entity resolved for an Initiative target.
 * @returns Whether the record belongs to the exact authorized target envelope.
 */
function planningEvidenceScopeMatchesTarget(
  scope: { teamId?: string; projectId?: string },
  target: PlanningUpdateTargetView,
  initiative: PlanningSnapshot['entities'][number] | undefined,
) {
  if (target.type === 'project') {
    return scope.teamId === target.teamId && scope.projectId === target.projectId
  }
  if (!initiative) return false
  if (initiative.projectId) {
    return scope.teamId === initiative.teamId && scope.projectId === initiative.projectId
  }
  if (initiative.teamId) {
    return scope.teamId === initiative.teamId && scope.projectId === undefined
  }
  return true
}

/**
 * Reads the evidence discriminator selected by the structured composer.
 *
 * @param value - Raw select value.
 * @returns A supported evidence discriminator or the no-evidence fallback.
 */
export function readPlanningUpdateEvidenceType(
  value: string,
): PlanningUpdateEvidence['type'] | 'none' {
  if (
    value === 'work-item' || value === 'planning-entity' ||
    value === 'decision' || value === 'file' || value === 'link'
  ) {
    return value
  }
  return 'none'
}

/**
 * Converts typed composer fields into one contract-valid evidence entry.
 *
 * @param data - Submitted structured update form data.
 * @param candidates - Canonical choices visible in the selected target scope.
 * @returns Zero or one evidence entries, or undefined when submitted fields are invalid.
 */
export function readPlanningUpdateEvidence(
  data: FormData,
  candidates: PlanningUpdateEvidenceCandidates,
): PlanningUpdateEvidence[] | undefined {
  const evidenceType = readPlanningUpdateEvidenceType(
    String(data.get('evidenceType') ?? ''),
  )
  if (evidenceType === 'none') return []
  if (evidenceType === 'work-item') {
    const selectedValue = String(data.get('evidenceWorkItem') ?? '')
    const candidate = candidates.workItems.find((item) => item.value === selectedValue)
    return candidate
      ? [{ type: 'work-item', teamId: candidate.teamId, workItemId: candidate.workItemId }]
      : undefined
  }
  if (evidenceType === 'planning-entity') {
    const selectedValue = String(data.get('evidencePlanningEntity') ?? '')
    const candidate = candidates.planningEntities.find((item) => item.value === selectedValue)
    return candidate ? [{ type: 'planning-entity', entityId: candidate.entityId }] : undefined
  }
  if (evidenceType === 'decision') {
    const decisionId = String(data.get('evidenceDecisionId') ?? '').trim()
    const url = readPlanningEvidenceHttpsUrl(data.get('evidenceDecisionUrl'))
    return decisionId && url ? [{ type: 'decision', decisionId, url }] : undefined
  }
  if (evidenceType === 'file') {
    const fileId = String(data.get('evidenceFileId') ?? '').trim()
    const url = readPlanningEvidenceHttpsUrl(data.get('evidenceFileUrl'))
    return fileId && url ? [{ type: 'file', fileId, url }] : undefined
  }
  const url = readPlanningEvidenceHttpsUrl(data.get('evidenceUrl'))
  if (!url) return undefined
  const label = String(data.get('evidenceLabel') ?? '').trim()
  return [{
    ...(label ? { label } : {}),
    type: 'link',
    url,
  }]
}

/**
 * Accepts only absolute HTTPS permalinks from evidence form fields.
 *
 * @param value - Raw URL form value.
 * @returns Normalized HTTPS URL or undefined when invalid.
 */
export function readPlanningEvidenceHttpsUrl(
  value: FormDataEntryValue | null,
) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Clears one comment form only after its append-only mutation succeeds.
 *
 * @param submit - Comment mutation supplied by the production controller.
 * @param updateId - Immutable update identifier receiving the comment.
 * @param bodyMarkdown - Validated non-empty comment body.
 * @param reset - Form reset action to invoke after successful persistence.
 * @returns A promise that rejects without resetting when persistence fails.
 */
export async function submitPlanningUpdateCommentAndReset(
  submit: NonNullable<PlanningUpdateCollaborationController['onAddComment']>,
  updateId: string,
  bodyMarkdown: string,
  reset: () => void,
) {
  await submit(updateId, bodyMarkdown)
  reset()
}

/** Planning fields whose value can be compared with the previous update. */
export type PlanningUpdateChangeField =
  | 'health'
  | 'risk'
  | 'progress'
  | 'milestones'
  | 'dependencies'
  | 'scope'
  | 'target-date'

/** One immutable before-and-after value captured by a published update. */
export type PlanningUpdateChangeView = {
  /** Stable change identifier within the update. */
  id: string
  /** Planning field represented by the comparison. */
  field: PlanningUpdateChangeField
  /** Value captured by the previous published update. */
  previousValue: string
  /** Value captured by the current published update. */
  currentValue: string
  /** Optional same-origin destination for the changed canonical record. */
  url?: string
}

/** Aggregated reaction displayed below a published update. */
export type PlanningUpdateReactionView = {
  /** Emoji or short reaction token. */
  reaction: string
  /** Number of members who added the reaction. */
  count: number
  /** Whether the current viewer added this reaction. */
  reactedByViewer?: boolean
}

/** One immutable-update discussion comment displayed by the ledger. */
export type PlanningUpdateCommentView = {
  /** Stable comment identifier. */
  id: string
  /** Published update that owns the discussion. */
  updateId: string
  /** Workspace member key of the comment author. */
  authorMemberKey: string
  /** Human-authored Markdown source displayed as plain text in the compact ledger. */
  bodyMarkdown: string
  /** Comment creation time as an ISO 8601 timestamp. */
  createdAt: string
}

/** Watcher state displayed in the selected update target header. */
export type PlanningUpdateWatchView = {
  /** Whether the current viewer receives update notifications. */
  subscribed: boolean
  /** Number of unique target watchers. */
  watcherCount: number
}

/** Collaboration and export actions attached to a selected update target. */
export type PlanningUpdateCollaborationController = {
  /** Optional current viewer watcher state. */
  watch?: PlanningUpdateWatchView
  /** Comments grouped by immutable update ID. */
  commentsByUpdateId: Readonly<Record<string, readonly PlanningUpdateCommentView[]>>
  /** Reactions grouped by immutable update ID. */
  reactionsByUpdateId: Readonly<Record<string, readonly PlanningUpdateReactionView[]>>
  /** Whether a collaboration or export mutation is pending. */
  isPending: boolean
  /** Whether watcher and annotation state is loading. */
  isLoading: boolean
  /** Optional recoverable collaboration query or mutation error. */
  errorMessage?: string
  /** Retries the selected target collaboration query. */
  onRetry?: () => void
  /** Toggles current-viewer target watching. */
  onToggleWatch?: () => void | Promise<void>
  /** Exports all immutable history for the selected target. */
  onExport?: () => void | Promise<void>
  /** Adds a comment to one immutable update. */
  onAddComment?: (updateId: string, bodyMarkdown: string) => void | Promise<void>
  /** Toggles one supported reaction on an immutable update. */
  onToggleReaction?: (updateId: string, reaction: string) => void | Promise<void>
}

/** Immutable published planning update rendered by the history ledger. */
export type PlanningStatusUpdateView = {
  /** Stable update identifier. */
  id: string
  /** Target-local immutable update version used by annotation APIs. */
  version: number
  /** Contract version used when the update was published. */
  schemaVersion: number
  /** Workspace member key of the author. */
  authorMemberKey: string
  /** Publication time as an ISO 8601 timestamp. */
  createdAt: string
  /** Explicit health reported at publication time. */
  health: PlanningHealth
  /** Concise update summary. */
  summary: string
  /** Optional narrative describing current risk. */
  riskSummary?: string
  /** Optional structured risk severity retained for legacy updates. */
  risk?: PlanningRisk
  /** Server-captured progress value at publication time. */
  progressPercent?: number
  /** Optional decision recorded by the author. */
  decisionSummary?: string
  /** Optional request for support. */
  helpNeeded?: string
  /** Explicit next action. */
  nextAction?: string
  /** Evidence links attached at publication time. */
  evidence: readonly PlanningUpdateEvidenceView[]
  /** Before-and-after planning changes captured at publication time. */
  changes: readonly PlanningUpdateChangeView[]
  /** Number of comments attached to the update. */
  commentCount: number
  /** Aggregated reactions attached to the update. */
  reactions: readonly PlanningUpdateReactionView[]
}

/** Recurring manual-update configuration displayed in the detail pane. */
export type PlanningUpdateCadenceView = PlanningUpdateCadence

/** Project or initiative that owns a recurring health update. */
export type PlanningUpdateTargetView = PlanningUpdateTarget

/** Display metadata for a Project or Initiative update target. */
export type PlanningUpdateTargetSummaryView = {
  /** Canonical target identity. */
  target: PlanningUpdateTargetView
  /** Human-readable target title. */
  title: string
  /** Optional Team or hierarchy context. */
  context?: string
  /** Current target owner used as the initial update owner. */
  ownerMemberKey: string
  /** Current target health, independent from update freshness. */
  health: PlanningHealth
  /** Current progress displayed in the composer snapshot. */
  progress: number
}

/** Update projection rendered for one Project or Initiative target. */
export type PlanningTargetUpdateView = {
  /** Project or Initiative that owns this update stream. */
  target: PlanningUpdateTargetView
  /** Delivery state kept separate from planning health. */
  freshness: PlanningUpdateFreshness
  /** Optional recurring update configuration. */
  cadence?: PlanningUpdateCadenceView
  /** Published updates ordered from newest to oldest. */
  updates: readonly PlanningStatusUpdateView[]
}

/** Complete detail-pane projection for one update target. */
export type PlanningUpdateTargetDetailView = {
  /** Display metadata for the selected target. */
  summary: PlanningUpdateTargetSummaryView
  /** Cadence, freshness, and immutable published updates. */
  updateView: PlanningTargetUpdateView
}

/** Editable cadence values submitted by the update schedule form, or null to clear it. */
export type PlanningUpdateCadenceDraft = PlanningUpdateCadence | null

/** Manual update fields submitted by the structured composer. */
export type PlanningStatusUpdateDraft = Omit<
  PublishPlanningUpdateInput,
  'expectedRevision' | 'id' | 'target'
>

/**
 * Returns the newest published update in a projection.
 *
 * @param view - Update projection for one Project or Initiative.
 * @returns The newest update, or undefined when no update has been published.
 */
export function resolveLatestPlanningStatusUpdate(view: PlanningTargetUpdateView) {
  return view.updates[0]
}

/**
 * Creates the pre-contract fallback projection used by legacy snapshots.
 *
 * @param target - Canonical Project or Initiative identity.
 * @returns A projection that makes the missing-update state explicit.
 */
export function createMissingPlanningTargetUpdateView(
  target: PlanningUpdateTargetView,
): PlanningTargetUpdateView {
  return {
    freshness: 'not-configured',
    target,
    updates: [],
  }
}

/**
 * Adapts one bounded target summary and optional full history to the UI projection.
 *
 * @param summary - Snapshot summary containing cadence, freshness, and latest pointer.
 * @param updates - Optional immutable history ordered from newest to oldest.
 * @returns A target update projection suitable for list and detail views.
 */
export function createPlanningTargetUpdateView(
  summary: PlanningUpdateTargetSummary,
  updates: readonly PlanningUpdate[] = [],
): PlanningTargetUpdateView {
  const resolvedUpdates = updates.length > 0
    ? updates.map(createPlanningStatusUpdateView)
    : summary.latestUpdate
      ? [createPlanningStatusUpdateView(summary.latestUpdate)]
      : []

  return {
    cadence: summary.cadence,
    freshness: summary.updateState,
    target: summary.target,
    updates: resolvedUpdates,
  }
}

/**
 * Compares canonical Project or Initiative target identities.
 *
 * @param left - First target identity.
 * @param right - Second target identity.
 * @returns True when both values identify the same target.
 */
export function planningUpdateTargetsAreEqual(
  left: PlanningUpdateTargetView,
  right: PlanningUpdateTargetView,
) {
  if (left.type !== right.type) return false
  if (left.type === 'initiative' && right.type === 'initiative') {
    return left.entityId === right.entityId
  }
  if (left.type === 'project' && right.type === 'project') {
    return left.teamId === right.teamId && left.projectId === right.projectId
  }
  return false
}

/**
 * Adapts a full immutable update or bounded latest summary to one ledger row.
 *
 * @param update - Full history value or snapshot latest summary.
 * @returns A normalized update row for the presentation layer.
 */
function createPlanningStatusUpdateView(
  update: PlanningUpdate | PlanningLatestUpdateSummary,
): PlanningStatusUpdateView {
  const isFullUpdate = 'contentVersion' in update

  return {
    authorMemberKey: update.authorMemberKey,
    changes: isFullUpdate
      ? update.changes.map((change, index) => createPlanningUpdateChangeView(change, index))
      : [],
    commentCount: 0,
    createdAt: update.createdAt,
    decisionSummary: isFullUpdate ? update.decisionSummary : undefined,
    evidence: isFullUpdate
      ? update.evidence.map((evidence, index) =>
          createPlanningUpdateEvidenceView(update.id, evidence, index))
      : [],
    health: update.health,
    helpNeeded: isFullUpdate ? update.helpNeeded : undefined,
    id: update.id,
    nextAction: isFullUpdate ? update.nextAction : undefined,
    progressPercent: update.progressSnapshot.percent,
    reactions: [],
    risk: update.risk,
    riskSummary: isFullUpdate ? update.riskSummary : undefined,
    schemaVersion: isFullUpdate
      ? update.contentVersion
      : PLANNING_UPDATE_CONTENT_VERSION,
    summary: update.summary,
    version: update.version,
  }
}

/**
 * Adapts typed evidence to a label and navigable destination where available.
 *
 * @param updateId - Parent update ID used to create a stable row key.
 * @param evidence - Typed canonical evidence reference.
 * @param index - Evidence position within the immutable update.
 * @returns Evidence presentation value.
 */
function createPlanningUpdateEvidenceView(
  updateId: string,
  evidence: PlanningUpdateEvidence,
  index: number,
): PlanningUpdateEvidenceView {
  const id = `${updateId}:evidence:${index}`
  switch (evidence.type) {
    case 'work-item':
      return {
        id,
        label: evidence.workItemId,
        url: createTeamIssuesPath(evidence.teamId, evidence.workItemId),
      }
    case 'planning-entity':
      return {
        id,
        label: evidence.entityId,
        url: `/planning/roadmap?entityId=${encodeURIComponent(evidence.entityId)}`,
      }
    case 'decision':
      return { id, label: `Decision · ${evidence.decisionId}`, url: evidence.url }
    case 'file':
      return { id, label: `File · ${evidence.fileId}`, url: evidence.url }
    case 'link':
      return { id, label: evidence.label ?? evidence.url, url: evidence.url }
  }
}

/**
 * Converts one typed immutable comparison to two concise display values.
 *
 * @param change - Server-derived change between immutable context snapshots.
 * @param index - Change position within the update.
 * @returns Presentation value for the comparison ledger.
 */
function createPlanningUpdateChangeView(
  change: PlanningUpdateChange,
  index: number,
): PlanningUpdateChangeView {
  switch (change.type) {
    case 'health':
    case 'risk':
    case 'progress':
    case 'target-date':
      return {
        currentValue: String(change.after ?? '—'),
        field: change.type,
        id: `${change.type}:${index}`,
        previousValue: String(change.before ?? '—'),
      }
    case 'scope':
      return {
        currentValue: formatPlanningUpdateScope(change.after),
        field: change.type,
        id: `${change.type}:${index}`,
        previousValue: formatPlanningUpdateScope(change.before),
      }
    case 'milestones':
    case 'dependencies': {
      const navigableId = change.addedIds[0] ?? change.changedIds[0]
      return {
        currentValue: formatPlanningUpdateCollectionChanges(
          change.addedIds,
          change.changedIds,
        ),
        field: change.type,
        id: `${change.type}:${index}`,
        previousValue: change.removedIds.length > 0 ? change.removedIds.join(', ') : '—',
        ...(navigableId
          ? {
              url: change.type === 'dependencies'
                ? createPlanningDependencyPath(navigableId)
                : createPlanningPath('timeline', navigableId),
            }
          : {}),
      }
    }
  }
}

/**
 * Formats one captured Team and Project scope.
 *
 * @param scope - Immutable scope snapshot.
 * @returns A concise Team/Project identity.
 */
function formatPlanningUpdateScope(scope: PlanningUpdateScopeSnapshot) {
  return [scope.teamId, scope.projectId].filter(Boolean).join(' / ') || '—'
}

/**
 * Formats additions and in-place changes from a collection comparison.
 *
 * @param addedIds - Canonical IDs added in the latest update.
 * @param changedIds - Canonical IDs whose snapshot changed in place.
 * @returns A concise comma-separated value.
 */
function formatPlanningUpdateCollectionChanges(
  addedIds: readonly string[],
  changedIds: readonly string[],
) {
  return [...addedIds, ...changedIds].join(', ') || '—'
}
