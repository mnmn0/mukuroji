import { describe, expect, test } from 'bun:test'
import { canManageWorkspaceTimePeriods, type WorkspaceTimePeriodPrincipal } from './time-period-access'

const basePrincipal: WorkspaceTimePeriodPrincipal = { isSystemAdmin: false, workspaceRole: 'admin' }

describe('canManageWorkspaceTimePeriods', () => {
  test('a legacy Workspace owner or admin manages month closes and a member does not', () => {
    expect(canManageWorkspaceTimePeriods(basePrincipal)).toBe(true)
    expect(canManageWorkspaceTimePeriods({ ...basePrincipal, workspaceRole: 'owner' })).toBe(true)
    expect(canManageWorkspaceTimePeriods({ ...basePrincipal, workspaceRole: 'member' })).toBe(false)
  })

  test('an Enterprise assignment replaces the admin role and needs workspace.manage', () => {
    const enterprise: WorkspaceTimePeriodPrincipal = {
      ...basePrincipal,
      enterprisePermissions: ['workspace.write'],
      enterpriseRouteAuthorizedAtResource: true,
      enterpriseAuthorizationResource: { kind: 'workspace', workspaceId: 'workspace-1' },
    }
    expect(canManageWorkspaceTimePeriods(enterprise)).toBe(false)
    expect(canManageWorkspaceTimePeriods({ ...enterprise, enterprisePermissions: ['workspace.manage'] })).toBe(true)
  })

  test('a system administrator manages month closes', () => {
    expect(canManageWorkspaceTimePeriods({ ...basePrincipal, workspaceRole: 'member', isSystemAdmin: true })).toBe(true)
  })
})
