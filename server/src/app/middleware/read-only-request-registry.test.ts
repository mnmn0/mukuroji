import { expect, test } from 'bun:test'
import { isReadOnlyRequest } from './read-only-request-registry'

test('admits reads and listed read-only POST routes only', () => {
  expect(isReadOnlyRequest('GET', '/api/teams/team-1/issues')).toBe(true)
  expect(isReadOnlyRequest('HEAD', '/api/teams')).toBe(true)
  expect(isReadOnlyRequest('POST', '/api/document-backlinks/batch')).toBe(true)
  expect(isReadOnlyRequest('POST', '/api/enterprise/security/policy/preview')).toBe(true)
  expect(isReadOnlyRequest('POST', '/api/teams/team-1/issues/issue-1/schedule/preview')).toBe(true)
  expect(isReadOnlyRequest('POST', '/api/planning/update-feed/digest/preview')).toBe(false)
  expect(isReadOnlyRequest('POST', '/api/enterprise/security/provisioning/preview')).toBe(false)
  expect(isReadOnlyRequest('POST', '/api/teams/team-1/issues')).toBe(false)
  expect(isReadOnlyRequest('PATCH', '/api/document-backlinks/batch')).toBe(false)
})
