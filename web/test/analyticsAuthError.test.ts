import { describe, expect, test } from 'bun:test'
import { shouldClearAnalyticsAuthSession } from '../src/analytics/authError'
import { ApiError } from '../src/auth/api'

describe('Analytics current-user authentication failure', () => {
  test('clears the session only when the access token is rejected', () => {
    expect(shouldClearAnalyticsAuthSession(
      new ApiError(401, 'Authentication required.'),
    )).toBeTrue()
    expect(shouldClearAnalyticsAuthSession(
      new ApiError(403, 'Workspace access denied.'),
    )).toBeFalse()
    expect(shouldClearAnalyticsAuthSession(
      new ApiError(500, 'Service unavailable.'),
    )).toBeFalse()
    expect(shouldClearAnalyticsAuthSession(
      new TypeError('Failed to fetch'),
    )).toBeFalse()
  })
})
