import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { AppUpdateNotice } from './AppUpdateNotice'

const meta = {
  title: 'Design System/App Update Notice',
  component: AppUpdateNotice,
  args: {
    message: '新しいバージョンを利用できます。再読み込みすると更新されます。',
    reloadLabel: '再読み込み',
    dismissLabel: '後で',
    onReload: fn(),
    onDismiss: fn(),
  },
  decorators: [(Story) => <div className="min-h-[240px]"><Story /></div>],
} satisfies Meta<typeof AppUpdateNotice>

/** Notice that offers to reload into a newly installed service worker version. */
export default meta

/** Story variants for desktop and phone-sized update notices. */
type Story = StoryObj<typeof meta>

/** Desktop placement in the bottom-right corner. */
export const Desktop: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '再読み込み' }))
    await expect(args.onReload).toHaveBeenCalledOnce()
    await userEvent.click(canvas.getByRole('button', { name: '後で' }))
    await expect(args.onDismiss).toHaveBeenCalledOnce()
  },
}

/** Phone placement spanning the width above the bottom safe area. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** English copy fits the same layout. */
export const English: Story = {
  args: {
    message: 'A new version is available. Reload to update.',
    reloadLabel: 'Reload',
    dismissLabel: 'Later',
  },
}
