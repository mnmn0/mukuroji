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

/** Older runs exist beyond the newest page. */
export const TruncatedHistory: Story = {
  args: { hasMore: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.historyTruncated)).toBeVisible()
  },
}

/** Telemetry usage of the runs, as a Team manager sees it with the estimated cost. */
export const WithUsage: Story = {
  args: {
    runs: agentRunFixtures.map((run, index) => index === 0
      ? { ...run, usage: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 40_000, cacheCreationTokens: 500, requestCount: 7, estimatedCostMicroUsd: 412_000, models: ['claude-sonnet-5-5'], aiDurationMs: 0, byModel: [], hasMore: false } }
      : run),
    usageTotal: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 40_000, cacheCreationTokens: 500, requestCount: 7, estimatedCostMicroUsd: 412_000, models: ['claude-sonnet-5-5'], aiDurationMs: 0, byModel: [], hasMore: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.usageTotal)).toBeVisible()
  },
}

/** Where the time of the runs went, with requests of two models. */
export const WithActivity: Story = {
  args: {
    runs: agentRunFixtures.map((run, index) => index === 0
      ? {
          ...run,
          activity: {
            toolCount: 24, toolDurationMs: 312_000, toolFailureCount: 2,
            tools: [{ kind: 'builtin', name: 'Bash', count: 14, durationMs: 250_000, failureCount: 2 }],
            approvalWait: { count: 3, durationMs: 45_000 }, promptWait: { count: 1, durationMs: 180_000 }, hasMore: false,
          },
        }
      : run),
    usageTotal: {
      inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 40_000, cacheCreationTokens: 500, requestCount: 7, models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], aiDurationMs: 96_000,
      byModel: [
        { model: 'claude-haiku-5-5', inputTokens: 200, outputTokens: 100, cacheReadTokens: 4_000, cacheCreationTokens: 0, requestCount: 3, aiDurationMs: 12_000 },
        { model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 36_000, cacheCreationTokens: 500, requestCount: 4, aiDurationMs: 84_000 },
      ],
      hasMore: false,
    },
    activityTotal: {
      toolCount: 24, toolDurationMs: 312_000, toolFailureCount: 2,
      tools: [
        { kind: 'builtin', name: 'Bash', count: 14, durationMs: 250_000, failureCount: 2 },
        { kind: 'mcp', name: 'github/get_issue', count: 6, durationMs: 40_000, failureCount: 0 },
        { kind: 'skill', name: 'mukuroji-review', count: 1, durationMs: 22_000, failureCount: 0 },
      ],
      approvalWait: { count: 3, durationMs: 45_000 }, promptWait: { count: 1, durationMs: 180_000 }, hasMore: false,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.activityTitle)).toBeVisible()
    await expect(canvas.getByText(labels.modelsTitle)).toBeVisible()
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
