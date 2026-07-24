import type { EnterpriseSessionErrorAction } from '../../auth/enterpriseSessionErrors'
import type { MessageKey } from '../../shared/i18n/i18n'

/**
 * Resolves the visible common-data error without masking a session redirect.
 *
 * @param currentUserError - Current-user query failure, when present.
 * @param projectDirectoryError - Team and Project directory failure, when present.
 * @param sessionAction - Highest-priority enterprise session action.
 * @returns The shared error message key, or `undefined` while redirecting or healthy.
 */
export function resolveWorkspaceCommonErrorKey(
  currentUserError: unknown,
  projectDirectoryError: unknown,
  sessionAction: EnterpriseSessionErrorAction | undefined,
): MessageKey | undefined {
  if (sessionAction?.redirectTo) {
    return undefined
  }

  if (currentUserError) {
    return 'dashboard.loadError'
  }

  return projectDirectoryError ? 'projects.error.loading' : undefined
}
