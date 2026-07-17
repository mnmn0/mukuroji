import { describe, expect, test } from 'bun:test'
import { resolveSafeLoginReturnPath } from '../src/pages/loginReturnPath'

describe('resolveSafeLoginReturnPath', () => {
  test('accepts a same-origin public request path with URL state', () => {
    expect(resolveSafeLoginReturnPath('/request/opaque-token?locale=en#form')).toBe(
      '/request/opaque-token?locale=en#form',
    )
  })

  test('rejects external, protocol-relative, and unrelated paths', () => {
    expect(resolveSafeLoginReturnPath('https://attacker.example/request/token')).toBe('/dashboard')
    expect(resolveSafeLoginReturnPath('//attacker.example/request/token')).toBe('/dashboard')
    expect(resolveSafeLoginReturnPath('/projects/project-id')).toBe('/dashboard')
    expect(resolveSafeLoginReturnPath('/request\\attacker.example/token')).toBe('/dashboard')
  })

  test('uses the dashboard when no return path was provided', () => {
    expect(resolveSafeLoginReturnPath(null)).toBe('/dashboard')
  })
})
