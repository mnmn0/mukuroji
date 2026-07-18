/**
 * Login 完了後に戻せる same-origin の application path を解決します。
 *
 * @param value - Login URL の `returnTo` query value です。
 * @returns 許可された request path、または既定 dashboard path です。
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
