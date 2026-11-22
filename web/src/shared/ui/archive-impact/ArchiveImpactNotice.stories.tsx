import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { createArchiveImpactLabels, createTranslator } from '../../i18n/i18n'
import { ArchiveImpactNotice } from './ArchiveImpactNotice'
import type { ArchiveImpactSummary } from './archiveImpact'

/** Impact with nothing affected, overridden per story. */
const emptyImpact: ArchiveImpactSummary = {
  openWorkItems: { count: 0, hasMore: false },
  activeAgentRuns: { count: 0, hasMore: false },
  planningEntities: 0,
  planningWorkItemLinks: 0,
  planningDependencies: 0,
  webhookSubscriptions: 0,
  archiveBlocked: false,
}

const meta = {
  title: 'Design System/Archive Impact Notice',
  component: ArchiveImpactNotice,
  args: {
    labels: createArchiveImpactLabels(createTranslator('ja')),
    state: {
      status: 'ready',
      impact: {
        ...emptyImpact,
        openWorkItems: { count: 2000, hasMore: true },
        activeAgentRuns: { count: 2, hasMore: false },
        webhookSubscriptions: 1,
      },
    },
  },
  decorators: [(Story) => <div className="max-w-[440px] p-6"><Story /></div>],
} satisfies Meta<typeof ArchiveImpactNotice>

/** Counts shown in the Team and Project archive confirmations. */
export default meta

/** Story variants of the archive impact notice. */
type Story = StoryObj<typeof meta>

/** Warnings that still allow the archive, with a count that stopped early. */
export const Warnings: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('未完了の Work Item: 2,000 件以上')).toBeVisible()
  },
}

/** Planning references that block the archive. */
export const Blocked: Story = {
  args: {
    state: {
      status: 'ready',
      impact: {
        ...emptyImpact,
        openWorkItems: { count: 3, hasMore: false },
        planningEntities: 1,
        planningWorkItemLinks: 4,
        archiveBlocked: true,
      },
    },
  },
}

/** Nothing is affected. */
export const NothingAffected: Story = {
  args: { state: { status: 'ready', impact: emptyImpact } },
}

/** The counts are loading. */
export const Loading: Story = {
  args: { state: { status: 'loading' } },
}

/** English copy fits the same layout. */
export const English: Story = {
  args: { labels: createArchiveImpactLabels(createTranslator('en')) },
}
