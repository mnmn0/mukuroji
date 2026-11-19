import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import type { TeamIssue } from '../api/workItems'
import { teamIssueFixtures } from '../fixtures'
import { ArchivedWorkItemsPanel } from './ArchivedWorkItemsPanel'

const [firstFixture, secondFixture] = teamIssueFixtures

const archivedWorkItems: TeamIssue[] = [
  {
    ...secondFixture,
    key: 'CORE-2',
    archivedAt: '2026-06-10T09:30:00.000Z',
    archivedBy: 'suzuki@example.com',
  },
  {
    ...firstFixture,
    key: 'CORE-1',
    archivedAt: '2026-06-09T02:00:00.000Z',
    archivedBy: 'sato@example.com',
  },
]

const meta = {
  title: 'Application/Issues/Archived Work Items',
  component: ArchivedWorkItemsPanel,
  args: {
    canRestore: () => true,
    defaultOpen: true,
    isLoading: false,
    locale: 'ja',
    onOpenChange: fn(),
    onRestore: fn(),
    onRetry: fn(),
    t: createTranslator('ja'),
    workItems: archivedWorkItems,
  },
} satisfies Meta<typeof ArchivedWorkItemsPanel>

/** Archived Work Items of a Team or Project with a restore button for each. */
export default meta

/** Story variants for the list states. */
type Story = StoryObj<typeof meta>

/** Restores one archived Work Item. */
export const Restore: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: `復元: ${firstFixture.title}` }))
    await expect(args.onRestore).toHaveBeenCalledWith(archivedWorkItems[1])
  },
}

/** A viewer without write access sees the list without restore buttons. */
export const ReadOnly: Story = {
  args: { onRestore: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button', { name: /復元/u })).toBeNull()
  },
}

/** No archived Work Items. */
export const Empty: Story = {
  args: { workItems: [] },
}

/** The list could not be read. */
export const LoadError: Story = {
  args: { errorMessage: 'アーカイブ済み Work Item を読み込めませんでした', workItems: undefined },
}
