import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  EnterpriseDomainVerificationChallengeNotice,
  EnterpriseSecurityPanel,
} from '../src/security/ui/EnterpriseSecurityPanel'
import {
  createEnterpriseSecurityCapabilityBoundary,
  createEnterpriseSecurityStateBoundary,
  createSecurityAccessBoundaryKey,
  parseActiveEnterpriseRecoveryExpiry,
  resolveServiceAccountAssignableRoleIds,
} from '../src/security/model/capabilityBoundary'
import { enterpriseSecuritySnapshotFixture } from '../src/security/fixtures'
import { EnterpriseSecurityApiError } from '../src/security/api'
import { requiresFreshEnterpriseAuthentication } from '../src/security/model/enterpriseAuthentication'

const scopeOptions = [
  { id: 'workspace-demo', name: 'Workspace', type: 'workspace' as const },
  { id: 'core-team', name: 'Core team', type: 'team' as const },
  { id: 'project-demo', name: 'Project demo', type: 'project' as const },
]

describe('EnterpriseSecurityPanel', () => {
  test.each([
    'EnterpriseBreakGlassMfaRequired',
    'EnterpriseBreakGlassReauthenticationRequired',
  ])('treats %s as a fresh-auth continuation', (code) => {
    expect(
      requiresFreshEnterpriseAuthentication(
        new EnterpriseSecurityApiError(403, 'Fresh authentication required.', code),
      ),
    ).toBe(true)
  })

  test('remounts sensitive state across capability downgrade and restore', () => {
    const administratorBoundary =
      createEnterpriseSecurityCapabilityBoundary(
        enterpriseSecuritySnapshotFixture.capabilities,
      )
    const downgradedBoundary =
      createEnterpriseSecurityCapabilityBoundary({
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageBreakGlass: false,
        canManageIdentity: false,
        canManagePrivilegedAccess: false,
        canManageProvisioning: false,
      })
    const restoredBoundary =
      createEnterpriseSecurityCapabilityBoundary(
        enterpriseSecuritySnapshotFixture.capabilities,
      )

    expect(downgradedBoundary).not.toBe(administratorBoundary)
    expect(restoredBoundary).not.toBe(downgradedBoundary)
  })

  test('remounts confirmation and secret state when the snapshot becomes stale', () => {
    const freshBoundary = createEnterpriseSecurityStateBoundary(
      enterpriseSecuritySnapshotFixture.capabilities,
      false,
    )
    const staleBoundary = createEnterpriseSecurityStateBoundary(
      enterpriseSecuritySnapshotFixture.capabilities,
      true,
    )

    expect(staleBoundary).not.toBe(freshBoundary)
  })

  test('remounts access drafts when the permission grant ceiling shrinks', () => {
    const fullCeilingKey = createSecurityAccessBoundaryKey(
      enterpriseSecuritySnapshotFixture,
      scopeOptions,
    )
    const reducedCeilingKey = createSecurityAccessBoundaryKey(
      {
        ...enterpriseSecuritySnapshotFixture,
        assignablePermissionIds: ['work-items.write'],
      },
      scopeOptions,
    )

    expect(reducedCeilingKey).not.toBe(fullCeilingKey)
  })

  test('hides an authoritative recovery activation at expiry', () => {
    const currentTime = Date.parse('2026-07-18T12:00:00.000Z')

    expect(
      parseActiveEnterpriseRecoveryExpiry(
        '2026-07-18T12:15:00.000Z',
        currentTime,
      ),
    ).toBe(Date.parse('2026-07-18T12:15:00.000Z'))
    expect(
      parseActiveEnterpriseRecoveryExpiry(
        '2026-07-18T12:00:00.000Z',
        currentTime,
      ),
    ).toBeUndefined()
  })

  test('renders an accessible six-tab security workspace', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(6)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('SSO enforcement readiness')
  })

  test('gates SSO enforcement behind tested IdP, domain, and break-glass prerequisites', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      breakGlassAdministrators: [],
      domains: enterpriseSecuritySnapshotFixture.domains.map((domain) => ({
        ...domain,
        status: 'pending' as const,
      })),
      identityProvider: {
        ...enterpriseSecuritySnapshotFixture.identityProvider,
        lastTestSucceeded: false,
        status: 'draft' as const,
      },
      ssoPrerequisites: {
        breakGlassReady: false,
        domainReady: false,
        providerReady: false,
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="identity"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('Complete the missing checklist items')
    expect(html).toContain(
      'data-testid="security-sso-enforcement" disabled=""',
    )
    expect(html.match(/Incomplete/g)).toHaveLength(3)
  })

  test('accepts a SAML URN entity ID without browser URL validation', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      identityProvider: {
        ...enterpriseSecuritySnapshotFixture.identityProvider,
        issuer: 'urn:example:mukuroji:saml:idp',
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="identity"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html).toMatch(
      /<input[^>]+type="text"[^>]+value="urn:example:mukuroji:saml:idp"/,
    )
  })

  test('uses non-sensitive readiness for identity managers without privileged detail access', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      breakGlassAdministrators: [],
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageBreakGlass: false,
        canManagePrivilegedAccess: false,
        canViewPrivileged: false,
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="identity"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )
    const enforcementButton = html.match(
      /<button[^>]+data-testid="security-sso-enforcement"[^>]*>/,
    )?.[0]

    expect(enforcementButton).toBeDefined()
    expect(enforcementButton).not.toContain('disabled=""')
    expect(html).toContain('All prerequisites are complete')
  })

  test('groups the role permission matrix by security purpose', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="access"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('data-testid="security-role-permission-matrix"')
    for (const group of [
      'Workspace',
      'Members',
      'Content',
      'Security',
      'Automation',
    ]) {
      expect(html).toContain(`>${group}</th>`)
    }
    expect(html).toContain('Privileged')
    expect(html).toContain('Select at least one permission.')
    expect(html).toContain('data-testid="security-role-create-form"')
  })

  test('requires an explicit service-account role instead of defaulting to owner', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="privileged"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('<option disabled="" value="" selected="">Select a role</option>')
    expect(html).toContain('data-testid="security-privileged"')
    expect(html).toContain('Allowed resource scope')
    expect(html).toContain('Credential lifetime')
    expect(html).toContain('Allowed source CIDRs')
    expect(html).toContain('Scope: Workspace · Workspace')
    expect(html).toContain('Credential expires:')
    expect(html).toContain('Restricted to 1 source CIDRs')

    expect(
      resolveServiceAccountAssignableRoleIds(
        enterpriseSecuritySnapshotFixture,
        'project',
      ),
    ).toContain('project:manager')
  })

  test('renders pending provisioning operations with localized status copy', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      provisioningLogs: [
        {
          ...enterpriseSecuritySnapshotFixture.provisioningLogs[0]!,
          status: 'pending' as const,
        },
      ],
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="provisioning"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('>Pending</span>')
  })

  test('separates absolute, idle, standard, and sensitive session intervals', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="sessions"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('Session lifetime')
    expect(html).toContain('Idle timeout')
    expect(html).toContain('Standard reauthentication')
    expect(html).toContain('Sensitive-action reauthentication')
  })

  test('shows a one-time domain DNS value separately from snapshot metadata', () => {
    const domain = enterpriseSecuritySnapshotFixture.domains[1]
    if (!domain) {
      throw new Error('Enterprise security domain fixture is incomplete.')
    }
    const html = renderToStaticMarkup(
      <EnterpriseDomainVerificationChallengeNotice
        challenge={{
          domain,
          verificationRecordValue: 'mukuroji-verification=one-time-value',
        }}
        locale="en"
        onDismiss={() => undefined}
      />,
    )

    expect(html).toContain(domain.verificationRecordName)
    expect(html).toContain('mukuroji-verification=one-time-value')
    expect(html).toContain('shown once')
  })

  test('removes mutation forms when capabilities are read-only', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        canManageAccess: false,
        canManageBreakGlass: false,
        canManageIdentity: false,
        canManageMappings: false,
        canManagePrivilegedAccess: false,
        canManageProvisioning: false,
        canManageRoles: false,
        canManageSessions: false,
        canView: true,
        canViewAccess: true,
        canViewIdentity: true,
        canViewPrivileged: true,
        canViewProvisioning: true,
        canViewSessions: true,
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="access"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('These settings are read-only')
    expect(html).toContain('>Read-only</span>')
    expect(html).not.toContain('>Admin</span>')
    expect(html).not.toContain('data-testid="security-mapping-form"')
    expect(html).toContain('disabled=""')
  })

  test('keeps break-glass controls hidden for service-account-only managers', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageBreakGlass: false,
        canManagePrivilegedAccess: true,
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="privileged"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('Create account')
    expect(html).not.toContain('These settings are read-only')
    expect(html).not.toContain('Register administrator')
    expect(html).not.toContain('Test current recovery access')
    expect(html).not.toContain('>Deactivate</button>')
  })

  test('hides unauthorized sections instead of rendering redacted defaults', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canViewAccess: false,
        canViewPrivileged: false,
        canViewProvisioning: false,
        canViewSessions: false,
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="sessions"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html).toContain('data-testid="security-tab-overview"')
    expect(html).toContain('data-testid="security-tab-identity"')
    expect(html).not.toContain('data-testid="security-tab-provisioning"')
    expect(html).not.toContain('Sync attention')
    expect(html).not.toContain('Privileged paths')
    expect(html).toContain('data-testid="security-overview"')
  })

  test('gates mapping and custom-role editors with separate capabilities', () => {
    const snapshot = {
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageMappings: true,
        canManageRoles: false,
      },
    }
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="access"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('data-testid="security-mapping-form"')
    expect(html).not.toContain('data-testid="security-role-create-form"')
  })

  test('shows the explicit guest-assignment boundary for custom roles', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="access"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('Allow assignment to guests')
    expect(html).toContain(
      'external guests can receive every permission in this role',
    )
    expect(html).toContain(
      'aria-label="Security reviewer: Allow assignment to guests"',
    )
  })

  test('only offers server-authorized roles to workspace-scoped service accounts', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="privileged"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('<option value="workspace:member">Workspace member</option>')
    expect(html).toContain(
      '<option value="custom:security-reviewer">Security reviewer</option>',
    )
    expect(html).not.toContain(
      '<option value="workspace:owner">Workspace owner</option>',
    )
    expect(html).not.toContain('<option value="project:manager">')
  })

  test('disables role permissions outside the caller grant ceiling', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        initialTab="access"
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={{
          ...enterpriseSecuritySnapshotFixture,
          assignablePermissionIds: ['work-items.write'],
        }}
      />,
    )

    expect(html).toContain(
      'Permissions outside that ceiling are disabled.',
    )
    expect(html).toContain(
      'You do not currently have authority to grant this permission to a role.',
    )
    expect(html).toContain(
      'This role includes permissions outside your grant ceiling and cannot be edited.',
    )
  })

  test('warns when a stale snapshot is shown after revalidation fails', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        isStale
        loadErrorMessage="Could not refresh."
        locale="en"
        scopeOptions={scopeOptions}
        snapshot={enterpriseSecuritySnapshotFixture}
      />,
    )

    expect(html).toContain('The displayed state may be stale.')
    expect(html).toContain('role="alert"')
    expect(html).toContain('<fieldset class="contents" disabled="">')
    expect(html).toContain('SSO enforcement readiness')
  })

  test('renders a dedicated fresh-authentication action for session policy failures', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        loadErrorActionLabel="Verify identity again"
        loadErrorMessage="Your session requires identity verification."
        locale="en"
        scopeOptions={scopeOptions}
      />,
    )

    expect(html).toContain('Your session requires identity verification.')
    expect(html).toContain('Verify identity again')
    expect(html).not.toContain('Retry loading')
  })

  test('renders a dedicated recovery action for IP-denied sessions', () => {
    const html = renderToStaticMarkup(
      <EnterpriseSecurityPanel
        loadErrorActionLabel="Continue to recovery"
        loadErrorMessage="Your current network is not approved."
        locale="en"
        scopeOptions={scopeOptions}
      />,
    )

    expect(html).toContain('Your current network is not approved.')
    expect(html).toContain('Continue to recovery')
    expect(html).not.toContain('Reload')
  })
})
