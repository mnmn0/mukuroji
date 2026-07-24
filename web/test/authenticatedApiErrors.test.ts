import { describe, expect, test } from 'bun:test'
import {
  type AuthenticatedApiErrorReports,
  listAuthenticatedApiErrors,
  updateAuthenticatedApiErrorReport,
} from '../src/workspace/model/authenticatedApiErrors'
import { resolveEnterpriseSessionErrorsAction } from '../src/auth/enterpriseSessionErrors'

describe('authenticated Workspace API error reports', () => {
  test('preserves concurrent guarded session errors until navigation resolves them', () => {
    const mfaError = {
      code: 'EnterpriseSessionMfaRequired',
      status: 403,
    }
    const ipDeniedError = {
      code: 'EnterpriseSessionIpDenied',
      status: 403,
    }
    const initialReports: AuthenticatedApiErrorReports = {
      guardedSessionErrors: [],
    }
    const reportsWithMfaError = updateAuthenticatedApiErrorReport(
      initialReports,
      'guarded-session-error',
      mfaError,
    )
    const reportsWithConcurrentErrors = updateAuthenticatedApiErrorReport(
      reportsWithMfaError,
      'guarded-session-error',
      ipDeniedError,
    )

    expect(reportsWithConcurrentErrors.guardedSessionErrors).toEqual([
      mfaError,
      ipDeniedError,
    ])
    expect(resolveEnterpriseSessionErrorsAction(
      undefined,
      listAuthenticatedApiErrors(reportsWithConcurrentErrors),
      '/settings',
    )).toEqual({
      clearSession: false,
      kind: 'ip-denied',
      redirectTo: '/security/recovery',
    })
  })

  test('notification query recovery does not clear another error producer', () => {
    const guardedError = new Error('EnterpriseSessionMfaRequired')
    const saveError = new Error('EnterpriseSessionIpDenied')
    const reportsWithErrors: AuthenticatedApiErrorReports = {
      guardedSessionErrors: [guardedError],
      notificationPreferencesQuery: new Error('query failure'),
      notificationPreferencesSave: saveError,
    }
    const reportsAfterQueryRecovery = updateAuthenticatedApiErrorReport(
      reportsWithErrors,
      'notification-preferences-query',
    )

    expect(reportsAfterQueryRecovery).toEqual({
      guardedSessionErrors: [guardedError],
      notificationPreferencesQuery: undefined,
      notificationPreferencesSave: saveError,
    })
  })

  test('notification save recovery does not clear a query error', () => {
    const queryError = new Error('EnterpriseSessionMfaRequired')
    const reportsWithErrors: AuthenticatedApiErrorReports = {
      guardedSessionErrors: [],
      notificationPreferencesQuery: queryError,
      notificationPreferencesSave: new Error('save failure'),
    }
    const reportsAfterSaveRecovery = updateAuthenticatedApiErrorReport(
      reportsWithErrors,
      'notification-preferences-save',
    )

    expect(reportsAfterSaveRecovery).toEqual({
      guardedSessionErrors: [],
      notificationPreferencesQuery: queryError,
      notificationPreferencesSave: undefined,
    })
  })
})
