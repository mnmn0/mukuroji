import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { BuildDriftBanner } from './BuildDriftNotice'

const meta = {
  title: 'Application/Build Drift Notice',
  component: BuildDriftBanner,
  parameters: { layout: 'fullscreen' },
  args: { onReload: fn(), onDismiss: fn() },
} satisfies Meta<typeof BuildDriftBanner>

/** Notice shown when the API runs another commit than the Web build. */
export default meta

/** Story variants for each drift state. */
type Story = StoryObj<typeof meta>

/** The API runs another commit; reloading should fix it. */
export const Drift: Story = {
  args: { state: 'drift' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('status')).toBeVisible()
    const [later, reload] = canvas.getAllByRole('button')
    await userEvent.click(reload)
    await expect(args.onReload).toHaveBeenCalledOnce()
    await userEvent.click(later)
    await expect(args.onDismiss).toHaveBeenCalledOnce()
  },
}

/** The builds still differ after a reload, such as during a deploy. */
export const Persisting: Story = {
  args: { state: 'persisting' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toBeVisible()
  },
}
