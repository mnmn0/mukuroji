import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkspaceAccess } from './api'
import { WorkspaceAccessPanel } from './WorkspaceAccessPanel'

const ownerMember = {
  createdAt: '2026-07-01T00:00:00.000Z',
  email: 'owner@example.com',
  id: 'member-owner',
  memberKey: 'owner@example.com',
  name: 'Owner User',
  role: 'owner',
  status: 'active',
  updatedAt: '2026-07-11T08:00:00.000Z',
  version: 4,
} as const

const standardAccess = {
  capabilities: {
    canInvite: true,
    canManageAdmins: true,
    canManageMembers: true,
  },
  currentMember: ownerMember,
  invitations: [
    {
      createdAt: '2026-07-10T01:00:00.000Z',
      deliveryStatus: 'sent',
      email: 'new.member@example.com',
      expiresAt: '2026-07-17T01:00:00.000Z',
      id: 'invitation-pending',
      identityOwnership: 'workspace-created',
      lastSentAt: '2026-07-10T01:01:00.000Z',
      name: 'New Member',
      role: 'member',
      status: 'pending',
      updatedAt: '2026-07-10T01:01:00.000Z',
      version: 2,
    },
    {
      createdAt: '2026-07-03T03:00:00.000Z',
      deliveryStatus: 'not-required',
      email: 'existing@example.com',
      expiresAt: '2026-07-10T03:00:00.000Z',
      id: 'invitation-accepted',
      identityOwnership: 'pre-existing',
      name: 'Existing User',
      role: 'guest',
      status: 'accepted',
      updatedAt: '2026-07-03T03:12:00.000Z',
      version: 3,
    },
  ],
  members: [
    ownerMember,
    {
      createdAt: '2026-07-02T00:00:00.000Z',
      email: 'admin@example.com',
      id: 'member-admin',
      memberKey: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
      status: 'active',
      updatedAt: '2026-07-10T04:00:00.000Z',
      version: 3,
    },
    {
      createdAt: '2026-07-04T00:00:00.000Z',
      email: 'member@example.com',
      id: 'member-standard',
      memberKey: 'member@example.com',
      name: 'Member User',
      role: 'member',
      status: 'active',
      updatedAt: '2026-07-09T05:00:00.000Z',
      version: 2,
    },
    {
      createdAt: '2026-07-04T00:00:00.000Z',
      deactivatedAt: '2026-07-10T06:00:00.000Z',
      email: 'guest@example.com',
      id: 'member-guest',
      memberKey: 'guest@example.com',
      name: 'Guest User',
      role: 'guest',
      status: 'deactivated',
      updatedAt: '2026-07-10T06:00:00.000Z',
      version: 5,
    },
  ],
} satisfies WorkspaceAccess

const attentionAccess = {
  ...standardAccess,
  invitations: [
    {
      createdAt: '2026-07-11T03:00:00.000Z',
      deliveryStatus: 'pending',
      email: 'provisioning@example.com',
      expiresAt: '2026-07-18T03:00:00.000Z',
      id: 'invitation-provisioning',
      identityOwnership: 'ambiguous',
      name: 'Provisioning Recovery',
      role: 'member',
      status: 'provisioning',
      updatedAt: '2026-07-11T03:00:00.000Z',
      version: 1,
    },
    {
      createdAt: '2026-07-11T02:00:00.000Z',
      deliveryStatus: 'failed',
      email: 'delivery.failed@example.com',
      expiresAt: '2026-07-18T02:00:00.000Z',
      failureMessage: 'The invitation email could not be delivered.',
      id: 'invitation-delivery-failed',
      identityOwnership: 'workspace-created',
      name: 'Delivery Failed',
      role: 'member',
      status: 'delivery-failed',
      updatedAt: '2026-07-11T02:02:00.000Z',
      version: 2,
    },
    {
      createdAt: '2026-07-01T02:00:00.000Z',
      deliveryStatus: 'sent',
      email: 'expired@example.com',
      expiresAt: '2026-07-08T02:00:00.000Z',
      id: 'invitation-expired',
      identityOwnership: 'ambiguous',
      lastSentAt: '2026-07-01T02:01:00.000Z',
      name: 'Expired User',
      role: 'guest',
      status: 'expired',
      updatedAt: '2026-07-08T02:00:00.000Z',
      version: 4,
    },
    {
      createdAt: '2026-07-09T02:00:00.000Z',
      deliveryStatus: 'sent',
      email: 'cleanup.retry@example.com',
      expiresAt: '2026-07-16T02:00:00.000Z',
      failureMessage: 'The Cognito identity cleanup could not be completed.',
      id: 'invitation-revoked-cleanup-failed',
      identityCleanupManualRequired: true,
      identityOwnership: 'workspace-created',
      lastSentAt: '2026-07-09T02:01:00.000Z',
      name: 'Cleanup Retry',
      role: 'member',
      status: 'revoked',
      updatedAt: '2026-07-11T02:00:00.000Z',
      version: 3,
    },
  ],
} satisfies WorkspaceAccess

const meta = {
  args: {
    access: standardAccess,
    locale: 'ja',
    onAcknowledgeInvitationCleanup: async () => undefined,
    onInvite: async () => undefined,
    onReinviteInvitation: async () => undefined,
    onResendInvitation: async () => undefined,
    onRetry: async () => undefined,
    onRevokeInvitation: async () => undefined,
    onUpdateMember: async () => undefined,
  },
  component: WorkspaceAccessPanel,
  parameters: {
    layout: 'padded',
  },
  title: 'Application/Settings/Workspace Access Panel',
} satisfies Meta<typeof WorkspaceAccessPanel>

/**
 * WorkspaceAccessPanel の Storybook metadata です。
 */
export default meta

/**
 * WorkspaceAccessPanel stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * owner が member と invitation を管理する標準状態です。
 */
export const OwnerManagement: Story = {}

/**
 * 配信失敗と期限切れ invitation の復旧操作を確認する状態です。
 */
export const DeliveryFailureAndExpired: Story = {
  args: {
    access: attentionAccess,
  },
}

/**
 * member role で access ledger を読み取り専用表示する状態です。
 */
export const ReadOnlyMember: Story = {
  args: {
    access: {
      ...standardAccess,
      capabilities: {
        canInvite: false,
        canManageAdmins: false,
        canManageMembers: false,
      },
      currentMember: standardAccess.members[2],
    },
  },
}

/**
 * Workspace access API の読み込み中表示です。
 */
export const Loading: Story = {
  args: {
    access: undefined,
    isLoading: true,
  },
}

/**
 * Workspace access API 失敗と明示的な再試行操作です。
 */
export const LoadError: Story = {
  args: {
    access: undefined,
    loadErrorMessage: 'Workspace のアクセス情報を取得できませんでした。',
  },
}

/**
 * 英語 locale の access ledger です。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}
