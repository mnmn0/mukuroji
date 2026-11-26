import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { agentRunHandoffReportFixture, agentRunReportFixture } from '../agentRunFixtures'
import { AgentRunReportChips } from './AgentRunReportChips'
import { createAgentRunReportChipsLabels } from './agentRunReportLabels'

const labels = createAgentRunReportChipsLabels('en')

const meta = {
  title: 'Application/Work Items/Agent Run Report Chips',
  component: AgentRunReportChips,
  parameters: {
    layout: 'padded',
  },
  args: {
    labels,
    report: agentRunReportFixture,
  },
} satisfies Meta<typeof AgentRunReportChips>

export default meta

/** Story type of the report chips. */
type Story = StoryObj<typeof meta>

/** A verification report with results, links, and a changed file count. */
export const Verification: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('group', { name: labels.label })).toBeVisible()
    await expect(canvas.getByText('bun run server:test')).toBeVisible()
    await expect(canvas.getByRole('link', { name: /PR #12/ })).toHaveAttribute('rel', 'noreferrer noopener')
    await expect(canvas.getByText('7 files changed')).toBeVisible()
  },
}

/** A hand-off that asks a person to decide. */
export const Handoff: Story = {
  args: {
    report: agentRunHandoffReportFixture,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.decisionNeeded)).toBeVisible()
    await expect(canvas.getByText(labels.kinds.handoff)).toBeVisible()
  },
}

/** A reported pull request checked against GitHub: open, with passing checks and an approval. */
export const VerifiedPullRequest: Story = {
  args: {
    artifactStatuses: new Map([[
      'https://github.com/example/repo/pull/12',
      {
        url: 'https://github.com/example/repo/pull/12', provider: 'github', repository: 'example/repo', number: 12,
        verification: 'verified', checkedAt: '2026-11-26T00:00:00.000Z',
        pullRequest: { state: 'open', draft: false, headSha: 'a'.repeat(40), checks: 'success', review: 'approved' },
      },
    ]]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.artifactStatus.states.open)).toBeVisible()
    await expect(canvas.getByText(labels.artifactStatus.checks.success)).toBeVisible()
    await expect(canvas.getByText(labels.artifactStatus.reviews.approved)).toBeVisible()
  },
}

/** A reported pull request that the Workspace could not check is marked as not checked. */
export const UnverifiedPullRequest: Story = {
  args: {
    artifactStatuses: new Map([[
      'https://github.com/example/repo/pull/12',
      {
        url: 'https://github.com/example/repo/pull/12', provider: 'github', repository: 'example/repo', number: 12,
        verification: 'unverified', unverifiedReason: 'not-accessible', checkedAt: '2026-11-26T00:00:00.000Z',
      },
    ]]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.artifactStatus.unverified)).toBeVisible()
    await expect(canvas.getByTestId('agent-run-artifact-unverified'))
      .toHaveAttribute('title', labels.artifactStatus.unverifiedReasons['not-accessible'])
  },
}

/** Japanese text. */
export const Japanese: Story = {
  args: {
    labels: createAgentRunReportChipsLabels('ja'),
  },
}

/** A long command on a phone-width screen stays within the comment. */
export const LongCommandOnPhone: Story = {
  args: {
    report: {
      ...agentRunReportFixture,
      verifications: [{ command: `bun test ${'server/src/modules/agent-runs/'.repeat(8)}`, status: 'passed' }],
    },
  },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: labels.label })
    await expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth)
  },
}
