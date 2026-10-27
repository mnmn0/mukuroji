import {
  WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT,
  WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH,
  type WorkItemAcceptanceCriterion,
  type WorkItemAcceptanceCriterionInput,
} from '@mukuroji/contracts'

/** Form field that carries an open acceptance criteria draft with the Work Item editor form. */
export const ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD = 'acceptanceCriteriaDraft'

/**
 * One editable acceptance criterion row.
 */
export type AcceptanceCriterionDraftRow = {
  /** Stable React key for the row. */
  key: string
  /** Identifier of the stored criterion this row edits; absent for a new row. */
  criterionId?: string
  /** Condition text as typed. */
  text: string
  /** Whether the condition is met. */
  satisfied: boolean
}

/**
 * Reason an acceptance criteria draft cannot be saved.
 */
export type AcceptanceCriteriaDraftError = 'invalid-draft' | 'missing-text' | 'text-too-long' | 'too-many'

/**
 * Result of converting draft rows into a request list.
 */
export type AcceptanceCriteriaDraftParseResult =
  | {
    /** Request-ready replacement list. */
    criteria: WorkItemAcceptanceCriterionInput[]
  }
  | {
    /** Why the draft is invalid. */
    error: AcceptanceCriteriaDraftError
    /** Row that caused the error, when a single row is at fault. */
    rowKey?: string
  }

/**
 * Converts stored criteria into editable rows.
 *
 * @param criteria - Criteria stored on the Work Item.
 * @returns One row per criterion, keyed by its stored identifier.
 */
export function toAcceptanceCriterionDraftRows(
  criteria: readonly WorkItemAcceptanceCriterion[] | undefined,
): AcceptanceCriterionDraftRow[] {
  return (criteria ?? []).map((criterion) => ({
    key: criterion.id,
    criterionId: criterion.id,
    text: criterion.text,
    satisfied: criterion.satisfied,
  }))
}

/**
 * Creates an empty row for a new criterion.
 *
 * @param key - Unique React key for the row.
 * @returns An unmet row without text.
 */
export function createEmptyAcceptanceCriterionDraftRow(key: string): AcceptanceCriterionDraftRow {
  return { key, text: '', satisfied: false }
}

/**
 * Converts draft rows into a complete replacement list for the API.
 *
 * @param rows - Rows being edited.
 * @returns The request list, or the first problem found.
 */
export function parseAcceptanceCriterionDraftRows(
  rows: readonly AcceptanceCriterionDraftRow[],
): AcceptanceCriteriaDraftParseResult {
  if (rows.length > WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT) {
    return { error: 'too-many' }
  }
  const criteria: WorkItemAcceptanceCriterionInput[] = []
  for (const row of rows) {
    const text = row.text.trim()
    if (!text) return { error: 'missing-text', rowKey: row.key }
    if (text.length > WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH) return { error: 'text-too-long', rowKey: row.key }
    criteria.push({
      ...(row.criterionId ? { id: row.criterionId } : {}),
      text,
      satisfied: row.satisfied,
    })
  }
  return { criteria }
}

/**
 * Counts the criteria that are met.
 *
 * @param criteria - Criteria stored on the Work Item.
 * @returns Met and total counts.
 */
export function countSatisfiedAcceptanceCriteria(
  criteria: readonly WorkItemAcceptanceCriterion[] | undefined,
): { satisfied: number; total: number } {
  const list = criteria ?? []
  return { satisfied: list.filter((criterion) => criterion.satisfied).length, total: list.length }
}

/**
 * Serializes draft rows for the editor form's hidden field.
 *
 * @param rows - Rows being edited.
 * @returns JSON text of the rows.
 */
export function serializeAcceptanceCriterionDraftRows(rows: readonly AcceptanceCriterionDraftRow[]): string {
  return JSON.stringify(rows)
}

/**
 * Reads an open acceptance criteria draft submitted with the Work Item editor form.
 *
 * @param formData - Submitted editor form data.
 * @returns The request list or a draft error, or undefined when no draft is open.
 */
export function readAcceptanceCriteriaDraftSubmission(formData: FormData): AcceptanceCriteriaDraftParseResult | undefined {
  const value = formData.get(ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD)
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { error: 'invalid-draft' }
  }
  if (!Array.isArray(parsed) || !parsed.every(isAcceptanceCriterionDraftRow)) {
    return { error: 'invalid-draft' }
  }
  return parseAcceptanceCriterionDraftRows(parsed)
}

/**
 * Checks the shape of one serialized draft row.
 *
 * @param value - Parsed JSON entry.
 * @returns Whether the entry is a draft row.
 */
function isAcceptanceCriterionDraftRow(value: unknown): value is AcceptanceCriterionDraftRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const criterionId: unknown = Reflect.get(value, 'criterionId')
  return typeof Reflect.get(value, 'key') === 'string' &&
    (criterionId === undefined || typeof criterionId === 'string') &&
    typeof Reflect.get(value, 'text') === 'string' &&
    typeof Reflect.get(value, 'satisfied') === 'boolean'
}
