import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { ShareCaptureForm } from './ShareCaptureForm'

const meta = {
  title: 'Features/Share Capture Form',
  component: ShareCaptureForm,
  args: {
    initialContent: {
      title: 'Checkout fails on Safari',
      body: 'Steps:\n1. Open the cart\n2. Press checkout\n\nhttps://example.com/cart',
    },
    isSubmitting: false,
    onCancel: fn(),
    onSubmit: fn(),
    t: createTranslator('ja'),
    teams: [
      { id: 'team-core', name: 'Core' },
      { id: 'team-ops', name: 'Operations' },
    ],
  },
} satisfies Meta<typeof ShareCaptureForm>

/** Form that hands content shared from another app to a Team Triage queue. */
export default meta

/** Story variants for the share capture form. */
type Story = StoryObj<typeof meta>

/** Content shared from another app, waiting for a destination Team. */
export const Shared: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: '送り先のチーム' }), 'team-ops')
    await userEvent.click(canvas.getByRole('button', { name: 'Triage へ送る' }))
    await expect(args.onSubmit).toHaveBeenCalledWith('team-ops', {
      title: 'Checkout fails on Safari',
      body: 'Steps:\n1. Open the cart\n2. Press checkout\n\nhttps://example.com/cart',
    })
  },
}

/** A send failed and can be retried. */
export const Failed: Story = {
  args: { errorMessage: 'Triage へ送れませんでした。もう一度お試しください。' },
}

/** The person has no Team to send to. */
export const NoTeams: Story = {
  args: { teams: [] },
}
