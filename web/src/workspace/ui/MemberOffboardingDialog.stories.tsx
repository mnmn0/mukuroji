import type { WorkspaceMemberOffboarding } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../api/access'
import { MemberOffboardingDialog } from './MemberOffboardingDialog'

const leaver = {
  accessExpiresAt: '2026-12-01T15:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
  email: 'sato@example.com',
  id: 'member-sato',
  memberKey: 'sato@example.com',
  name: '佐藤 花子',
  role: 'member',
  status: 'active',
  updatedAt: '2026-11-20T00:00:00.000Z',
  version: 3,
} satisfies WorkspaceMember

const successor = {
  ...leaver,
  accessExpiresAt: undefined,
  email: 'suzuki@example.com',
  id: 'member-suzuki',
  memberKey: 'suzuki@example.com',
  name: '鈴木 一郎',
} satisfies WorkspaceMember

const guest = {
  ...successor,
  email: 'guest@example.com',
  id: 'member-guest',
  memberKey: 'guest@example.com',
  name: 'Guest Reviewer',
  role: 'guest',
} satisfies WorkspaceMember

const blockedOffboarding = {
  memberKey: 'sato@example.com',
  accessExpiresAt: '2026-12-01T15:00:00.000Z',
  accessExpired: false,
  managedProjects: [{ teamId: 'core-team', projectId: 'refero', name: 'Refero' }],
  ownedPlanningEntities: [{ id: 'cycle-12', type: 'cycle', title: '12 月スプリント' }],
  planningRevision: 41,
  managesPrivateDocuments: true,
  credentials: [
    { id: 'key-1', kind: 'api-key', name: 'CI 連携' },
    { id: 'app-1', kind: 'oauth-app', name: 'カレンダー同期' },
  ],
  webhooks: [{ id: 'hook-1', name: 'Slack 通知' }],
  canDeactivate: false,
} satisfies WorkspaceMemberOffboarding

const meta = {
  title: 'Application/Workspace/MemberOffboardingDialog',
  component: MemberOffboardingDialog,
  args: {
    actions: {
      transferProjects: fn(async () => undefined),
      transferPlanningEntities: fn(async () => undefined),
      revokeCredentials: fn(async () => undefined),
    },
    canEditAccessExpiry: true,
    loadState: { status: 'loaded', offboarding: blockedOffboarding },
    locale: 'ja',
    member: leaver,
    members: [leaver, successor, guest],
    t: createTranslator('ja'),
    onClose: fn(),
    onOpenWorkHandover: fn(),
    onReload: fn(),
    onSaveAccessExpiry: fn(async () => undefined),
  },
} satisfies Meta<typeof MemberOffboardingDialog>

export default meta

type Story = StoryObj<typeof meta>

/** Lists everything the leaver must hand over and hands the Project and Planning roles to a successor. */
export const HandOverBeforeDeactivation: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(canvas.getByTestId('member-offboarding-readiness')).toHaveTextContent('要対応')
    await expect(canvas.getByTestId('member-offboarding-projects')).toHaveTextContent('Refero')
    await expect(canvas.getByTestId('member-offboarding-planning')).toHaveTextContent('12 月スプリント')
    await expect(canvas.getByTestId('member-offboarding-webhooks')).toHaveTextContent('Slack 通知')
    const successorSelect = canvas.getByTestId('member-offboarding-successor')
    // A guest cannot manage a Project, so only the active member is offered.
    await expect(within(successorSelect).queryByText(/Guest Reviewer/)).toBeNull()
    await expect(canvas.getByTestId('member-offboarding-projects-transfer')).toBeDisabled()
    await userEvent.selectOptions(successorSelect, 'suzuki@example.com')
    await userEvent.click(canvas.getByTestId('member-offboarding-projects-transfer'))
    await expect(args.actions.transferProjects).toHaveBeenCalledWith(blockedOffboarding, 'suzuki@example.com')
    await userEvent.click(canvas.getByTestId('member-offboarding-planning-transfer'))
    await expect(args.actions.transferPlanningEntities).toHaveBeenCalledWith(blockedOffboarding, 'suzuki@example.com')
    await userEvent.click(canvas.getByTestId('member-offboarding-credentials-revoke'))
    await expect(args.actions.revokeCredentials).toHaveBeenCalled()
  },
}

/** Sets the last day of a guest, and clears it again. */
export const SetAccessExpiry: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const input = canvas.getByTestId('member-offboarding-expiry-input')
    await userEvent.clear(input)
    await userEvent.type(input, '2026-12-24')
    await userEvent.click(canvas.getByTestId('member-offboarding-expiry-save'))
    await expect(args.onSaveAccessExpiry).toHaveBeenCalledWith(new Date(2026, 11, 25).toISOString())
    await userEvent.click(canvas.getByTestId('member-offboarding-expiry-clear'))
    await expect(args.onSaveAccessExpiry).toHaveBeenLastCalledWith(null)
  },
}

/** Nothing blocks deactivation any more. */
export const ReadyToDeactivate: Story = {
  args: {
    loadState: {
      status: 'loaded',
      offboarding: {
        ...blockedOffboarding,
        managedProjects: [],
        ownedPlanningEntities: [],
        managesPrivateDocuments: false,
        credentials: [],
        webhooks: [],
        canDeactivate: true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(canvas.getByTestId('member-offboarding-readiness')).toHaveTextContent('利用停止できます')
    await expect(canvas.queryByTestId('member-offboarding-successor')).toBeNull()
  },
}

/** The access expiry passed while a handover still blocks the automatic deactivation. */
export const ExpiredButBlocked: Story = {
  args: {
    loadState: { status: 'loaded', offboarding: { ...blockedOffboarding, accessExpired: true } },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement.ownerDocument.body).getByTestId('member-offboarding-expiry-current'))
      .toHaveTextContent('利用期限が過ぎています')
  },
}

/** An owner cannot have an access expiry. */
export const OwnerWithoutExpiry: Story = {
  args: {
    canEditAccessExpiry: false,
    member: { ...leaver, role: 'owner', accessExpiresAt: undefined },
    loadState: { status: 'loaded', offboarding: { ...blockedOffboarding, accessExpiresAt: undefined } },
  },
}

/** Reading the summary. */
export const Loading: Story = {
  args: { loadState: { status: 'loading' } },
}

/** Reading the summary failed and can be retried. */
export const LoadFailed: Story = {
  args: { loadState: { status: 'failed' } },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole('button', { name: '再読み込み' }))
    await expect(args.onReload).toHaveBeenCalled()
  },
}
