import { describe, expect, test } from 'bun:test'
import { resolveWorkspaceCommonErrorKey } from '../src/workspace/model/workspaceRouteErrors'

describe('Workspace common route errors', () => {
  test('shows current-user and Project directory failures in the shared boundary', () => {
    expect(resolveWorkspaceCommonErrorKey(new Error('user'), undefined, {
      clearSession: false,
      kind: 'stay',
    })).toBe('dashboard.loadError')
    expect(resolveWorkspaceCommonErrorKey(undefined, new Error('directory'), undefined)).toBe(
      'projects.error.loading',
    )
  })

  test('keeps the shared error hidden while enterprise session policy redirects', () => {
    expect(resolveWorkspaceCommonErrorKey(undefined, new Error('directory'), {
      clearSession: true,
      kind: 'reauthenticate',
      redirectTo: '/login?returnTo=%2Fhome',
    })).toBeUndefined()
  })
})
