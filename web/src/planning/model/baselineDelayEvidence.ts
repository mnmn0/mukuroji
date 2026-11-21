import {
  countWorkItemCalendarDaysBetween,
  deriveWorkItemBaselineEndDelayDays,
  type PlanningSnapshot,
  type PlanningUpdateEvidence,
} from '@mukuroji/contracts'
import type { WorkItemBaselineLookup } from '../../work-items/model/workItemScheduleBaselines'
import {
  planningEvidenceScopeMatchesTarget,
  type PlanningUpdateTargetView,
} from './statusUpdateView'

/** Most evidence one Planning update may cite, matching the server limit. */
export const PLANNING_UPDATE_EVIDENCE_LIMIT = 100

/** One delayed Work Item or Milestone offered as Planning update evidence. */
export type PlanningBaselineDelayCandidate = {
  /** Stable key within the list. */
  key: string
  /** Whether the record is a Work Item or a Milestone. */
  kind: 'work-item' | 'milestone'
  /** Work Item or Milestone title. */
  title: string
  /** Calendar days the record ends behind its baseline; always positive. */
  delayDays: number
  /** Whether the previous update of the target already cited this record. */
  reportedBefore: boolean
  /** Typed evidence the record is attached as. */
  evidence: PlanningUpdateEvidence
}

/** Work Items in scope that the delay list reads baselines for. */
export type PlanningBaselineScopeWorkItem = {
  /** Work Item ID. */
  id: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Project the Work Item is assigned to. */
  assignedProjectId?: string
}

/**
 * Lists the Work Items of the snapshot inside the selected update target, in the shape the
 * baseline reader takes.
 *
 * @param snapshot - Authorized Planning snapshot.
 * @param target - Selected Project or Initiative.
 * @returns Work Items in the target scope.
 */
export function listPlanningTargetBaselineWorkItems(
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTargetView,
): PlanningBaselineScopeWorkItem[] {
  const initiative = resolveInitiative(snapshot, target)
  return snapshot.workItems
    .filter((workItem) => planningEvidenceScopeMatchesTarget(workItem, target, initiative))
    .map((workItem) => ({
      id: workItem.id,
      teamId: workItem.teamId,
      ...(workItem.projectId === undefined ? {} : { assignedProjectId: workItem.projectId }),
    }))
}

/**
 * Lists what ends behind its baseline in the selected update target: open Work Items whose
 * planned end is later than the active baseline of their Project, and Milestones whose forecast
 * end is later than their baseline end. The most delayed come first.
 *
 * Completed Work Items are left out because the Planning snapshot has no actual end dates, and
 * canceled ones never count as delayed.
 *
 * @param snapshot - Authorized Planning snapshot.
 * @param target - Selected Project or Initiative.
 * @param baselineFor - Active baseline entry of each Work Item.
 * @param previousEvidence - Evidence the previous update of the target cited.
 * @returns The delayed records.
 */
export function createPlanningBaselineDelayCandidates(
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTargetView,
  baselineFor: WorkItemBaselineLookup,
  previousEvidence: readonly PlanningUpdateEvidence[],
): PlanningBaselineDelayCandidate[] {
  const initiative = resolveInitiative(snapshot, target)
  const reported = new Set(previousEvidence.map(evidenceKey))
  const candidates: PlanningBaselineDelayCandidate[] = []
  for (const workItem of snapshot.workItems) {
    if (!planningEvidenceScopeMatchesTarget(workItem, target, initiative)) continue
    if (workItem.statusCategory === 'completed') continue
    const entry = baselineFor({
      id: workItem.id,
      teamId: workItem.teamId,
      ...(workItem.projectId === undefined ? {} : { assignedProjectId: workItem.projectId }),
    })
    if (!entry) continue
    const delayDays = deriveWorkItemBaselineEndDelayDays(entry, workItem)
    if (delayDays === undefined || delayDays <= 0) continue
    const evidence: PlanningUpdateEvidence = { type: 'work-item', teamId: workItem.teamId, workItemId: workItem.id }
    candidates.push({
      key: evidenceKey(evidence),
      kind: 'work-item',
      title: workItem.title,
      delayDays,
      reportedBefore: reported.has(evidenceKey(evidence)),
      evidence,
    })
  }
  for (const entity of snapshot.entities) {
    if (entity.type !== 'milestone' || entity.archivedAt) continue
    if (entity.status === 'completed' || entity.status === 'canceled') continue
    if (!planningEvidenceScopeMatchesTarget(entity, target, initiative)) continue
    const delayDays = countWorkItemCalendarDaysBetween(entity.baseline.endDate, entity.forecast.endDate)
    if (delayDays === undefined || delayDays <= 0) continue
    const evidence: PlanningUpdateEvidence = { type: 'planning-entity', entityId: entity.id }
    candidates.push({
      key: evidenceKey(evidence),
      kind: 'milestone',
      title: entity.title,
      delayDays,
      reportedBefore: reported.has(evidenceKey(evidence)),
      evidence,
    })
  }
  return candidates.sort((first, second) =>
    second.delayDays - first.delayDays || first.title.localeCompare(second.title) || first.key.localeCompare(second.key))
}

/**
 * Merges attached and manually chosen evidence, keeping the first copy of each reference.
 *
 * @param groups - Evidence lists in priority order.
 * @returns The merged list.
 */
export function mergePlanningUpdateEvidence(
  ...groups: readonly (readonly PlanningUpdateEvidence[])[]
): PlanningUpdateEvidence[] {
  const seen = new Set<string>()
  const merged: PlanningUpdateEvidence[] = []
  for (const evidence of groups.flat()) {
    const key = evidenceKey(evidence)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(evidence)
  }
  return merged
}

/**
 * Builds a key that is equal for two references to the same record.
 *
 * @param evidence - Typed evidence.
 * @returns The key.
 */
export function evidenceKey(evidence: PlanningUpdateEvidence): string {
  switch (evidence.type) {
    case 'work-item':
      return JSON.stringify(['work-item', evidence.teamId, evidence.workItemId])
    case 'planning-entity':
      return JSON.stringify(['planning-entity', evidence.entityId])
    case 'file':
      return JSON.stringify(['file', evidence.fileId])
    case 'link':
      return JSON.stringify(['link', evidence.url])
  }
}

/**
 * Finds the Initiative entity of an Initiative target.
 *
 * @param snapshot - Planning snapshot.
 * @param target - Selected target.
 * @returns The Initiative, or undefined for a Project target or a missing Initiative.
 */
function resolveInitiative(snapshot: PlanningSnapshot, target: PlanningUpdateTargetView) {
  return target.type === 'initiative'
    ? snapshot.entities.find((entity) => entity.id === target.entityId && entity.type === 'initiative')
    : undefined
}
