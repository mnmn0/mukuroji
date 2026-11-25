import { randomUUID } from 'node:crypto'
import type { WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  WorkItemAcceptanceCriteriaError,
  applyAcceptanceCriteriaMarks,
  changesOnlyCriterionSatisfaction,
  normalizeAcceptanceCriteria,
} from '../../modules/work-items'

/**
 * Reads and normalizes `acceptanceCriteria` or `acceptanceCriteriaMarks` from a Work Item update body.
 *
 * Criterion IDs refer to the list the client read, so callers must reject a stale revision before
 * calling this. Marks are applied to the stored list here, inside the request's idempotency boundary,
 * so a retry with the same body replays. An agent fenced by its Agent Run may only mark existing
 * criteria met or unmet; adding, removing, reordering, or rewording criteria is left to people.
 *
 * @param body - Configured update body.
 * @param existing - Criteria currently stored on the Work Item.
 * @param satisfactionOnly - Whether the caller may change only `satisfied`.
 * @returns The normalized replacement list, or undefined when the body has neither field.
 * @throws ProjectDataError when the change is invalid (400) or changes more than an agent may (403).
 */
export function readAcceptanceCriteriaChange(
  body: { acceptanceCriteria?: unknown; acceptanceCriteriaMarks?: unknown },
  existing: readonly WorkItemAcceptanceCriterion[],
  satisfactionOnly: boolean,
): WorkItemAcceptanceCriterion[] | undefined {
  const replaces = 'acceptanceCriteria' in body
  const marks = 'acceptanceCriteriaMarks' in body
  if (!replaces && !marks) return undefined
  if (replaces && marks) {
    throw new ProjectDataError(400, 'InvalidAcceptanceCriteria', 'Send either acceptanceCriteria or acceptanceCriteriaMarks, not both.')
  }
  let criteria: WorkItemAcceptanceCriterion[]
  try {
    criteria = marks
      ? applyAcceptanceCriteriaMarks(body.acceptanceCriteriaMarks, existing)
      : normalizeAcceptanceCriteria(body.acceptanceCriteria, {
        existing,
        createCriterionId: () => randomUUID().replaceAll('-', ''),
      })
  } catch (error) {
    if (error instanceof WorkItemAcceptanceCriteriaError) {
      throw new ProjectDataError(400, error.code, error.message)
    }
    throw error
  }
  if (satisfactionOnly && !changesOnlyCriterionSatisfaction(criteria, existing)) {
    throw new ProjectDataError(
      403,
      'AcceptanceCriteriaChangeForbidden',
      'An agent may only mark existing acceptance criteria met or unmet. Ask a person to add, remove, or reword them.',
    )
  }
  return criteria
}

/**
 * Reads and normalizes the acceptance criteria sent with a new Work Item.
 *
 * A new Work Item has no stored criteria, so every entry is a new criterion and an entry that
 * names an ID is rejected. An empty list means no criteria.
 *
 * @param value - Untrusted `acceptanceCriteria` create value.
 * @returns The normalized criteria with new IDs, or undefined when there are none.
 * @throws ProjectDataError (400) when the list is invalid.
 */
export function readNewWorkItemAcceptanceCriteria(value: unknown): WorkItemAcceptanceCriterion[] | undefined {
  if (value === undefined) return undefined
  let criteria: WorkItemAcceptanceCriterion[]
  try {
    criteria = normalizeAcceptanceCriteria(value, {
      existing: [],
      createCriterionId: () => randomUUID().replaceAll('-', ''),
    })
  } catch (error) {
    if (error instanceof WorkItemAcceptanceCriteriaError) {
      throw new ProjectDataError(400, error.code, error.message)
    }
    throw error
  }
  return criteria.length > 0 ? criteria : undefined
}
