import { describe, expect, test } from 'bun:test'
import {
  buildLoginRedirectPath,
  resolveSafeLoginReturnPath,
} from '../src/auth/model/loginReturnPath'

describe('resolveSafeLoginReturnPath', () => {
  test('accepts a same-origin public request path with URL state', () => {
    expect(resolveSafeLoginReturnPath('/request/opaque-token?locale=en#form')).toBe(
      '/request/opaque-token?locale=en#form',
    )
  })

  test('accepts the dedicated authenticated recovery path', () => {
    expect(resolveSafeLoginReturnPath('/security/recovery')).toBe(
      '/security/recovery',
    )
  })

  test('accepts the exact security settings return path with tab state', () => {
    expect(
      resolveSafeLoginReturnPath(
        '/settings/security?securityTab=privileged',
      ),
    ).toBe('/settings/security?securityTab=privileged')
  })

  test('preserves authenticated workspace context after fresh authentication', () => {
    expect(
      resolveSafeLoginReturnPath(
        '/focus?teamId=core-team&workItemId=issue-34',
      ),
    ).toBe('/focus?teamId=core-team&workItemId=issue-34')
    expect(
      resolveSafeLoginReturnPath(
        '/teams/core-team/issues?issueId=issue-34#activity',
      ),
    ).toBe('/teams/core-team/issues?issueId=issue-34#activity')
    expect(
      resolveSafeLoginReturnPath(
        '/projects/project-1/issues?teamId=core-team&issueId=34',
      ),
    ).toBe(
      '/projects/project-1/issues?teamId=core-team&issueId=34',
    )
  })

  test('rejects external, protocol-relative, and unrelated paths', () => {
    expect(resolveSafeLoginReturnPath('https://attacker.example/request/token')).toBe('/dashboard')
    expect(resolveSafeLoginReturnPath('//attacker.example/request/token')).toBe('/dashboard')
    expect(resolveSafeLoginReturnPath('/auth/sso/callback?code=secret')).toBe('/dashboard')
    expect(resolveSafeLoginReturnPath('/request\\attacker.example/token')).toBe('/dashboard')
  })

  test('uses the dashboard when no return path was provided', () => {
    expect(resolveSafeLoginReturnPath(null)).toBe('/dashboard')
  })
})

describe('buildLoginRedirectPath', () => {
  test('carries allowed workspace locations to the login page', () => {
    expect(buildLoginRedirectPath('/my-tasks')).toBe('/?returnTo=%2Fmy-tasks')
    expect(buildLoginRedirectPath('/updates?feed=saved-1')).toBe('/?returnTo=%2Fupdates%3Ffeed%3Dsaved-1')
    expect(buildLoginRedirectPath('/teams/core-team/issues?issueId=issue-34#activity')).toBe(
      '/?returnTo=%2Fteams%2Fcore-team%2Fissues%3FissueId%3Dissue-34%23activity',
    )
  })

  test('round-trips through the login return path resolver', () => {
    for (const path of ['/inbox', '/focus?teamId=core-team', '/help', '/share?title=Bug&text=Steps&url=https%3A%2F%2Fexample.com']) {
      const returnTo = new URL(buildLoginRedirectPath(path), 'https://mukuroji.invalid')
        .searchParams.get('returnTo')

      expect(resolveSafeLoginReturnPath(returnTo)).toBe(path)
    }
  })

  test('uses the plain login URL for paths the login page would not return to', () => {
    expect(buildLoginRedirectPath('/customers/customer-1')).toBe('/')
    expect(buildLoginRedirectPath('//evil.example/dashboard')).toBe('/')
    expect(buildLoginRedirectPath('/')).toBe('/')
  })
})
