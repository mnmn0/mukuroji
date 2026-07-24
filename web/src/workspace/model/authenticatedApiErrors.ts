/**
 * Independently owned authenticated API errors consumed by the Workspace session policy.
 */
export type AuthenticatedApiErrorReports = {
  /** Session-policy errors raised by guarded Workspace mutations before navigation completes. */
  guardedSessionErrors: readonly unknown[]
  /** Error raised while loading notification preferences. */
  notificationPreferencesQuery?: unknown
  /** Error raised while saving notification preferences. */
  notificationPreferencesSave?: unknown
}

/**
 * Identifies the feature slot that owns an authenticated API error report.
 */
export type AuthenticatedApiErrorSource =
  | 'guarded-session-error'
  | 'notification-preferences-query'
  | 'notification-preferences-save'

/**
 * Replaces or clears one authenticated API error without affecting another feature.
 *
 * @param reports - Current independently owned error reports.
 * @param source - Feature slot that owns the update.
 * @param error - New error, or `undefined` when that feature recovered.
 * @returns Updated reports with only the selected feature slot changed.
 */
export function updateAuthenticatedApiErrorReport(
  reports: AuthenticatedApiErrorReports,
  source: AuthenticatedApiErrorSource,
  error?: unknown,
): AuthenticatedApiErrorReports {
  if (source === 'guarded-session-error') {
    if (error === undefined) {
      return reports
    }

    return {
      ...reports,
      guardedSessionErrors: [...reports.guardedSessionErrors, error],
    }
  }

  if (source === 'notification-preferences-query') {
    return {
      ...reports,
      notificationPreferencesQuery: error,
    }
  }

  return {
    ...reports,
    notificationPreferencesSave: error,
  }
}

/**
 * Lists every independently owned error for enterprise session-policy resolution.
 *
 * @param reports - Current authenticated API error reports.
 * @returns Guarded mutation errors followed by notification query and save errors.
 */
export function listAuthenticatedApiErrors(
  reports: AuthenticatedApiErrorReports,
): readonly unknown[] {
  return [
    ...reports.guardedSessionErrors,
    reports.notificationPreferencesQuery,
    reports.notificationPreferencesSave,
  ]
}
