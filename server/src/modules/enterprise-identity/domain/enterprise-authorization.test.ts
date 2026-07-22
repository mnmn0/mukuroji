import { expect, test } from 'bun:test'
import type {
  EnterpriseCustomRole,
  EnterpriseRoutePermissionRule,
  EnterpriseSecurityPolicy,
} from '@mukuroji/contracts'
import {
  evaluateEnterpriseAccess,
  ipMatchesCidr,
  resolveRoutePermission,
  validateEnterpriseSession,
} from './enterprise-authorization'

test('evaluates role and guest ceilings without AWS or Hono adapters', () => {
  const customRole = {
    workspaceId: 'workspace-1',
    roleId: 'custom:reviewer',
    name: 'Reviewer',
    permissions: ['files.read', 'files.approve'],
    guestAssignable: true,
    revision: 1,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  } satisfies EnterpriseCustomRole

  expect(evaluateEnterpriseAccess({
    permission: 'files.approve',
    principal: {
      kind: 'member',
      principalId: 'member-1',
      directoryGroupIds: [],
      workspaceRole: 'guest',
      permissionCeiling: ['files.read'],
    },
    assignments: [{
      workspaceId: 'workspace-1',
      assignmentId: 'assignment-1',
      principalKind: 'member',
      principalId: 'member-1',
      roleId: customRole.roleId,
      scope: { kind: 'workspace', workspaceId: 'workspace-1' },
      source: 'direct',
      createdAt: '2026-07-22T00:00:00.000Z',
    }],
    customRoles: [customRole],
    groupMappings: [],
    resource: { kind: 'workspace', workspaceId: 'workspace-1' },
  })).toMatchObject({ allowed: false, reason: 'guest-ceiling' })
})

test('denies unregistered routes and matches parameterized routes', () => {
  const rules = [{
    method: 'GET',
    pathPattern: '/api/projects/:projectId/tasks',
    permission: 'work-items.read',
  }] satisfies EnterpriseRoutePermissionRule[]

  expect(resolveRoutePermission('GET', '/api/projects/project-1/tasks', rules))
    .toBe('work-items.read')
  expect(resolveRoutePermission('GET', '/api/projects/project-1/files', rules))
    .toBeUndefined()
})

test('validates MFA, session lifetime, and IPv4/IPv6 allowlists', () => {
  const policy = {
    workspaceId: 'workspace-1',
    loginMode: 'password-or-sso',
    mfaRequirement: 'required',
    sessionLifetimeMinutes: 480,
    reauthenticationIntervalMinutes: 120,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'all-users',
    ipAllowlist: ['203.0.113.0/24'],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: true,
      maximumSessionLifetimeMinutes: 60,
    },
    revision: 1,
    updatedAt: '2026-07-22T00:00:00.000Z',
  } satisfies EnterpriseSecurityPolicy

  expect(validateEnterpriseSession(policy, {
    authenticatedAt: 1_000,
    now: 1_060,
    authenticationMethods: ['pwd'],
    clientIp: '203.0.113.10',
    privileged: false,
    external: false,
    breakGlass: false,
  })).toEqual({ valid: false, reason: 'mfa-required' })
  expect(ipMatchesCidr('203.0.113.255', '203.0.113.0/24')).toBe(true)
  expect(ipMatchesCidr('::ffff:203.0.113.10', '203.0.113.0/24')).toBe(true)
  expect(ipMatchesCidr('::ffff:cb00:710a', '203.0.113.0/24')).toBe(true)
  expect(ipMatchesCidr('203.0.113.10', '::ffff:203.0.113.0/120')).toBe(true)
  expect(ipMatchesCidr('203.0.113.10', '::ffff:cb00:7100/120')).toBe(true)
  expect(ipMatchesCidr('198.51.100.10', '::ffff:0:0/96')).toBe(true)
  expect(ipMatchesCidr('203.0.113.10', '::ffff:cb00:710a/128')).toBe(true)
  expect(ipMatchesCidr('203.0.113.11', '::ffff:cb00:710a/128')).toBe(false)
  expect(ipMatchesCidr('::ffff:0:0', '::ffff:0:0/95')).toBe(false)
  expect(ipMatchesCidr('::ffff:203.0.114.10', '203.0.113.0/24')).toBe(false)
  expect(ipMatchesCidr('2001:db8:1::1', '2001:db8::/32')).toBe(true)
  expect(ipMatchesCidr('2001:db9::1', '2001:db8::/32')).toBe(false)
})
