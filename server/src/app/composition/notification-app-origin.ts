/**
 * Validates a deploy-time application origin used for links in external notifications.
 * @param value - Configured origin.
 * @param variableName - Environment variable name used in error messages.
 * @returns Normalized origin; HTTPS is required except for a loopback development host.
 * @throws Error when the value is not an absolute HTTPS (or loopback HTTP) URL.
 */
export function parseNotificationAppOrigin(value: string | undefined, variableName: string): string {
  let url: URL
  try {
    url = new URL(value?.trim() ?? '')
  } catch {
    throw new Error(`${variableName} must be an absolute URL.`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${variableName} must use HTTPS.`)
  }
  return url.origin
}
