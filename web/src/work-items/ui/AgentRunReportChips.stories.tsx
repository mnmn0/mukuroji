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
