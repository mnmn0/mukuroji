import { AutomationError } from '../domain/automation-error'

const retryableAwsErrorCodes = new Set([
  'InternalServerError',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestTimeout',
  'ServiceUnavailable',
  'Throttling',
  'ThrottlingException',
  'TransactionInProgressException',
])

const trustedExternalAutomationFailureCodes = new Set([
  ...retryableAwsErrorCodes,
  'ConditionalCheckFailedException',
  'WorkItemRevisionConflict',
])

/** Stable failure returned by an Automation side-effect boundary. */
export type AutomationActionFailure = {
  /** Stable machine-readable failure code. */
  code: string
  /** Safe failure message. */
  message: string
  /** Whether the operation may be retried. */
  retryable: boolean
}

/**
 * Normalizes an unknown action-adapter failure into a safe stable contract.
 *
 * @param error - Unknown downstream failure.
 * @returns Stable code, safe message, and retryability.
 */
export function normalizeAutomationActionFailure(error: unknown): AutomationActionFailure {
  if (error instanceof AutomationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable ||
        error.category === 'rate-limited' ||
        error.category === 'unavailable',
    }
  }
  if (isRecord(error)) {
    const metadata = isRecord(error.$metadata) ? error.$metadata : undefined
    const status = typeof error.status === 'number'
      ? error.status
      : typeof error.statusCode === 'number'
        ? error.statusCode
        : typeof metadata?.httpStatusCode === 'number'
          ? metadata.httpStatusCode
          : undefined
    const rawCode = typeof error.code === 'string'
      ? error.code
      : typeof error.name === 'string'
        ? error.name
        : 'AutomationActionFailed'
    const code = trustedExternalAutomationFailureCodes.has(rawCode)
      ? rawCode
      : 'AutomationActionFailed'
    return {
      code,
      message: 'Automation action failed.',
      retryable: error.retryable === true ||
        Boolean(error.$retryable) ||
        retryableAwsErrorCodes.has(code) ||
        isTransientFailureStatus(status),
    }
  }
  return {
    code: 'AutomationActionFailed',
    message: 'Automation action failed.',
    retryable: false,
  }
}

/** Tests whether an HTTP-compatible status denotes a transient failure. */
function isTransientFailureStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
