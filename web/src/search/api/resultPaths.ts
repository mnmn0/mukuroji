

/**
 * Search API resultに含まれる遷移先を同一origin内のpathとして返します。
 */
export function resolveSearchResultPath(result: unknown) {
  const record = asRecord(result)
  const url = typeof record.url === 'string' ? record.url : undefined

  if (!url) {
    return undefined
  }

  try {
    const parsed = new URL(url, window.location.origin)
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined
  } catch {
    return url.startsWith('/') ? url : undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
