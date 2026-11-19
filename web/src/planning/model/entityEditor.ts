import type {
  PlanningEntity,
  PlanningEntityPatch,
  PlanningEntityStatus,
  PlanningHealth,
  PlanningProgressMode,
  PlanningRisk,
} from '@mukuroji/contracts'

/** Lifecycle statuses the entity editor offers, in display order. */
export const planningEntityStatusOptions: readonly PlanningEntityStatus[] = [
  'proposed',
  'planned',
  'active',
  'paused',
  'completed',
  'canceled',
]

/** Health values the entity editor offers, in display order. */
export const planningHealthOptions: readonly PlanningHealth[] = [
  'unknown',
  'on-track',
  'at-risk',
  'off-track',
]

/** Risk levels the entity editor offers, in display order. */
export const planningRiskOptions: readonly PlanningRisk[] = [
  'none',
  'low',
  'medium',
  'high',
  'critical',
]

/** Progress modes the entity editor offers, in display order. */
export const planningProgressModeOptions: readonly PlanningProgressMode[] = [
  'automatic',
  'manual',
]

/** Editable form values for one Planning entity, kept as strings the way inputs report them. */
export type PlanningEntityEditorDraft = {
  /** Entity title before trimming. */
  title: string
  /** Entity description; an empty value removes a stored description. */
  description: string
  /** Owner Workspace member key before trimming. */
  ownerMemberKey: string
  /** Lifecycle status. */
  status: PlanningEntityStatus
  /** Health the owner reports for the entity itself. */
  health: PlanningHealth
  /** Risk level the owner reports. */
  risk: PlanningRisk
  /** Whether progress is rolled up from Work Items or entered by hand. */
  progressMode: PlanningProgressMode
  /** Manual progress percentage as typed. */
  manualProgress: string
  /** Baseline start date (`YYYY-MM-DD`). Ignored for Milestones, which use the end date. */
  baselineStart: string
  /** Baseline end date (`YYYY-MM-DD`). */
  baselineEnd: string
  /** Forecast start date (`YYYY-MM-DD`). Ignored for Milestones, which use the end date. */
  forecastStart: string
  /** Forecast end date (`YYYY-MM-DD`). */
  forecastEnd: string
}

/** Why a draft cannot be saved. */
export type PlanningEntityEditorProblem =
  | 'title-required'
  | 'owner-required'
  | 'date-required'
  | 'date-range'
  | 'manual-progress'

/** Result of comparing a draft with the stored entity. */
export type PlanningEntityEditResult =
  | {
      /** The draft changes at least one field. */
      kind: 'patch'
      /** Only the fields that differ from the stored entity. */
      patch: PlanningEntityPatch
    }
  | {
      /** The draft matches the stored entity. */
      kind: 'unchanged'
    }
  | {
      /** The draft cannot be saved as it is. */
      kind: 'invalid'
      /** The first problem found. */
      problem: PlanningEntityEditorProblem
    }

/**
 * Creates the editor's initial values from a stored entity.
 *
 * @param entity - Planning entity being edited.
 * @returns Form values that reproduce the stored entity.
 */
export function createPlanningEntityEditorDraft(entity: PlanningEntity): PlanningEntityEditorDraft {
  return {
    title: entity.title,
    description: entity.description ?? '',
    ownerMemberKey: entity.ownerMemberKey,
    status: entity.status,
    health: entity.health,
    risk: entity.risk,
    progressMode: entity.progressMode,
    manualProgress: entity.manualProgress === undefined ? '' : String(entity.manualProgress),
    baselineStart: entity.baseline.startDate,
    baselineEnd: entity.baseline.endDate,
    forecastStart: entity.forecast.startDate,
    forecastEnd: entity.forecast.endDate,
  }
}

