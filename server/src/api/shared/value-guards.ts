

/**
 * Checks whether a value is a plain object record.
 *
 * @param value - Raw input value.
 * @returns `true` when the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Serializes a value with sorted object keys for stable digests.
 *
 * @param value - Raw input value.
 * @returns The deterministic JSON-like string.
 */
export function stableDigestStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableDigestStringify).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableDigestStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
