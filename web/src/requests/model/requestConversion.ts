import type { CustomFieldValue } from '@mukuroji/contracts'
import type { RequestSubmissionModel } from './requestForm'

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