/**
 * Validates a draft and returns a patch holding only the fields that changed.
 *
 * Milestones are single-day entities, so their start dates follow their end dates.
 *
 * @param entity - Stored entity the draft started from.
 * @param draft - Current form values.
 * @returns The patch to send, `unchanged`, or the first validation problem.
 */
export function resolvePlanningEntityEdit(
  entity: PlanningEntity,
  draft: PlanningEntityEditorDraft,
): PlanningEntityEditResult {
  const title = draft.title.trim()
  if (!title) return { kind: 'invalid', problem: 'title-required' }
  const ownerMemberKey = draft.ownerMemberKey.trim()
  if (!ownerMemberKey) return { kind: 'invalid', problem: 'owner-required' }

  const singleDay = entity.type === 'milestone'
  const baseline = {
    startDate: singleDay ? draft.baselineEnd : draft.baselineStart,
    endDate: draft.baselineEnd,
  }
  const forecast = {
    startDate: singleDay ? draft.forecastEnd : draft.forecastStart,
    endDate: draft.forecastEnd,
  }
  if (![baseline, forecast].every((range) => range.startDate && range.endDate)) {
    return { kind: 'invalid', problem: 'date-required' }
  }
  if (baseline.startDate > baseline.endDate || forecast.startDate > forecast.endDate) {
    return { kind: 'invalid', problem: 'date-range' }
  }

  const manualProgress = readManualProgress(draft.manualProgress)
  if (draft.progressMode === 'manual' && manualProgress === undefined) {
    return { kind: 'invalid', problem: 'manual-progress' }
  }

  const description = draft.description.trim()
  const patch: PlanningEntityPatch = {
    ...(title === entity.title ? {} : { title }),
    ...(description === (entity.description ?? '')
      ? {}
      : { description: description || null }),
    ...(ownerMemberKey === entity.ownerMemberKey ? {} : { ownerMemberKey }),
    ...(draft.status === entity.status ? {} : { status: draft.status }),
    ...(draft.health === entity.health ? {} : { health: draft.health }),
    ...(draft.risk === entity.risk ? {} : { risk: draft.risk }),
    ...(draft.progressMode === entity.progressMode ? {} : { progressMode: draft.progressMode }),
    ...(draft.progressMode === 'manual' && manualProgress !== entity.manualProgress
      ? { manualProgress }
      : {}),
    ...(sameRange(baseline, entity.baseline) ? {} : { baseline }),
    ...(sameRange(forecast, entity.forecast) ? {} : { forecast }),
  }
  return Object.keys(patch).length === 0 ? { kind: 'unchanged' } : { kind: 'patch', patch }
}

/**
 * Collects distinct owner member keys already used in a snapshot, for owner suggestions.
 *
 * @param entities - Planning entities visible to the current user.
 * @returns Sorted, de-duplicated owner member keys.
 */
export function collectPlanningOwnerCandidates(entities: readonly PlanningEntity[]): string[] {
  return [...new Set(entities.map((entity) => entity.ownerMemberKey).filter(Boolean))].sort()
}

/**
 * Narrows a select value to one of the allowed options.
 *
 * @param value - Raw value reported by a select element.
 * @param options - Allowed option values.
 * @returns The matching option, or undefined when the value is not allowed.
 */
export function readPlanningOption<T extends string>(
  value: string,
  options: readonly T[],
): T | undefined {
  return options.find((option) => option === value)
}

/**
 * Parses a manual progress percentage.
 *
 * @param value - Percentage as typed.
 * @returns An integer from 0 to 100, or undefined for empty or invalid input.
 */
function readManualProgress(value: string): number | undefined {
  const parsed = value.trim() ? Number(value) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined
}

/**
 * Compares two date ranges by value.
 *
 * @param left - First range.
 * @param right - Second range.
 * @returns Whether both start and end dates match.
 */
function sameRange(
  left: PlanningEntity['baseline'],
  right: PlanningEntity['baseline'],
): boolean {
  return left.startDate === right.startDate && left.endDate === right.endDate
}
