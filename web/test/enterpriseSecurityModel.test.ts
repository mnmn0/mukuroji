import { describe, expect, test } from 'bun:test'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  enterpriseProvisioningImpactFixture,
  enterpriseSecuritySnapshotFixture,
} from '../src/security/fixtures'
import { createEnterpriseSecurityConfirmationCopy } from '../src/security/model/enterpriseSecurityConfirmation'
import {
  formatEnterpriseSecurityPermissionName,
  formatEnterpriseSecurityRoleName,
} from '../src/security/model/enterpriseSecurityDisplay'
import {
  createEnterpriseSecurityScopeValue,
  createIdentityProviderDraft,
  createMappingDrafts,
  createSessionPolicyDraft,
  normalizeEnterpriseSecurityLineList,
  resolveAssignableMappingRoles,
  type EnterpriseSecurityScopeOption,
} from '../src/security/model/enterpriseSecurityForms'
import { isEnterpriseProvisioningImpactExpired } from '../src/security/model/enterpriseProvisioningImpact'
import {
  resolveVisibleEnterpriseSecurityTab,
  resolveVisibleEnterpriseSecurityTabs,
} from '../src/security/model/tabs'

const scopeOptions = [
  { id: 'workspace-demo', name: 'Workspace', type: 'workspace' },
  { id: 'core-team', name: 'Core team', type: 'team' },
  { id: 'project-demo', name: 'Project demo', type: 'project' },
] satisfies EnterpriseSecurityScopeOption[]

describe('enterprise security form model', () => {
  test('clones mutable identity and session drafts away from the API snapshot', () => {
    const identityDraft = createIdentityProviderDraft(
      enterpriseSecuritySnapshotFixture.identityProvider,
    )
    const sessionDraft = createSessionPolicyDraft(
      enterpriseSecuritySnapshotFixture.sessionPolicy,
    )

    expect(identityDraft).toEqual(
      enterpriseSecuritySnapshotFixture.identityProvider,
    )
    expect(identityDraft).not.toBe(
      enterpriseSecuritySnapshotFixture.identityProvider,
    )
    expect(sessionDraft.allowedGuestDomains).not.toBe(
      enterpriseSecuritySnapshotFixture.sessionPolicy.allowedGuestDomains,
    )
    expect(sessionDraft.ipAllowlist).not.toBe(
      enterpriseSecuritySnapshotFixture.sessionPolicy.ipAllowlist,
    )
  })

  test('builds mapping drafts and filters roles through server-owned ceilings', () => {
    const mapping = enterpriseSecuritySnapshotFixture.mappings[0]
    const workspaceScope = scopeOptions[0]
    if (!mapping || !workspaceScope) {
      throw new Error('Enterprise security mapping fixture is incomplete.')
    }

    const drafts = createMappingDrafts(
      enterpriseSecuritySnapshotFixture.mappings,
      scopeOptions,
    )
    const workspaceRoles = resolveAssignableMappingRoles(
      enterpriseSecuritySnapshotFixture,
      'workspace',
    )

    expect(drafts[mapping.id]).toEqual({
      roleId: mapping.roleId,
      scopeValue: createEnterpriseSecurityScopeValue(workspaceScope),
    })
    expect(workspaceRoles.map((role) => role.id)).toEqual(
      enterpriseSecuritySnapshotFixture.roles
        .filter((role) =>
          enterpriseSecuritySnapshotFixture.assignableRoleIds.groupMappings.workspace.includes(
            role.id,
          ),
        )
        .map((role) => role.id),
    )
  })

  test('normalizes multiline policy inputs without duplicate values', () => {
    expect(
      normalizeEnterpriseSecurityLineList([
        ' Partner.Example ',
        '',
        'partner.example',
        'VENDOR.EXAMPLE',
      ]),
    ).toEqual(['partner.example', 'vendor.example'])
  })
})

describe('enterprise security view model', () => {
  test('localizes built-in roles and permission names outside React', () => {
    const t = createTranslator('en')
    const role = enterpriseSecuritySnapshotFixture.roles.find(
      (candidate) => candidate.id === 'workspace:member',
    )
    const permission = enterpriseSecuritySnapshotFixture.permissions.find(
      (candidate) => candidate.id === 'work-items.write',
    )
    if (!role || !permission) {
      throw new Error('Enterprise security role fixture is incomplete.')
    }

    expect(formatEnterpriseSecurityRoleName(role, t)).toBe('Workspace member')
    expect(formatEnterpriseSecurityPermissionName(permission, t)).toBe(
      'Edit work items',
    )
  })

  test('expires provisioning previews at their authoritative timestamp', () => {
    const expiresAt = Date.parse(enterpriseProvisioningImpactFixture.expiresAt)

    expect(
      isEnterpriseProvisioningImpactExpired(
        enterpriseProvisioningImpactFixture,
        expiresAt - 1,
      ),
    ).toBe(false)
    expect(
      isEnterpriseProvisioningImpactExpired(
        enterpriseProvisioningImpactFixture,
        expiresAt,
      ),
    ).toBe(true)
  })

  test('creates destructive confirmation copy without UI dependencies', () => {
    const copy = createEnterpriseSecurityConfirmationCopy(
      {
        impact: enterpriseProvisioningImpactFixture,
        kind: 'provisioning',
      },
      createTranslator('en'),
    )

    expect(copy.destructive).toBe(true)
    expect(copy.title).toBe('Apply directory changes?')
  })

  test('fails a hidden route tab back to overview', () => {
    const capabilities = {
      ...enterpriseSecuritySnapshotFixture.capabilities,
      canViewAccess: false,
      canViewPrivileged: false,
      canViewProvisioning: false,
      canViewSessions: false,
    }

    expect(resolveVisibleEnterpriseSecurityTabs(capabilities)).toEqual([
      'overview',
      'identity',
    ])
    expect(resolveVisibleEnterpriseSecurityTab('privileged', capabilities)).toBe(
      'overview',
    )
  })
})
