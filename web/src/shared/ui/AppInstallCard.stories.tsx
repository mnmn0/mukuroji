import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { AppInstallCard } from './AppInstallCard'

const meta = {
  title: 'Design System/App Install Card',
  component: AppInstallCard,
  args: {
    status: 'available',
    title: 'アプリとしてインストール',
    description: 'mukuroji をアプリとして追加すると、独立したウィンドウで開き、アイコンに受信箱の未読数を表示します。',
    installLabel: 'インストール',
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
