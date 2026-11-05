/**
 * Environment values that API base URL resolution reads, such as `import.meta.env`.
 *
 * Non-string values (for example Vite's boolean `DEV` / `PROD` flags) are treated as unset.
 */
export type ApiBaseUrlEnvironment = Readonly<Record<string, string | boolean | undefined>>

/** Base URL used when none of an API scope's environment variables are configured. */
const defaultApiBaseUrl = '/api'

/**
 * Environment variables each API scope reads, from highest to lowest precedence.
 *
 * The first variable that is set wins, even when its value is an empty string.
 */
const apiBaseUrlEnvironmentKeys = {
  /** APIs that only follow the shared API base URL. */
  shared: ['VITE_API_BASE_URL'],
  /** Project directory, member, user, and quick access APIs. */
  projects: ['VITE_PROJECTS_API_BASE_URL', 'VITE_API_BASE_URL'],
  /** Workspace APIs such as automation, documents, search, and Workspace access. */
  workspace: ['VITE_WORKSPACE_API_BASE_URL', 'VITE_PROJECTS_API_BASE_URL', 'VITE_API_BASE_URL'],
  /** Workspace APIs that skip the Projects override, such as Developer Platform and tenant administration. */
  workspaceWithoutProjects: ['VITE_WORKSPACE_API_BASE_URL', 'VITE_API_BASE_URL'],
  /** Enterprise identity and security policy APIs. */
  enterpriseIdentity: [
    'VITE_ENTERPRISE_IDENTITY_API_BASE_URL',
    'VITE_WORKSPACE_API_BASE_URL',
    'VITE_API_BASE_URL',
  ],
} as const satisfies Record<string, readonly string[]>

/** API scope whose environment variable precedence decides the base URL. */
export type ApiBaseUrlScope = keyof typeof apiBaseUrlEnvironmentKeys

/**
 * Resolves the API base URL for a scope from the Vite environment.
 *
 * @param scope - API scope whose environment variable precedence applies. Defaults to the shared API.
 * @param environment - Environment values to read. Defaults to `import.meta.env`.
 * @returns The configured base URL without trailing slashes, or `/api` when nothing is configured.
 */
export function resolveApiBaseUrl(
  scope: ApiBaseUrlScope = 'shared',
  environment: ApiBaseUrlEnvironment = import.meta.env,
): string {
  for (const key of apiBaseUrlEnvironmentKeys[scope]) {
    const value = environment[key]

    if (typeof value === 'string') {
      return trimTrailingSlashes(value)
    }
  }

  return defaultApiBaseUrl
}

/**
 * Removes every trailing slash from a configured base URL.
 *
 * @param value - Configured base URL.
 * @returns The base URL without trailing slashes.
 */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '')
}
