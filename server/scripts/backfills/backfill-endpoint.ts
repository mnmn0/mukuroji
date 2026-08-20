/** Hosts accepted for repository-local DynamoDB emulators. */
const localDynamoDbHosts = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'floci',
  'localstack',
])

/**
 * Returns whether an endpoint targets a supported local DynamoDB emulator.
 *
 * @param endpoint - Candidate endpoint URL to inspect.
 * @returns Whether the endpoint uses a repository-local emulator host.
 */
export function isLocalDynamoDbEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined) return false
  try {
    const parsed = new URL(endpoint)
    return parsed.protocol === 'http:' &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      localDynamoDbHosts.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}
