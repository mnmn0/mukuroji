import { ApiError } from '../../auth/api'

/**
 * Current user request の失敗が保存済み認証情報の破棄を要するか判定します。
 *
 * @param error - `/auth/me` request が返した error です。
 * @returns Access token が拒否された認証失敗なら `true` です。
 */
export function shouldClearAnalyticsAuthSession(error: unknown) {
  return error instanceof ApiError && error.status === 401
}
