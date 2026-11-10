import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { AgentRunReportsLoadNotice } from './AgentRunReportChips'
import { createAgentRunReportsNoticeLabels } from './agentRunReportLabels'

const labels = createAgentRunReportsNoticeLabels('en')

const meta = {
  title: 'Application/Work Items/Agent Run Reports Load Notice',
  component: AgentRunReportsLoadNotice,
  parameters: {
    layout: 'padded',
  },
  args: {
    labels,
    onRetry: fn(),
  },
} satisfies Meta<typeof AgentRunReportsLoadNotice>

export default meta

/** Story type of the reports loading notice. */
type Story = StoryObj<typeof meta>

/** Reports could not be read; the retry button reads them again. */
export const LoadFailed: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.loadError)).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: labels.retry }))
    await expect(args.onRetry).toHaveBeenCalledOnce()
  },
}

/** Japanese text. */
export const Japanese: Story = {
  args: {
    labels: createAgentRunReportsNoticeLabels('ja'),
  },
}
