import type { WorkItemCompletionGateOverrideRequest } from '@mukuroji/contracts'

/** Name of the editor form field that carries a manager's completion Gate override reason. */
export const COMPLETION_GATE_OVERRIDE_REASON_FORM_FIELD = 'completionGateOverrideReason'

/**
 * Reads the completion Gate override a manager typed into the editor form.
 *
 * @param formData - Submitted editor form.
 * @returns The override to send with the update, or undefined when no reason was typed.
 */
export function readCompletionGateOverrideSubmission(
  formData: FormData,
): WorkItemCompletionGateOverrideRequest | undefined {
  const value = formData.get(COMPLETION_GATE_OVERRIDE_REASON_FORM_FIELD)
  const reason = typeof value === 'string' ? value.trim() : ''
  return reason.length > 0 ? { reason } : undefined
}
