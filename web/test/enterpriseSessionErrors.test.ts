import { describe, expect, test } from 'bun:test'
import { ApiError } from '../src/auth/api'
import {
  resolveEnterpriseSessionErrorAction,
  resolveEnterpriseSessionErrorsAction,
} from '../src/auth/enterpriseSessionErrors'

describe('resolveEnterpriseSessionErrorAction', () => {
  test('preserves the session and routes IP denials to recovery', () => {
    expect(
      resolveEnterpriseSessionErrorAction(
        new ApiError(403, 'Network denied.', 'EnterpriseSessionIpDenied'),
        '/projects/project-1/issues?teamId=team-1',
      ),
    ).toEqual({
      clearSession: false,
      kind: 'ip-denied',
      redirectTo: '/security/recovery',
    })
  })

  test('uses a safe return path for fresh authentication', () => {
    expect(
      resolveEnterpriseSessionErrorAction(
        new ApiError(
          403,
          'Fresh authentication required.',
          'EnterpriseSessionReauthenticationRequired',
        ),
        '/teams/core-team/issues?issueId=issue-34#activity',
      ),
    ).toEqual({
      clearSession: true,
      kind: 'reauthenticate',
      redirectTo:
        '/login?returnTo=%2Fteams%2Fcore-team%2Fissues%3FissueId%3Dissue-34%23activity',
    })
  })

  test('restarts login when an enforced domain session was not server-attested by SSO', () => {
    expect(
      resolveEnterpriseSessionErrorAction(
        new ApiError(
          403,
          'Single sign-on is required.',
          'EnterpriseSsoSessionRequired',
        ),
        '/settings/security?tab=identity',
      ),
    ).toEqual({
      clearSession: true,
      kind: 'reauthenticate',
      redirectTo:
        '/login?returnTo=%2Fsettings%2Fsecurity%3Ftab%3Didentity',
    })
  })

  test('falls back to the dashboard when a return path is unsafe', () => {
    expect(
      resolveEnterpriseSessionErrorAction(
        new ApiError(401, 'Session expired.'),
        '//attacker.example/session',
      ).redirectTo,
    ).toBe('/login?returnTo=%2Fdashboard')
  })

  test.each([
    new ApiError(403, 'Forbidden.', 'WorkspaceAccessDenied'),
    new ApiError(409, 'Conflict.', 'WorkspaceRevisionConflict'),
    new ApiError(500, 'Internal server error.'),
    new Error('Unexpected current-user failure.'),
  ])('keeps the session and current page for a non-session error', (error) => {
    expect(
      resolveEnterpriseSessionErrorAction(
        error,
        '/projects/project-1/issues',
      ),
    ).toEqual({
      clearSession: false,
      kind: 'stay',
    })
  })

  test('ends a deprovisioned session only when access denial came from current-user', () => {
    const error = new ApiError(403, 'Workspace access denied.', 'WorkspaceAccessDenied')

    expect(
      resolveEnterpriseSessionErrorAction(error, '/dashboard', 'current-user'),
    ).toEqual({
      clearSession: true,
      kind: 'reauthenticate',
      redirectTo: '/login?returnTo=%2Fdashboard',
    })
    expect(resolveEnterpriseSessionErrorAction(error, '/dashboard')).toEqual({
      clearSession: false,
      kind: 'stay',
    })
  })

  test('classifies session policy failures from downstream authenticated APIs', () => {
    expect(
      resolveEnterpriseSessionErrorsAction(
        undefined,
        [new ApiError(403, 'Network denied.', 'EnterpriseSessionIpDenied')],
        '/planning',
      ),
    ).toEqual({
      clearSession: false,
      kind: 'ip-denied',
      redirectTo: '/security/recovery',
    })
  })

  test('prefers an IP recovery route when concurrent authenticated APIs fail differently', () => {
    expect(
      resolveEnterpriseSessionErrorsAction(
        undefined,
        [
          new ApiError(401, 'Session expired.'),
          new ApiError(403, 'Network denied.', 'EnterpriseSessionIpDenied'),
        ],
        '/dashboard',
      )?.kind,
    ).toBe('ip-denied')
  })
})
