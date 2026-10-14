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

    const allowedPath =
      candidate.pathname.startsWith('/request/') ||
      candidate.pathname === '/security/recovery' ||
      [
        '/dashboard',
        '/home',
        '/focus',
        '/my-tasks',
        '/inbox',
        '/requests',
        '/search',
        '/planning',
        '/reports',
        '/help',
        '/settings',
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
  if (resolveSafeLoginReturnPath(requestedPath) !== requestedPath) {
    return '/'
  }

  return `/?returnTo=${encodeURIComponent(requestedPath)}`
}
