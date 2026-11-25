import {
  isWorkflowStatusRequiredField,
  isWorkflowTransitionActorRole,
  type WorkflowRuleUnmetCondition,
} from '@mukuroji/contracts'
import { isRecord } from '../../shared/api/jsonValidation'

/** Default message used when an Issues API error does not include one. */
export const defaultIssuesApiErrorMessage =
  'Unable to complete the Work Item request.'

/**
 * Builds the canonical URL path for a Team-owned Work Item.
 *
 * @param apiBaseUrl - Configured Issues API base URL.
 * @param teamId - Owning Team identifier.
 * @param issueId - Work Item identifier.
 * @returns Encoded Work Item API path.
 */
export function createTeamIssuePath(
  apiBaseUrl: string,
  teamId: string,
  issueId: string,
): string {
  return `${apiBaseUrl}/teams/${encodeURIComponent(
    teamId,
  )}/issues/${encodeURIComponent(issueId)}`
}

/**
 * Reads a stable error shape from an untrusted Issues API response.
 *
 * @param data - Untrusted decoded response payload.
 * @returns Optional error code and a safe human-readable message.
 */
export function readApiError(data: unknown): { code?: string; message: string } {
  if (!isRecord(data)) {
    return { message: defaultIssuesApiErrorMessage }
  }

  const record = data
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message:
      typeof record.message === 'string' && record.message.trim()
        ? record.message
        : defaultIssuesApiErrorMessage,
  }
}

/**
 * Reads the workflow rules a rejected status change did not meet, dropping malformed entries.
 *
 * @param data - Untrusted error response body.
 * @returns Unmet rules of a workflow rule error, or an empty list for any other body.
 */
export function readWorkflowRuleConditions(data: unknown): WorkflowRuleUnmetCondition[] {
  if (
    !isRecord(data) ||
    (data.code !== 'WorkflowTransitionActorDenied' && data.code !== 'WorkflowStatusRequirementsNotMet') ||
    !Array.isArray(data.unmetConditions)
  ) {
    return []
  }
  return data.unmetConditions.slice(0, 100).flatMap((candidate): WorkflowRuleUnmetCondition[] => {
    if (!isRecord(candidate) || typeof candidate.message !== 'string') return []
    if (candidate.rule === 'transition-actor' && Array.isArray(candidate.allowedActorRoles)) {
      const allowedActorRoles = candidate.allowedActorRoles.filter(isWorkflowTransitionActorRole)
      return [{ rule: 'transition-actor', allowedActorRoles, message: candidate.message }]
    }
    if (candidate.rule === 'required-field' && isWorkflowStatusRequiredField(candidate.field)) {
      return [{ rule: 'required-field', field: candidate.field, message: candidate.message }]
    }
    if (candidate.rule === 'required-custom-field' && typeof candidate.customFieldId === 'string') {
      return [{ rule: 'required-custom-field', customFieldId: candidate.customFieldId, message: candidate.message }]
    }
    return []
  })
}

/**
 * Decodes a JSON response body without trusting its shape.
 *
 * @param response - Fetch response to decode.
 * @returns Parsed JSON value, or an empty object for empty/malformed bodies.
 */
export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}
