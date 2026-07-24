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
