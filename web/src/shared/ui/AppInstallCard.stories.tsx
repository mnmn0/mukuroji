import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { AppInstallCard } from './AppInstallCard'

const meta = {
  title: 'Design System/App Install Card',
  component: AppInstallCard,
  args: {
    status: 'available',
    title: 'アプリとしてインストール',
    description: 'mukuroji をアプリとして追加すると、独立したウィンドウで開きます。アプリのバッジに対応した端末では、アイコンに受信箱の未読数も表示します。',
    installLabel: 'インストール',
    pendingLabel: 'ブラウザの確認を待っています…',
    acceptedMessage: 'mukuroji をインストールしています。完了すると独立したウィンドウで開けます。',
    dismissedMessage: 'インストールはキャンセルされました。後からブラウザのメニューでもインストールできます。',
    installedMessage: 'mukuroji はアプリとしてインストールされています。',
    onInstall: fn(),
  },
} satisfies Meta<typeof AppInstallCard>

/** Card that offers installing the app from the settings page. */
export default meta

/** Story variants for each install status. */
type Story = StoryObj<typeof meta>

/** The browser allows installation from the page. */
export const Available: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'インストール' }))
    await expect(args.onInstall).toHaveBeenCalledOnce()
  },
}

/** The page already runs as the installed app. */
export const Installed: Story = {
  args: { status: 'installed' },
}

/** The browser install dialog is open; the button stays focusable but inert. */
export const Prompting: Story = {
  args: { status: 'prompting' },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'ブラウザの確認を待っています…' })
    await expect(button).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(button)
    await expect(args.onInstall).not.toHaveBeenCalled()
  },
}

/** The user dismissed the dialog; focus moves to the announced result. */
export const Dismissed: Story = {
  args: { status: 'unavailable', outcome: 'dismissed' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveFocus()
  },
}
