/**
 * Login 完了後に戻せる same-origin の公開 request path を解決します。
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

    if (candidate.origin !== baseUrl.origin || !candidate.pathname.startsWith('/request/')) {
      return '/dashboard'
    }

    return `${candidate.pathname}${candidate.search}${candidate.hash}`
  } catch {
    return '/dashboard'
  }
}
