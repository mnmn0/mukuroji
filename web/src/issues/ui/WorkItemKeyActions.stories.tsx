import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemKeyActions } from './WorkItemKeyActions'

const meta = {
  title: 'Application/Issues/Work Item Key Actions',
  component: WorkItemKeyActions,
  args: {
    workItemKey: 'PT-12',
    t: createTranslator('ja'),
    writeText: fn(async () => {}),
  },
} satisfies Meta<typeof WorkItemKeyActions>

/** Work Item key with buttons that copy the key or its lasting link. */
export default meta

/** Story variants for successful and failed copies. */
type Story = StoryObj<typeof meta>

/** Copies the key, then the link, and shows the result of each. */
export const CopyKeyAndLink: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'key をコピー' }))
    await expect(args.writeText).toHaveBeenCalledWith('PT-12')
    await expect(await canvas.findByText('key をコピーしました')).toBeVisible()

    await userEvent.click(canvas.getByRole('button', { name: 'link をコピー' }))
    await expect(args.writeText).toHaveBeenLastCalledWith(`${window.location.origin}/browse/PT-12`)
    await expect(await canvas.findByText('link をコピーしました')).toBeVisible()
  },
}

/** Tells the person when the browser refuses the clipboard write. */
export const CopyFailed: Story = {
  args: {
    writeText: fn(async () => {
      throw new Error('Clipboard is not available.')
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'key をコピー' }))
    await expect(await canvas.findByText('コピーできませんでした')).toBeVisible()
  },
}

/** English labels fit the same layout. */
export const English: Story = {
  args: {
    t: createTranslator('en'),
  },
}
