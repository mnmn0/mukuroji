/** Stable Automation failure category independent of an inbound transport. */
export type AutomationErrorCategory =
  | 'invalid-input'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'unprocessable'
  | 'locked'
  | 'rate-limited'
  | 'unavailable'

/** Transport-neutral Automation domain and application error. */
export class AutomationError extends Error {
  /** Stable failure category mapped by each inbound adapter. */
  readonly category: AutomationErrorCategory
  /**
   * HTTP-compatible status retained for callers using the legacy error contract.
   *
   * @deprecated Map `category` at the inbound transport boundary instead.
   */
  readonly status: number
  /** Stable machine-readable error code. */
  readonly code: string
  /** Whether the same logical operation may be retried. */
  readonly retryable: boolean

  /**
   * Creates an Automation error.
   *
   * @param category - Stable transport-neutral failure category.
   * @param code - Stable machine-readable code.
   * @param message - Safe error message.
   * @param retryable - Whether retry is allowed.
   */
  constructor(
    category: AutomationErrorCategory,
    code: string,
    message: string,
    retryable?: boolean,
  )
  /**
   * Creates an Automation error from the legacy HTTP-oriented contract.
   *
   * @param status - HTTP-compatible status retained without normalization.
   * @param code - Stable machine-readable code.
   * @param message - Safe error message.
   * @param retryable - Whether retry is allowed.
   * @deprecated Pass a transport-neutral `AutomationErrorCategory` instead.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    retryable?: boolean,
  )
  /**
   * Creates an Automation error from a category or legacy HTTP status.
   *
   * @param categoryOrStatus - Stable category or legacy HTTP-compatible status.
   * @param code - Stable machine-readable code.
   * @param message - Safe error message.
   * @param retryable - Whether retry is allowed.
   */
  constructor(
    categoryOrStatus: AutomationErrorCategory | number,
    code: string,
    message: string,
    retryable = false,
  ) {
    super(message)
    this.category = typeof categoryOrStatus === 'number'
      ? mapLegacyAutomationStatusToCategory(categoryOrStatus)
      : categoryOrStatus
    this.status = typeof categoryOrStatus === 'number'
      ? categoryOrStatus
      : mapAutomationErrorCategoryToStatus(categoryOrStatus)
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Maps a transport-neutral Automation category to its legacy HTTP status.
 *
 * @param category - Stable Automation failure category.
 * @returns HTTP-compatible status used by the legacy error contract.
 */
function mapAutomationErrorCategoryToStatus(category: AutomationErrorCategory): number {
  switch (category) {
    case 'invalid-input': return 400
    case 'unauthenticated': return 401
    case 'forbidden': return 403
    case 'not-found': return 404
    case 'conflict': return 409
    case 'payload-too-large': return 413
    case 'unsupported-media-type': return 415
    case 'unprocessable': return 422
    case 'locked': return 423
    case 'rate-limited': return 429
    case 'unavailable': return 503
  }
}

/**
 * Classifies a legacy HTTP status without trusting it as transport policy.
 *
 * Unknown statuses fail closed as `unavailable`; the constructor separately
 * retains the original numeric status for backward-compatible inspection.
 *
 * @param status - Legacy HTTP-compatible status.
 * @returns Stable transport-neutral Automation failure category.
 */
function mapLegacyAutomationStatusToCategory(status: number): AutomationErrorCategory {
  switch (status) {
    case 400: return 'invalid-input'
    case 401: return 'unauthenticated'
    case 403: return 'forbidden'
    case 404: return 'not-found'
    case 409: return 'conflict'
    case 413: return 'payload-too-large'
    case 415: return 'unsupported-media-type'
    case 422: return 'unprocessable'
    case 423: return 'locked'
    case 429: return 'rate-limited'
    case 503: return 'unavailable'
    default: return 'unavailable'
  }
}
