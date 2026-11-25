import { CONNECTOR_OAUTH_CALLBACK_APP_PATH } from '@mukuroji/contracts'

/** Settings path where a member restarts a connector connection after signing in again. */
const connectorOAuthRestartPath = '/settings?developerSection=connectors'

/**
 * Tells whether a path is the Web page that receives connector OAuth callback secrets.
 *
 * The router matches paths case-insensitively, so this check does too.
 *
 * @param pathname - URL path without search or hash.
 * @returns Whether the path is the connector OAuth callback page, ignoring a trailing slash
 *   and letter case.
 */
function isConnectorOAuthCallbackPath(pathname: string) {
  return pathname.replace(/\/+$/u, '').toLowerCase() ===
    CONNECTOR_OAUTH_CALLBACK_APP_PATH.toLowerCase()
}

/**
 * Resolves a safe same-origin application path to use after login.
 *
 * @param value - The `returnTo` query value from the login URL.
 * @returns An allowed request path, or the default dashboard path.
 */
export function resolveSafeLoginReturnPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/dashboard'
  }

  try {
    const baseUrl = new URL('https://mukuroji.invalid')
    const candidate = new URL(value, baseUrl)

    if (candidate.origin === baseUrl.origin && isConnectorOAuthCallbackPath(candidate.pathname)) {
      // The fragment carries a provider authorization code and signed state. Never carry them
      // into a login URL; after sign-in the member restarts the connection from settings.
      return connectorOAuthRestartPath
    }

    const allowedPath =
      candidate.pathname.startsWith('/request/') ||
      candidate.pathname === '/security/recovery' ||
      [
        '/dashboard',
        '/browse',
        '/home',
        '/focus',
        '/my-tasks',
        '/work-items',
        '/workload',
        '/inbox',
        '/requests',
        '/my-requests',
        '/search',
        '/planning',
        '/reports',
        '/help',
        '/settings',
        '/updates',
        '/share',
      ].some(
        (path) =>
          candidate.pathname === path ||
          candidate.pathname.startsWith(`${path}/`),
      ) ||
      candidate.pathname.startsWith('/teams/') ||
      candidate.pathname.startsWith('/projects/')

    if (candidate.origin !== baseUrl.origin || !allowedPath) {
      return '/dashboard'
    }

    return `${candidate.pathname}${candidate.search}${candidate.hash}`
  } catch {
    return '/dashboard'
  }
}

/**
 * Builds the login URL for a protected route opened without a usable session.
 *
 * The requested location is carried in `returnTo` only when the login page would accept it
 * unchanged, so arbitrary input is never echoed into the URL and disallowed paths keep the
 * plain login URL.
 *
 * @param requestedPath - Path, search, and hash of the protected route the user opened.
 * @returns `/` with a `returnTo` query for an allowed path, or `/` otherwise.
 */
export function buildLoginRedirectPath(requestedPath: string) {
  const resolvedPath = resolveSafeLoginReturnPath(requestedPath)

  if (resolvedPath === connectorOAuthRestartPath && resolvedPath !== requestedPath) {
    return `/?returnTo=${encodeURIComponent(resolvedPath)}`
  }

  if (resolvedPath !== requestedPath) {
    return '/'
  }

  return `/?returnTo=${encodeURIComponent(requestedPath)}`
}
