import { randomUUID } from 'node:crypto'
import type { WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  WorkItemAcceptanceCriteriaError,
  changesOnlyCriterionSatisfaction,
  normalizeAcceptanceCriteria,
} from '../../modules/work-items'

/**
 * Reads and normalizes `acceptanceCriteria` from a Work Item update body.
 *
 * Criterion IDs refer to the list the client read, so callers must reject a stale revision before
 * calling this. An agent fenced by its Agent Run may only mark existing criteria met or unmet; adding,
 * removing, reordering, or rewording criteria is left to people.
 *
 * @param body - Configured update body.
 * @param existing - Criteria currently stored on the Work Item.
 * @param satisfactionOnly - Whether the caller may change only `satisfied`.
 * @returns The normalized replacement list, or undefined when the body omits the field.
 * @throws ProjectDataError when the list is invalid (400) or changes more than an agent may (403).
 */
export function readAcceptanceCriteriaChange(
  body: { acceptanceCriteria?: unknown },
  existing: readonly WorkItemAcceptanceCriterion[],
  satisfactionOnly: boolean,
): WorkItemAcceptanceCriterion[] | undefined {
  if (!('acceptanceCriteria' in body)) return undefined
  let criteria: WorkItemAcceptanceCriterion[]
  try {
    criteria = normalizeAcceptanceCriteria(body.acceptanceCriteria, {
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
