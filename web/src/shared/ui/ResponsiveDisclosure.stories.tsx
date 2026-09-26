import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ResponsiveDisclosure } from './ResponsiveDisclosure'

const meta = {
  title: 'Design System/Responsive Disclosure',
  component: ResponsiveDisclosure,
  args: {
    label: '絞り込み・並べ替え (1)',
    summary: '担当者: 自分',
    children: <label className="grid gap-2">担当者<input className="workbench-input min-h-11 px-3" defaultValue="自分" /></label>,
  },
  decorators: [(Story) => <div className="p-5"><Story /></div>],
} satisfies Meta<typeof ResponsiveDisclosure>

/** Responsive secondary controls retain their values across disclosure changes. */
export default meta

/** Story variants for desktop and touch-sized disclosure controls. */
type Story = StoryObj<typeof meta>

/** Desktop controls are immediately available. */
export const Desktop: Story = {}

/** Phone users can reveal and hide controls without losing their draft. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    if (!window.matchMedia('(max-width: 760px)').matches) return
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole('button', { name: /絞り込み/ })
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.click(trigger)
    const input = canvas.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'チーム')
    await userEvent.click(trigger)
    await userEvent.click(trigger)
    await expect(canvas.getByRole('textbox')).toHaveValue('チーム')
  },
}
