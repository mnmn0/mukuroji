import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemKeyStatus } from './WorkItemKeyStatus'

const meta = {
  title: 'Application/Issues/Work Item Key Status',
  component: WorkItemKeyStatus,
  args: {
    workItemKey: 'PT-12',
    status: 'loading',
    onRetry: fn(),
    t: createTranslator('ja'),
  },
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
} satisfies Meta<typeof WorkItemKeyStatus>

/** Status shown while a `/browse/PT-12` link opens its Work Item. */
export default meta

/** Story variants for each lookup outcome. */
type Story = StoryObj<typeof meta>

/** The key is still being resolved. */
export const Loading: Story = {}

/** The URL does not hold a Work Item key. */
export const Invalid: Story = {
  args: { status: 'invalid', workItemKey: 'not-a-key' },
}

/** No Work Item has this key, or the person cannot see it. */
export const NotFound: Story = {
  args: { status: 'not-found' },
}

/** The lookup failed and can be tried again. */
export const Failed: Story = {
  args: { status: 'failed' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'もう一度試す' }))
    await expect(args.onRetry).toHaveBeenCalledOnce()
  },
}

/** A retry is running. */
export const Retrying: Story = {
  args: { status: 'failed', retrying: true },
}

/** English labels fit the same layout. */
export const English: Story = {
  args: { status: 'not-found', t: createTranslator('en') },
}
