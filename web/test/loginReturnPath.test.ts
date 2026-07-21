import { describe, expect, test } from 'bun:test'
import { resolveSafeLoginReturnPath } from '../src/auth/model/loginReturnPath'

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
