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
 * Normalizes each draft field the way a save (and the server) would, so a saved value that
 * was trimmed or lower-cased is not mistaken for an unsaved edit.
 */
const draftNormalizers: {
  [K in keyof PlanningEntityEditorDraft]: (value: PlanningEntityEditorDraft[K]) => string
} = {
  title: (value) => value.trim(),
  description: (value) => value.trim(),
  ownerMemberKey: (value) => value.trim().toLowerCase(),
  status: (value) => value,
  health: (value) => value,
  risk: (value) => value,
  progressMode: (value) => value,
  manualProgress: (value) => (value.trim() ? String(Number(value)) : ''),
  baselineStart: (value) => value,
  baselineEnd: (value) => value,
  forecastStart: (value) => value,
  forecastEnd: (value) => value,
}

/**
 * Carries the user's unsaved edits over to a newer stored version of the same entity.
 *
 * Fields the user changed and has not saved keep the user's value; every other field takes the
 * newer stored value, so a refresh after a conflict neither discards the draft nor reverts
 * someone else's change. After a successful save the saved fields match `next` once normalized
 * (trimmed, lower-cased owner), so they take the stored value and stop counting as edits.
 *
 * @param previous - Stored entity the draft was last based on.
 * @param next - Newer stored version of the entity.
 * @param draft - Current form values.
 * @returns Form values based on `next` with the user's edits applied.
 */
export function rebasePlanningEntityEditorDraft(
  previous: PlanningEntity,
  next: PlanningEntity,
  draft: PlanningEntityEditorDraft,
): PlanningEntityEditorDraft {
  const before = createPlanningEntityEditorDraft(previous)
  const after = createPlanningEntityEditorDraft(next)
  /**
   * Keeps the user's value only while it is still an unsaved edit: it differs from both the
   * old and the new stored value once normalized the way the save normalizes it.
   */
  const pick = <K extends keyof PlanningEntityEditorDraft>(key: K): PlanningEntityEditorDraft[K] => {
    const normalize = draftNormalizers[key]
    const value = normalize(draft[key])
    return value === normalize(before[key]) || value === normalize(after[key])
      ? after[key]
      : draft[key]
  }
  return {
    title: pick('title'),
    description: pick('description'),
    ownerMemberKey: pick('ownerMemberKey'),
    status: pick('status'),
    health: pick('health'),
    risk: pick('risk'),
    progressMode: pick('progressMode'),
    manualProgress: pick('manualProgress'),
    baselineStart: pick('baselineStart'),
    baselineEnd: pick('baselineEnd'),
    forecastStart: pick('forecastStart'),
    forecastEnd: pick('forecastEnd'),
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

/** One Workspace member offered by the Planning owner picker. */
export type PlanningOwnerOption = {
  /** Normalized member key sent as `ownerMemberKey`. */
  memberKey: string
  /** Text shown for the member, such as `Name (email)`. */
  label: string
}

/**
 * Builds the owner picker list from known members and owner keys that must stay selectable.
 *
 * Members come first, sorted by label. A key that no loaded member matches, such as the current
 * owner of a plan whose owner left every Project, is kept and labeled by the key itself so the
 * picker never silently changes the stored owner.
 *
 * @param members - Members loaded from the Project directory.
 * @param keepKeys - Owner keys that must appear even without a matching member.
 * @returns De-duplicated owner options.
 */
export function resolvePlanningOwnerOptions(
  members: readonly PlanningOwnerOption[],
  keepKeys: readonly string[],
): PlanningOwnerOption[] {
  const byKey = new Map<string, PlanningOwnerOption>()
  for (const member of members) {
    const memberKey = member.memberKey.trim().toLowerCase()
    if (memberKey && !byKey.has(memberKey)) byKey.set(memberKey, { memberKey, label: member.label })
  }
  const options = [...byKey.values()].sort((left, right) => left.label.localeCompare(right.label))
  const extras = [...new Set(keepKeys.map((key) => key.trim().toLowerCase()))]
    .filter((key) => key && !byKey.has(key))
    .sort()
    .map((memberKey) => ({ memberKey, label: memberKey }))
  return [...options, ...extras]
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
 * Fractions are allowed because the server accepts any finite number from 0 to 100.
 *
 * @param value - Percentage as typed.
 * @returns A number from 0 to 100, or undefined for empty or invalid input.
 */
function readManualProgress(value: string): number | undefined {
  const parsed = value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined
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
