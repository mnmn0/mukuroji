/**
 * Replaces named placeholders in a localized UI template.
 *
 * @param template - Template containing `{name}` placeholders.
 * @param values - Replacement values keyed by placeholder name.
 * @returns Interpolated display text.
 */
export function interpolate(
  template: string,
  values: Record<string, string | number>,
) {
  return Object.entries(values).reduce(
    (result, [key, value]) =>
      result.replaceAll(`{${key}}`, String(value)),
    template,
  )
}

/**
 * Formats an ISO timestamp with the current locale.
 *
 * @param value - ISO 8601 timestamp.
 * @returns Localized date and time text.
 */
export function formatDeveloperTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

/**
 * Converts a kebab-case connector identifier to a readable provider name.
 *
 * @param value - Connector provider or category identifier.
 * @returns Title-cased display name.
 */
export function formatConnectorProviderName(value: string) {
  return value
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
