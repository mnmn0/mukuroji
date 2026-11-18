import { expect, test } from 'bun:test'
import type { GetUserResponse } from '@aws-sdk/client-cognito-identity-provider'
import { toProjectPrincipal } from './authentication-session'

/**
 * Builds a Cognito GetUser response.
 *
 * @param username - Cognito username.
 * @param attributes - User attributes by name.
 * @returns The response the API reads on every request.
 */
function cognitoUser(username: string, attributes: Record<string, string>): GetUserResponse {
  return {
    Username: username,
    UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
  }
}

const accessToken = 'header.e30.signature'

test('authorizes an invited user by the email that is also the username', () => {
  const principal = toProjectPrincipal(cognitoUser('member@example.com', {
    sub: 'sub-member',
    email: 'Member@Example.com',
    email_verified: 'true',
  }), accessToken)

  expect(principal.userKey).toBe('member@example.com')
  expect(principal.actorId).toBe('sub-member')
})

test('keeps an invited user whose email verification has not been recorded yet', () => {
  const principal = toProjectPrincipal(cognitoUser('member@example.com', {
    email: 'member@example.com',
    email_verified: 'false',
  }), accessToken)

  expect(principal.userKey).toBe('member@example.com')
})

test('keeps a user whose verified email differs from the username', () => {
  const principal = toProjectPrincipal(cognitoUser('sso_provider_123', {
    email: 'owner@example.com',
    email_verified: 'true',
  }), accessToken)

  expect(principal.userKey).toBe('owner@example.com')
})

test('rejects a user who changed their own email to another address', () => {
  expect(() => toProjectPrincipal(cognitoUser('member@example.com', {
    email: 'owner@example.com',
    email_verified: 'false',
  }), accessToken)).toThrow(expect.objectContaining({
    status: 403,
    code: 'ProjectPrincipalMissing',
  }))
})
