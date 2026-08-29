/**
 * Maximum UTF-8 bytes reserved for the encoded Search `filters` query value.
 *
 * The Search endpoint is reached through a GET request. Keeping the filters
 * below 6 KiB leaves room for the route, limit, and opaque cursor within the
 * common 8 KiB request-line envelope used by proxies and serverless gateways.
 */
const searchFilterGetQueryMaximumBytes = 6_144

/**
 * Checks whether a Search filter value can be transported through the GET API.
 *
 * @param filters - Unknown filter value received from a model or local editor.
 * @returns `true` when JSON and URL encoding stay within the bounded query budget.
 */
export function isSearchFilterTransportWithinGetBudget(filters: unknown): boolean {
  try {
    const serialized = JSON.stringify(filters)
    if (serialized === undefined) return false
    const encoded = new URLSearchParams({ filters: serialized }).toString()
    return new TextEncoder().encode(encoded).byteLength <= searchFilterGetQueryMaximumBytes
  } catch {
    return false
  }
}
