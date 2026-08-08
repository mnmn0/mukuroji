

/**
 * Planning API が返した失敗を表す例外です。
 */
export class PlanningApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用の安定 error code です。
   */
  readonly code?: string

  /**
   * Planning API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - 画面へ引き渡せる error message です。
   * @param code - API が返した安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Planning 画面に表示する locale 済み error message の翻訳 key を解決します。
 *
 * @param error - Planning の load または mutation で発生した error です。
 * @param operation - Error が発生した操作です。
 * @returns Revision conflict は競合用、それ以外は汎用 error の翻訳 key です。
 */
export function resolvePlanningErrorMessageKey(
  error: unknown,
  operation: 'load' | 'mutation' = 'load',
): 'planning.conflict' | 'planning.error' | 'planning.mutationError' {
  if (typeof error !== 'object' || error === null) {
    return operation === 'mutation' ? 'planning.mutationError' : 'planning.error'
  }

  if (isPlanningSnapshotConflict(error)) return 'planning.conflict'
  return operation === 'mutation' ? 'planning.mutationError' : 'planning.error'
}

/**
 * Returns whether a Planning mutation failed because its revision or authorization view is stale.
 *
 * @param error - Unknown error returned by a Planning mutation boundary.
 * @returns True when callers must revalidate the authoritative Planning snapshot.
 */
export function isPlanningSnapshotConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  return code === 'PlanningRevisionConflict' ||
    code === 'PlanningAuthorizationChanged' ||
    code === 'PlanningWorkItemChanged'
}
