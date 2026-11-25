import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { ProjectCharterState, UpdateProjectCharterInput } from '@mukuroji/contracts'
import type { ProjectMember } from '../api'
import { createTranslator } from '../../shared/i18n/i18n'
import { ProjectCharterPanel } from './ProjectCharterPanel'

const members: readonly ProjectMember[] = [
  { id: 'demo@example.com', email: 'demo@example.com', name: 'Demo User', role: 'manager', workspaceStatus: 'active', updatedAt: '2026-06-08T00:00:00.000Z' },
  { id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子', role: 'member', workspaceStatus: 'active', updatedAt: '2026-06-08T00:00:00.000Z' },
]

const activeState: ProjectCharterState = {
  teamId: 'core-team',
  projectId: 'refero',
  lifecycleState: 'active',
  charter: {
    code: 'OPS-1',
    purpose: '問い合わせ対応を一元化し、一次回答までの時間を半分にする。',
    description: '旧ヘルプデスクから移行し、Team ごとの受付窓口を統合します。',
    owner: { userId: 'demo@example.com', displayName: 'Demo User' },
    sponsor: { userId: 'sato@example.com', displayName: '佐藤 花子' },
    plannedStartDate: '2026-04-01',
    plannedEndDate: '2027-03-31',
    tags: ['社内', '基盤刷新'],
    repositoryUrls: ['https://github.com/example/refero'],
  },
  revision: 3,
  updatedAt: '2026-06-10T00:00:00.000Z',
}

/** Save handler of the stories that do not save; typed so a story can return a saved state. */
const saveNothing: (input: UpdateProjectCharterInput) => Promise<ProjectCharterState | undefined> =
  async () => undefined

const meta = {
  title: 'Projects/ProjectCharterPanel',
  component: ProjectCharterPanel,
  decorators: [
    (Story) => (
      <div className="max-w-3xl bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    canDecideProposal: true,
    canEdit: true,
    members,
    state: activeState,
    t: createTranslator('ja'),
    onReload: () => undefined,
    onSave: saveNothing,
    onTransition: async () => undefined,
  },
} satisfies Meta<typeof ProjectCharterPanel>

/** Project charter panel Storybook metadata. */
export default meta

/** Story type for Project charter panel examples. */
type Story = StoryObj<typeof meta>

/** A Project manager edits an active Project and is asked to confirm before closing it. */
export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-lifecycle-closed'))
    await expect(canvas.getByTestId('project-lifecycle-close-confirmation')).toBeVisible()
  },
}

/** A proposed Project waits for a Workspace administrator to approve or reject it. */
export const ProposedForProjectManager: Story = {
  args: {
    canDecideProposal: false,
    state: { ...activeState, lifecycleState: 'proposed', charter: { tags: [], repositoryUrls: [] } },
  },
}

/** Viewers read a closed Project's charter without editing controls. */
export const ClosedReadOnly: Story = {
  args: {
    canEdit: false,
    state: { ...activeState, lifecycleState: 'closed' },
  },
}

/** English labels for an on-hold Project. */
export const EnglishOnHold: Story = {
  args: {
    state: { ...activeState, lifecycleState: 'on-hold' },
    t: createTranslator('en'),
  },
}

/** A failed load offers a retry. */
export const LoadError: Story = {
  args: {
    hasLoadError: true,
    state: undefined,
  },
}

/** Saving a new owner reports that the Project's health update owner moved too (ADR 0084). */
export const SaveMovesUpdateOwner: Story = {
  args: {
    onSave: async (input) => ({
      ...activeState,
      revision: input.expectedRevision + 1,
      updateOwnerSync: 'synced',
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-charter-save'))
    await expect(await canvas.findByText('憲章を保存し、進捗報告の担当者も新しい責任者に変更しました'))
      .toBeVisible()
  },
}

/** A save whose new owner cannot post updates says the update owner stayed. */
export const SaveKeepsUpdateOwner: Story = {
  args: {
    onSave: async (input) => ({
      ...activeState,
      revision: input.expectedRevision + 1,
      updateOwnerSync: 'owner-not-eligible',
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-charter-save'))
    await expect(await canvas.findByText(
      '憲章を保存しました。新しい責任者がこのプロジェクトのメンバーではないため、進捗報告の担当者は変わっていません',
    )).toBeVisible()
  },
}
