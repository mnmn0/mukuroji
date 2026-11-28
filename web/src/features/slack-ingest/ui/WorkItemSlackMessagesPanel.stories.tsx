import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { workItemSlackMessagesFixture } from '../fixtures'
import { WorkItemSlackMessagesPanel } from './WorkItemSlackMessagesPanel'

/** Formats a timestamp in Japan time for stable stories. */
const formatter = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' })

const meta = {
  title: 'WorkItems/WorkItemSlackMessagesPanel',
  component: WorkItemSlackMessagesPanel,
  args: {
    messages: workItemSlackMessagesFixture,
    truncated: false,
    formatDateTime: (value: string) => formatter.format(new Date(value)),
    t: createTranslator('ja'),
    onRetry: fn(),
  },
} satisfies Meta<typeof WorkItemSlackMessagesPanel>

export default meta

type Story = StoryObj<typeof meta>

/** Two messages that mention the Work Item, one a thread reply. */
export const Messages: Story = {}

/** More messages exist than are shown, in English. */
export const Truncated: Story = {
  args: { truncated: true, t: createTranslator('en') },
}

/** The messages could not be loaded. */
export const LoadError: Story = {
  args: { messages: [], hasLoadError: true },
}
