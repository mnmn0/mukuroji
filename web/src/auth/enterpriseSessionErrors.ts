import { resolveSafeLoginReturnPath } from '../pages/auth/loginReturnPath'

/**
 * Enterprise session policy error に対して認証 shell が実行する遷移種別です。
 */
export type EnterpriseSessionErrorActionKind =
  | 'ip-denied'
  | 'reauthenticate'
  | 'stay'

/**
 * Enterprise session policy error を安全な browser action に変換した結果です。
 */
export type EnterpriseSessionErrorAction = {
  /** 認証 shell が実行する遷移種別です。 */
  kind: EnterpriseSessionErrorActionKind
  /** 遷移前に保存済み authentication session を破棄するかどうかです。 */
  clearSession: boolean
  /** React Router が replace 遷移する same-origin application path です。 */
  redirectTo?: string
}

const freshAuthenticationErrorCodes = new Set([
  'EnterpriseSsoSessionRequired',
  'EnterpriseSessionMfaRequired',
  'EnterpriseSessionExpired',
  'EnterpriseSessionIdleTimeout',
  'EnterpriseSessionReauthenticationRequired',
])

/**
 * Session error の発生元です。
 */
export type EnterpriseSessionErrorContext =
  | 'authenticated-api'
  | 'current-user'

/**
 * 認証済み API が返した session policy error を、session 保持方針と安全な遷移先へ分類します。
 *
 * @param error - Current-user API が返した error です。
 * @param currentPath - Login 完了後に戻す現在の application path です。
 * @returns IP recovery、fresh authentication、または現在画面を維持する action です。
 */
export function resolveEnterpriseSessionErrorAction(
  error: unknown,
  currentPath: string,
  context: EnterpriseSessionErrorContext = 'authenticated-api',
): EnterpriseSessionErrorAction {
  const code = readStringProperty(error, 'code')

  if (code === 'EnterpriseSessionIpDenied') {
    return {
      clearSession: false,
      kind: 'ip-denied',
      redirectTo: '/security/recovery',
    }
  }

  if (
    readNumberProperty(error, 'status') === 401 ||
    (code !== undefined && freshAuthenticationErrorCodes.has(code)) ||
    (context === 'current-user' && code === 'WorkspaceAccessDenied')
  ) {
    const returnTo = resolveSafeLoginReturnPath(currentPath)

    return {
      clearSession: true,
      kind: 'reauthenticate',
      redirectTo: `/login?returnTo=${encodeURIComponent(returnTo)}`,
    }
  }

  return {
    clearSession: false,
    kind: 'stay',
  }
}

/**
 * Current-user と後続 API の error 群から、画面全体で優先する session action を解決します。
 *
 * `/auth/me` の `WorkspaceAccessDenied` だけを deprovision 済み session として終端し、
 * resource API の一般的な 403 は現在画面と session を維持します。
 *
 * @param currentUserError - Current-user API が返した error です。
 * @param authenticatedApiErrors - Current-user 読み込み後の load API が返した error 群です。
 * @param currentPath - Login 完了後に戻す現在の application path です。
 * @returns 遷移が必要な session action、current-user の表示 error、または undefined です。
 */
export function resolveEnterpriseSessionErrorsAction(
  currentUserError: unknown,
  authenticatedApiErrors: readonly unknown[],
  currentPath: string,
): EnterpriseSessionErrorAction | undefined {
  const currentUserAction = currentUserError
    ? resolveEnterpriseSessionErrorAction(
        currentUserError,
        currentPath,
        'current-user',
      )
    : undefined
  const authenticatedApiActions = authenticatedApiErrors
    .filter((error) => error !== undefined && error !== null)
    .map((error) => resolveEnterpriseSessionErrorAction(error, currentPath))
  const ipDeniedAction = [currentUserAction, ...authenticatedApiActions]
    .find((action) => action?.kind === 'ip-denied')

  if (ipDeniedAction) {
    return ipDeniedAction
  }

  const reauthenticationAction = [currentUserAction, ...authenticatedApiActions]
    .find((action) => action?.kind === 'reauthenticate')

  return reauthenticationAction ?? currentUserAction
}

function readStringProperty(value: unknown, property: string) {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const propertyValue = Reflect.get(value, property)
  return typeof propertyValue === 'string' ? propertyValue : undefined
}

function readNumberProperty(value: unknown, property: string) {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const propertyValue = Reflect.get(value, property)
  return typeof propertyValue === 'number' ? propertyValue : undefined
}
