import { WORK_ITEM_COMPLETION_GATE_OVERRIDE_REASON_MAX_LENGTH } from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'

/** Work Item update body split into the ordinary fields and the completion Gate override. */
export type WorkItemCompletionGateOverrideRequest<TBody> = {
  /** Update body without the override field. */
  body: TBody
  /** Trimmed override reason, or undefined when the body asks for no override. */
  reason?: string
}

/**
 * Separates a manager's completion Gate override from an untrusted Work Item update body.
 *
 * @param input - Untrusted update body already reduced to public fields.
 * @returns The remaining body and the validated reason.
 * @throws ProjectDataError `400 InvalidWorkItemCompletionGateOverride` when the override is not
 * `{ reason }` with a non-empty reason of at most 1,000 characters.
 */
export function readWorkItemCompletionGateOverride<TBody extends { completionGateOverride?: unknown }>(
  input: TBody,
): WorkItemCompletionGateOverrideRequest<Omit<TBody, 'completionGateOverride'>> {
  const { completionGateOverride, ...body } = input
  if (!('completionGateOverride' in input)) return { body }
  return { body, reason: readOverrideReason(completionGateOverride) }
}

/**
 * Reads the reason of a completion Gate override.
 *
 * @param value - Untrusted override value.
 * @returns The trimmed reason.
 * @throws ProjectDataError when the value is not `{ reason }` with a valid reason.
 */
function readOverrideReason(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidOverride('completionGateOverride must be an object with a reason.')
  }
  const extra = Object.keys(value).find((key) => key !== 'reason')
  if (extra !== undefined) {
    throw invalidOverride('completionGateOverride accepts only reason.')
  }
  const reason = 'reason' in value && typeof value.reason === 'string' ? value.reason.trim() : ''
  if (reason.length === 0) {
    throw invalidOverride('completionGateOverride.reason is required.')
  }
  if (reason.length > WORK_ITEM_COMPLETION_GATE_OVERRIDE_REASON_MAX_LENGTH) {
    throw invalidOverride(
      `completionGateOverride.reason must be at most ${WORK_ITEM_COMPLETION_GATE_OVERRIDE_REASON_MAX_LENGTH} characters.`,
    )
  }
  return reason
}

/**
 * Builds the error for an invalid completion Gate override.
 *
 * @param message - Explanation for the client.
 * @returns The `400` error.
 */
function invalidOverride(message: string): ProjectDataError {
  return new ProjectDataError(400, 'InvalidWorkItemCompletionGateOverride', message)
}
