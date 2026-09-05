import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  type CustomFieldValue,
  type WorkItemTypeDefinition,
} from '@mukuroji/contracts'
import type { RequestSubmissionModel } from './requestForm'

/**
 * Resolves the initial Work Item Type for a Request conversion form.
 *
 * @param workItemTypes - Active Work Item Types available for the effective Team.
 * @param routedWorkItemTypeId - Type captured by the immutable Request routing snapshot.
 * @returns The routed active Type, the first active Type, or the built-in fallback.
 */
export function resolveRequestConversionWorkItemTypeId(
  workItemTypes: readonly Pick<WorkItemTypeDefinition, 'id'>[],
  routedWorkItemTypeId?: string,
): string {
  return routedWorkItemTypeId && workItemTypes.some((type) => type.id === routedWorkItemTypeId)
    ? routedWorkItemTypeId
    : workItemTypes[0]?.id ?? DEFAULT_WORK_ITEM_TYPE_ID
}

/**
 * Maps immutable Request form answers to the Work Item custom fields configured for conversion.
 *
 * @param submission - Submission whose stored answers and mapping should be applied.
 * @returns Custom field values keyed by the target Work Item field ID.
 */
export function createMappedConversionCustomFieldValues(
  submission?: RequestSubmissionModel,
): Record<string, CustomFieldValue> {
  if (!submission) return {}

  const answersByFieldId = new Map(
    submission.answers.map((answer) => [answer.fieldId, answer.value]),
  )
  const values: Record<string, CustomFieldValue> = {}

  for (const [formFieldId, customFieldId] of Object.entries(
    submission.workItemMapping.customFieldMappings ?? {},
  )) {
    const value = answersByFieldId.get(formFieldId)
    if (value !== undefined) {
      values[customFieldId] = value
    }
  }

  return values
}
