import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { ProjectRaidEntry } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { ProjectRaidLogPanel } from './ProjectRaidLogPanel'

const entries: ProjectRaidEntry[] = [
  {
    id: 'risk-1',
    kind: 'risk',
    title: '主要部品のベンダー納期遅延',
    description: '部品の納期が未確定で、結合テストの開始が遅れる可能性がある。',
    probability: 4,
    impact: 4,
    response: '代替ベンダーと並行で見積もりを取る。',
    reviewDueDate: '2026-11-10',
    status: 'open',
    revision: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  },
  {
    id: 'issue-1',
    kind: 'issue',
    title: 'ステージング環境のビルドが失敗する',
    impact: 3,
    reviewDueDate: '2026-11-25',
    status: 'open',
    revision: 1,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
  },
  {
    id: 'cr-1',
    kind: 'change-request',
    title: '帳票出力を範囲に追加',
    impact: 5,
    response: '次フェーズで対応することで合意。',
    status: 'closed',
    revision: 3,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    closedAt: '2026-11-02T00:00:00.000Z',
  },
]

const meta = {
  title: 'Projects/ProjectRaidLogPanel',
  component: ProjectRaidLogPanel,
  decorators: [
    (Story) => (
      <div className="max-w-3xl bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    canEdit: true,
    entries,
    hasLoadError: false,
    isLoading: false,
    t: createTranslator('ja'),
    today: '2026-11-19',
    onReload: () => undefined,
    onSave: async () => undefined,
  },
} satisfies Meta<typeof ProjectRaidLogPanel>

/** Project log panel Storybook metadata. */
export default meta

/** Story type for Project log panel examples. */
type Story = StoryObj<typeof meta>

/** A Project member opens the form to add a new risk. */
export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-raid-log-add'))
    await expect(canvas.getByTestId('project-raid-log-form')).toBeVisible()
    await expect(canvas.getByTestId('project-raid-log-probability')).toBeVisible()
  },
}

/** A Project viewer reads the log without editing controls. */
export const ReadOnly: Story = {
  args: { canEdit: false },
}

/** A Project with nothing recorded yet. */
export const Empty: Story = {
  args: { entries: [] },
}

/** English labels. */
export const English: Story = {
  args: { t: createTranslator('en') },
}

/** A failed load offers a retry. */
export const LoadError: Story = {
  args: { entries: undefined, hasLoadError: true },
}
