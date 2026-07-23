import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { EnterpriseSecurityPanel } from './EnterpriseSecurityPanel'
import {
  enterpriseProvisioningImpactFixture,
  enterpriseScimTokenResponseFixture,
  enterpriseSecuritySnapshotFixture,
  enterpriseServiceAccountCredentialResponseFixture,
} from '../fixtures'

const blockedIdentitySnapshot = {
  ...enterpriseSecuritySnapshotFixture,
  breakGlassAdministrators: [],
  domains: enterpriseSecuritySnapshotFixture.domains.map((domain) => ({
    ...domain,
    status: 'pending' as const,
    verifiedAt: undefined,
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

const readOnlySnapshot = {
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

/** EnterpriseSecurityPanel の Storybook metadata です。 */
const meta = {
  title: 'Application/Settings/Enterprise Security',
  component: EnterpriseSecurityPanel,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    locale: 'ja',
    scopeOptions: [
      { id: 'workspace-demo', name: 'Workspace', type: 'workspace' },
      { id: 'core-team', name: 'Core team', type: 'team' },
      { id: 'refero', name: 'Refero · Core team', type: 'project' },
    ],
    snapshot: enterpriseSecuritySnapshotFixture,
    onApplyProvisioning: async () => undefined,
    onCreateDomain: async () => ({
      domain: enterpriseSecuritySnapshotFixture.domains[1]!,
      verificationRecordValue:
        'mukuroji-verification=storybook-one-time-value',
    }),
    onCreateMapping: async () => undefined,
    onCreateRole: async () => undefined,
    onCreateServiceAccount: async () =>
      enterpriseServiceAccountCredentialResponseFixture,
    onDeactivateBreakGlass: async () => undefined,
    onDeleteMapping: async () => undefined,
    onDeleteRole: async () => undefined,
    onPreviewProvisioning: async () => ({
      ...enterpriseProvisioningImpactFixture,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
    onPreviewRoleImpact: async (_role, input) =>
      input.delete
        ? {
            assignmentCount: 3,
            blocking: true,
            mappingCount: 1,
            removedPermissionIds: [],
            serviceAccountCount: 0,
            warnings: ['Remove role assignments before deletion.'],
          }
        : {
            assignmentCount: 3,
            blocking: false,
            confirmationToken: 'storybook-role-impact',
            mappingCount: 1,
            removedPermissionIds: [],
            serviceAccountCount: 0,
            warnings: [],
          },
    onPreviewSessionPolicy: async () => ({
      callerAllowed: true,
      callerIp: '203.0.113.24',
      requiresConfirmation: false,
      warnings: [],
    }),
    onRefresh: async () => undefined,
    onRegisterBreakGlass: async () => undefined,
    onRetryProvisioningLog: async () => undefined,
    onRevokeServiceAccount: async () => undefined,
    onRotateScimToken: async () => enterpriseScimTokenResponseFixture,
    onRotateServiceAccount: async () =>
      enterpriseServiceAccountCredentialResponseFixture,
    onTestBreakGlass: async () => undefined,
    onUpdateIdentityProvider: async () => undefined,
    onUpdateMapping: async () => undefined,
    onUpdateRole: async () => undefined,
    onUpdateSessionPolicy: async () => undefined,
    onUpdateSsoEnforcement: async () => undefined,
    onVerifyDomain: async () => undefined,
  },
} satisfies Meta<typeof EnterpriseSecurityPanel>

export default meta

/** EnterpriseSecurityPanel stories の型です。 */
type Story = StoryObj<typeof meta>

/** SSO、SCIM、同期エラー、特権経路をまとめた標準 overview です。 */
export const Overview: Story = {}

/** Capability で非表示の tab を除外して keyboard focus を移動します。 */
export const KeyboardNavigation: Story = {
  args: {
    locale: 'en',
    snapshot: {
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageAccess: false,
        canManageMappings: false,
        canManageProvisioning: false,
        canManageRoles: false,
        canViewAccess: false,
        canViewProvisioning: false,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const overviewTab = canvas.getByRole('tab', { name: 'Overview' })
    const identityTab = canvas.getByRole('tab', { name: 'Identity' })
    const sessionsTab = canvas.getByRole('tab', { name: 'Sessions' })
    const privilegedTab = canvas.getByRole('tab', { name: 'Privileged' })

    await expect(
      canvas.queryByRole('tab', { name: 'Provisioning' }),
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole('tab', { name: 'Mappings and roles' }),
    ).not.toBeInTheDocument()

    await userEvent.click(overviewTab)
    await userEvent.keyboard('{ArrowRight}')
    await expect(identityTab).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(sessionsTab).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect(privilegedTab).toHaveFocus()
    await userEvent.keyboard('{Home}')
    await expect(overviewTab).toHaveFocus()
  },
}

/** Mutation 中は選択中 tab の focus を保ち、移動を禁止します。 */
export const BusyNavigationLocked: Story = {
  args: {
    busyOperation: 'domain:create',
    initialTab: 'identity',
    locale: 'en',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const identityTab = canvas.getByRole('tab', { name: 'Identity' })
    const sessionsTab = canvas.getByRole('tab', { name: 'Sessions' })

    await expect(sessionsTab).toBeDisabled()
    await userEvent.click(identityTab)
    await userEvent.keyboard('{ArrowRight}')
    await expect(identityTab).toHaveFocus()
    await expect(identityTab).toHaveAttribute('aria-selected', 'true')
  },
}

/** 前提条件を満たすまで SSO enforcement を開始できない状態です。 */
export const IdentityPrerequisitesBlocked: Story = {
  args: {
    initialTab: 'identity',
    snapshot: blockedIdentitySnapshot,
  },
}

/** URL ではない正当な SAML Entity ID を編集できる状態です。 */
export const SamlUrnEntityId: Story = {
  args: {
    initialTab: 'identity',
    locale: 'en',
    snapshot: {
      ...enterpriseSecuritySnapshotFixture,
      identityProvider: {
        ...enterpriseSecuritySnapshotFixture.identityProvider,
        issuer: 'urn:example:mukuroji:saml:idp',
      },
    },
  },
}

/** One-time token、dry-run、retryable log の provisioning 管理です。 */
export const Provisioning: Story = {
  args: {
    initialTab: 'provisioning',
    locale: 'en',
  },
}

/** Protected owner/recovery access への影響により Apply を禁止した dry-run です。 */
export const ProvisioningBlocked: Story = {
  args: {
    initialTab: 'provisioning',
    locale: 'en',
    onPreviewProvisioning: async () => ({
      ...enterpriseProvisioningImpactFixture,
      blocking: true,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      warnings: [
        'The sole workspace owner is protected from directory deactivation.',
      ],
    }),
  },
}

/** Group mapping と grouped permission matrix を表示します。 */
export const MappingsAndRoles: Story = {
  args: {
    initialTab: 'access',
  },
}

/** 呼び出し元が付与できない permission を明示して無効化した role editor です。 */
export const LimitedRoleGrantCeiling: Story = {
  args: {
    initialTab: 'access',
    locale: 'en',
    snapshot: {
      ...enterpriseSecuritySnapshotFixture,
      assignablePermissionIds: ['work-items.write'],
    },
  },
}

/** 単位と説明を伴う session、network、guest policy editor です。 */
export const SessionPolicy: Story = {
  args: {
    initialTab: 'sessions',
    locale: 'en',
  },
}

/** Service account lifecycle と break-glass administrator を表示します。 */
export const PrivilegedAccess: Story = {
  args: {
    initialTab: 'privileged',
  },
}

/** Service account は管理できる一方、break-glass 操作は表示しない権限境界です。 */
export const ServiceAccountOnlyManager: Story = {
  args: {
    initialTab: 'privileged',
    locale: 'en',
    snapshot: {
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageBreakGlass: false,
        canManagePrivilegedAccess: true,
      },
    },
  },
}

/** Project scope、短期 credential、source CIDR を監査できる service account です。 */
export const ProjectScopedServiceAccount: Story = {
  args: {
    initialTab: 'privileged',
    locale: 'en',
    snapshot: {
      ...enterpriseSecuritySnapshotFixture,
      serviceAccounts:
        enterpriseSecuritySnapshotFixture.serviceAccounts.map(
          (account) => ({
            ...account,
            allowedSourceCidrs: [
              '203.0.113.0/24',
              '2001:db8::/48',
            ],
            credentialExpiresAt:
              '2026-08-17T03:00:00.000Z',
            credentialLifetimeDays: 30,
            roleId: 'project:member',
            scopeId: 'refero',
            scopeType: 'project' as const,
          }),
        ),
    },
  },
}

/** Capability がない管理者へ変更 control を無効化した状態です。 */
export const ReadOnly: Story = {
  args: {
    initialTab: 'access',
    snapshot: readOnlySnapshot,
  },
}

/** Enterprise security snapshot の読み込み中表示です。 */
export const Loading: Story = {
  args: {
    isLoading: true,
    snapshot: undefined,
  },
}

/** Enterprise security snapshot を取得できない状態です。 */
export const LoadError: Story = {
  args: {
    loadErrorMessage: 'Enterprise security settings could not be loaded.',
    locale: 'en',
    snapshot: undefined,
  },
}

/** IP allowlist 拒否後に再読込ではなく recovery へ誘導する状態です。 */
export const IpDeniedRecovery: Story = {
  args: {
    loadErrorActionLabel: 'Continue to recovery',
    loadErrorMessage:
      'Your current network is not in the Workspace IP allowlist. Switch to an approved network, or continue to recovery as a pre-registered emergency administrator.',
    locale: 'en',
    onLoadErrorAction: async () => undefined,
    snapshot: undefined,
  },
}
