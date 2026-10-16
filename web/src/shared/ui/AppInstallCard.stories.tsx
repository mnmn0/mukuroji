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
    failedMessage: 'ブラウザがインストールの確認を開けませんでした。ブラウザのメニューからインストールしてください。',
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

/** The browser offered installation again right after a dismissal; the result stays announced. */
export const DismissedThenReoffered: Story = {
  args: { status: 'available', outcome: 'dismissed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('status')).toHaveFocus()
    await expect(canvas.getByRole('button', { name: 'インストール' })).toBeVisible()
  },
}

/** Badge permission opt-in copy shared by the installed-app stories. */
const badgePermission = {
  offered: true,
  pending: false,
  description: 'iPhone や iPad など一部の端末では、通知を許可した場合だけアプリのアイコンに受信箱の未読数を表示します。mukuroji はプッシュ通知を送信せず、この許可はアイコンのバッジ表示にだけ使います。',
  actionLabel: 'アイコンのバッジを許可',
  pendingLabel: '選択を待っています…',
  grantedMessage: '通知を許可しました。アプリのアイコンに受信箱の未読数を表示できます。プッシュ通知は引き続き送信しません。',
  deniedMessage: '通知がブロックされているため、アプリのアイコンに未読数を表示できません。端末の設定から変更できます。',
  dismissedMessage: '選択されませんでした。後からここでアイコンのバッジを許可できます。',
  unsupportedMessage: 'この端末では通知の許可を確認できなかったため、アプリのアイコンに未読数が表示されない場合があります。',
}

/** The installed app may ask for notification permission so its icon badge appears. */
export const BadgePermissionOffered: Story = {
  args: { status: 'installed', badgePermission: { ...badgePermission, onRequest: fn() } },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'アイコンのバッジを許可' }))
    await expect(args.badgePermission?.onRequest).toHaveBeenCalledOnce()
  },
}

/** The permission dialog is open; the opt-in button stays focusable but inert. */
export const BadgePermissionPending: Story = {
  args: { status: 'installed', badgePermission: { ...badgePermission, pending: true, onRequest: fn() } },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: '選択を待っています…' })
    await expect(button).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(button)
    await expect(args.badgePermission?.onRequest).not.toHaveBeenCalled()
  },
}

/** Notifications were allowed; the button is gone and focus moves to the announced result. */
export const BadgePermissionGranted: Story = {
  args: { status: 'installed', badgePermission: { ...badgePermission, offered: false, result: 'granted', onRequest: fn() } },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole('status')
    await expect(status).toHaveFocus()
    await expect(status).toHaveTextContent('通知を許可しました')
  },
}

/** Notifications were blocked; the result explains where to change it. */
export const BadgePermissionDenied: Story = {
  args: { status: 'installed', badgePermission: { ...badgePermission, offered: false, result: 'denied', onRequest: fn() } },
}
