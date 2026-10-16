import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { createTranslator } from '../../../shared/i18n/i18n'
import { CollectionsWorkspace } from './CollectionsWorkspace'

/** Storybook metadata for the Collections workspace. */
const meta = {
  title: 'Application/Collections/Workspace',
  component: CollectionsWorkspace,
  args: {
    t: createTranslator('ja'),
    collections: [
      { collectionId: 'c1', name: 'Q4 ローンチ', description: '部門横断のローンチ準備', createdBy: 'sato@example.com', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', revision: 3 },
      { collectionId: 'c2', name: 'アクセシビリティ', createdBy: 'sato@example.com', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', revision: 1 },
    ],
    collectionsFailed: false,
    selectedId: 'c1',
    items: [
      { teamId: 'core-team', issueId: 'onboarding', title: '初回オンボーディングの離脱要因を減らす', statusCategory: 'started', assignedProjectId: 'refero', addedAt: '2026-10-10T00:00:00.000Z' },
      { teamId: 'growth', issueId: 'pricing', title: '料金ページの比較表を更新する', statusCategory: 'unstarted', addedAt: '2026-10-09T00:00:00.000Z' },
    ],
    itemsFailed: false,
    candidates: [{ teamId: 'core-team', issueId: 'help-center', title: 'ヘルプセンターの導線を整理する' }],
    canEdit: true,
    pending: false,
    workItemHref: (teamId: string, issueId: string) => `/teams/${teamId}/issues?issueId=${issueId}`,
    onSelect: () => undefined,
    onCreate: async () => true,
    onRename: async () => true,
    onDelete: () => undefined,
    onAddItem: () => undefined,
    onRemoveItem: () => undefined,
  },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <main className="min-h-screen bg-[var(--workbench-page)] p-6">
          <Story />
        </main>
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof CollectionsWorkspace>

export default meta

/** Story type for the Collections workspace. */
type Story = StoryObj<typeof meta>

/** A Collection with Work Items from two Teams. */
export const Default: Story = {}

/** View-only members see Collections without change controls. */
export const ReadOnly: Story = {
  args: { canEdit: false },
}

/** An empty Workspace before the first Collection. */
export const Empty: Story = {
  args: { collections: [], selectedId: undefined, items: undefined },
}
