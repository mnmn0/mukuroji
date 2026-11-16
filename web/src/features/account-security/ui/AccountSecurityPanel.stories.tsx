import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { AccountSecurityPanel } from './AccountSecurityPanel'

/** Storybook metadata for the signed-in user's password and MFA settings. */
const meta = {
  title: 'Application/Settings/Account Security/Panel',
  component: AccountSecurityPanel,
  parameters: { layout: 'padded' },
  args: {
    locale: 'ja',
    status: {
      mfaRequiredByPolicy: false,
      passwordManaged: true,
      softwareTokenMfaEnabled: false,
    },
    onChangePassword: fn(async () => undefined),
    onDisableMfa: fn(async () => undefined),
    onRetry: fn(),
    onStartMfaSetup: fn(async () => ({
      accountName: 'member@example.com',
      secretCode: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    })),
    onVerifyMfaSetup: fn(async () => undefined),
  },
} satisfies Meta<typeof AccountSecurityPanel>

export default meta

/** Story type for the account security panel. */
type Story = StoryObj<typeof meta>

/** A password user without an authenticator app. */
export const MfaOff: Story = {}

/** The workspace requires MFA, so the authenticator cannot be turned off. */
export const MfaRequiredByPolicy: Story = {
  args: {
    status: {
      mfaRequiredByPolicy: true,
      passwordManaged: true,
      softwareTokenMfaEnabled: true,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole('button', { name: '登録を解除' })).toBeNull()
  },
}

/** A single sign-on user, whose identity provider owns the password and MFA. */
export const SingleSignOn: Story = {
  args: {
    status: {
      mfaRequiredByPolicy: false,
      passwordManaged: false,
      softwareTokenMfaEnabled: false,
    },
  },
}

/** Loading failed. */
export const LoadError: Story = {
  args: { loadFailed: true, status: undefined },
}

/** A reload failed after a change; the earlier settings stay with a way to reload. */
export const ReloadError: Story = {
  args: { reloadFailed: true },
}

/** English copy. */
export const English: Story = {
  args: { locale: 'en' },
}
