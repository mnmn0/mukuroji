import { describe, expect, test } from 'bun:test'
import { resolveApiBaseUrl } from '../src/shared/api/apiBaseUrl'

const configuredEnvironment = {
  VITE_API_BASE_URL: 'https://shared.example.test/',
  VITE_PROJECTS_API_BASE_URL: 'https://projects.example.test/',
  VITE_WORKSPACE_API_BASE_URL: 'https://workspace.example.test/',
  VITE_ENTERPRISE_IDENTITY_API_BASE_URL: 'https://identity.example.test/',
}

/**
 * Returns the configured environment without the given variables.
 *
 * @param keys - Environment variable names to leave unset.
 * @returns A copy of the configured environment without those variables.
 */
function withoutKeys(...keys: readonly string[]) {
  return Object.fromEntries(
    Object.entries(configuredEnvironment).filter(([key]) => !keys.includes(key)),
  )
}

describe('API base URL resolution', () => {
  test('uses only the shared API base URL by default', () => {
    expect(resolveApiBaseUrl('shared', configuredEnvironment)).toBe('https://shared.example.test')
    expect(resolveApiBaseUrl('shared', {})).toBe('/api')
  })

  test('uses the Projects and shared API fallback chain', () => {
    expect(resolveApiBaseUrl('projects', configuredEnvironment)).toBe('https://projects.example.test')
    expect(resolveApiBaseUrl('projects', withoutKeys('VITE_PROJECTS_API_BASE_URL')))
      .toBe('https://shared.example.test')
    expect(resolveApiBaseUrl('projects', {})).toBe('/api')
  })

  test('uses the Workspace, Projects, and shared API fallback chain', () => {
    expect(resolveApiBaseUrl('workspace', configuredEnvironment)).toBe('https://workspace.example.test')
    expect(resolveApiBaseUrl('workspace', withoutKeys('VITE_WORKSPACE_API_BASE_URL')))
      .toBe('https://projects.example.test')
    expect(resolveApiBaseUrl(
      'workspace',
      withoutKeys('VITE_WORKSPACE_API_BASE_URL', 'VITE_PROJECTS_API_BASE_URL'),
    )).toBe('https://shared.example.test')
    expect(resolveApiBaseUrl('workspace', {})).toBe('/api')
  })

  test('skips the Projects override for Workspace APIs that never read it', () => {
    expect(resolveApiBaseUrl('workspaceWithoutProjects', configuredEnvironment))
      .toBe('https://workspace.example.test')
    expect(resolveApiBaseUrl('workspaceWithoutProjects', withoutKeys('VITE_WORKSPACE_API_BASE_URL')))
      .toBe('https://shared.example.test')
    expect(resolveApiBaseUrl('workspaceWithoutProjects', {})).toBe('/api')
  })

  test('uses the Enterprise identity, Workspace, and shared API fallback chain', () => {
    expect(resolveApiBaseUrl('enterpriseIdentity', configuredEnvironment))
      .toBe('https://identity.example.test')
    expect(resolveApiBaseUrl('enterpriseIdentity', withoutKeys('VITE_ENTERPRISE_IDENTITY_API_BASE_URL')))
      .toBe('https://workspace.example.test')
    expect(resolveApiBaseUrl(
      'enterpriseIdentity',
      withoutKeys('VITE_ENTERPRISE_IDENTITY_API_BASE_URL', 'VITE_WORKSPACE_API_BASE_URL'),
    )).toBe('https://shared.example.test')
    expect(resolveApiBaseUrl('enterpriseIdentity', {})).toBe('/api')
  })

  test('keeps a configured empty value instead of falling back', () => {
    expect(resolveApiBaseUrl('workspace', {
      VITE_API_BASE_URL: 'https://shared.example.test',
      VITE_WORKSPACE_API_BASE_URL: '',
    })).toBe('')
  })

  test('ignores non-string environment values', () => {
    expect(resolveApiBaseUrl('workspace', {
      VITE_API_BASE_URL: 'https://shared.example.test',
      VITE_WORKSPACE_API_BASE_URL: true,
    })).toBe('https://shared.example.test')
  })

  test('removes every trailing slash', () => {
    expect(resolveApiBaseUrl('shared', { VITE_API_BASE_URL: 'https://shared.example.test/api///' }))
      .toBe('https://shared.example.test/api')
  })
})
