/**
 * Builds the application-relative return URL for connector authorization.
 *
 * @param currentHref - Current absolute browser URL.
 * @returns Path, query, and hash with the connectors section selected.
 */
export function buildConnectorAuthorizationReturnUrl(
  currentHref: string,
) {
  const currentUrl = new URL(currentHref)

  currentUrl.searchParams.set('developerSection', 'connectors')
  return `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`
}

/**
 * Provider callback values that the server forwarded to the Web app in the URL fragment.
 */
export type ConnectorOAuthCallbackFragment =
  | {
      /** Signed state the provider returned unchanged. */
      state: string
      /** Authorization code issued by the provider. */
      code: string
    }
  | {
      /** Signed state the provider returned unchanged. */
      state: string
      /** The provider reported that authorization was not granted. */
      cancelled: true
    }

/**
 * Reads the connector OAuth callback values from a URL fragment.
 *
 * @param hash - `location.hash`, with or without the leading `#`.
 * @returns The state with either a code or a cancellation marker, or `undefined` when malformed.
 */
export function readConnectorOAuthCallbackFragment(
  hash: string,
): ConnectorOAuthCallbackFragment | undefined {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const state = params.get('state')
  const code = params.get('code')
  const cancelled = params.get('cancelled')

  if (!state || params.getAll('state').length !== 1) return undefined
  if (cancelled !== null) {
    return cancelled === 'true' && code === null ? { state, cancelled: true } : undefined
  }
  return code && params.getAll('code').length === 1 ? { state, code } : undefined
}
