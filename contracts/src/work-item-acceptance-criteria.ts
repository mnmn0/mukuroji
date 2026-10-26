/** Maximum number of acceptance criteria one Work Item can hold. */
export const WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT = 20

/** Maximum length in characters of one acceptance criterion's text. */
export const WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH = 1024

/** One condition a Work Item must meet before it is accepted. */
export type WorkItemAcceptanceCriterion = {
  /** Stable server-assigned ID within the Work Item (32 lowercase hex digits); reports and comments may refer to it. */
  id: string
  /** Condition text. */
  text: string
  /** Whether the condition is met. */
  satisfied: boolean
}

/** One acceptance criterion in a complete replacement list sent with a Work Item update. */
export type WorkItemAcceptanceCriterionInput = {
  /** ID of an existing criterion to keep; omitted for a new criterion, which receives a new ID. */
  id?: string
  /** Condition text. */
  text: string
  /** Whether the condition is met; omitted means not met. */
  satisfied?: boolean
}

/** Marks one existing acceptance criterion met or unmet without restating the rest of the list. */
export type WorkItemAcceptanceCriterionMark = {
  /** ID of an existing criterion. */
  id: string
  /** Whether the condition is met. */
  satisfied: boolean
}

/**
 * Acceptance criteria of one Work Item, returned by
 * `GET /api/v1/work-items/{workItemId}/acceptance-criteria`; the closed public Work Item schema omits them.
 */
export type PublicWorkItemAcceptanceCriteria = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item the criteria belong to. */
  workItemId: string
  /** Work Item revision the list was read at; send it as `expectedRevision` when replacing the list. */
  revision: number
  /** Criteria in order; empty when none. */
  items: WorkItemAcceptanceCriterion[]
}

/**
 * Tells whether a Work Item has acceptance criteria: canonical criteria, or else a non-empty value
 * in the custom field a Team uses for them.
 *
 * @param workItem - Work Item fields to inspect.
 * @param workItem.acceptanceCriteria - Canonical criteria, if any.
 * @param workItem.customFieldValues - Custom field values, if any.
 * @param fieldId - Custom field that holds criteria, if the Team uses one.
 * @returns Whether at least one criterion exists.
 */
export function hasWorkItemAcceptanceCriteria(
  workItem: {
    /** Canonical criteria, if any. */
    acceptanceCriteria?: readonly WorkItemAcceptanceCriterion[]
    /** Custom field values, if any. */
    customFieldValues?: Readonly<Record<string, unknown>>
  },
  fieldId?: string,
): boolean {
  if ((workItem.acceptanceCriteria?.length ?? 0) > 0) return true
  if (fieldId === undefined || !workItem.customFieldValues || !Object.hasOwn(workItem.customFieldValues, fieldId)) return false
  const value = workItem.customFieldValues[fieldId]
  if (typeof value === 'string') return value.trim() !== ''
  return Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim() !== '')
}
