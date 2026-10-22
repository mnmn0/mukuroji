import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { agentRunFixtures, stalledAgentRunFixture } from '../agentRunFixtures'
import { WorkItemAgentRunsPanel } from './WorkItemAgentRunsPanel'
import { createWorkItemAgentRunsLabels } from './agentRunLabels'

const labels = createWorkItemAgentRunsLabels('en')

const meta = {
  title: 'Application/Work Items/Agent Runs',
  component: WorkItemAgentRunsPanel,
  parameters: {
    layout: 'padded',
  },
  args: {
    labels,
    runs: agentRunFixtures,
    formatDateTime: (value: string) => value.slice(0, 16).replace('T', ' '),
    onRelease: async () => undefined,
    onRetry: async () => undefined,
  },
} satisfies Meta<typeof WorkItemAgentRunsPanel>

export default meta

/** Story type of the Agent Run panel. */
type Story = StoryObj<typeof meta>

/** An active run with earlier finished runs. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Running')).toBeVisible()
    await expect(canvas.getByRole('button', { name: labels.release })).toBeEnabled()
    await expect(canvas.getByText('Paused')).toBeVisible()
  },
}

/** An active run whose lease expired. */
export const Stalled: Story = {
  args: { runs: [stalledAgentRunFixture] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Stalled')).toBeVisible()
    await expect(canvas.getByText(labels.stalledHint)).toBeVisible()
  },
}

/** The viewer can see the run but cannot release it. */
export const ReadOnly: Story = {
  args: { runs: agentRunFixtures.map((run) => ({ ...run, canRelease: false })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole('button', { name: labels.release })).toBeNull()
  },
}

/** No agent has claimed the task. */
export const Empty: Story = {
  args: { runs: [] },
}

/** Loading the history failed. */
export const LoadError: Story = {
  args: { runs: [], errorMessage: labels.loadError },
}

/** Japanese text. */
export const Japanese: Story = {
  args: { labels: createWorkItemAgentRunsLabels('ja') },
}
