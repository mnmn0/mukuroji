import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { ProjectRaidEntry } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import type { ProjectRaidReferenceOption } from '../model/projectRaidLogExport'
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
    ownerMemberId: 'sato@example.com',
    relatedWorkItemIds: ['wi-1', 'wi-left'],
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

/** Project members who may own an entry. */
const ownerOptions: ProjectRaidReferenceOption[] = [
  { id: 'sato@example.com', label: '佐藤 花子' },
  { id: 'tanaka@example.com', label: '田中 太郎' },
]

/** Work Items of the Project; `wi-left` on the first entry is no longer among them. */
const workItemOptions: ProjectRaidReferenceOption[] = [
  { id: 'wi-1', label: 'CORE-12 部品の調達' },
  { id: 'wi-2', label: 'CORE-15 結合テスト' },
  { id: 'wi-3', label: 'CORE-18 帳票出力' },
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
    ownerOptions,
    workItemOptions,
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

/**
 * An editor changes the owner and the related Work Items of a risk. The related Work Item that
 * left the Project stays selected under its ID, so saving other fields keeps it.
 */
export const References: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByTestId('project-raid-log-entry-owner')[0]).toHaveTextContent('佐藤 花子')
    await expect(canvas.getAllByTestId('project-raid-log-entry-work-items')[0]).toHaveTextContent('wi-left')
    await userEvent.click(canvas.getByRole('button', { name: `${createTranslator('ja')('projects.raidLog.edit')}: ${entries[0]?.title ?? ''}` }))
    await userEvent.selectOptions(canvas.getByTestId('project-raid-log-owner'), 'tanaka@example.com')
    await userEvent.selectOptions(canvas.getByTestId('project-raid-log-related-add'), 'wi-2')
    const selected = canvas.getByTestId('project-raid-log-related-selected')
    await expect(selected).toHaveTextContent('CORE-12 部品の調達')
    await expect(selected).toHaveTextContent('CORE-15 結合テスト')
    await expect(selected).toHaveTextContent('wi-left')
    await userEvent.click(within(selected).getByRole('button', { name: createTranslator('ja')('projects.raidLog.related.remove').replace('{item}', 'CORE-12 部品の調達') }))
    await expect(selected).not.toHaveTextContent('CORE-12 部品の調達')
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

/** The Work Items to relate failed to load; the log stays usable and offers a retry. */
export const WorkItemOptionsError: Story = {
  args: { hasWorkItemOptionsError: true, workItemOptions: [], onReloadWorkItemOptions: () => undefined },
}

/** An open change request asks to move a Work Item; a Project manager approves it after a confirmation. */
export const ChangeRequestDecision: Story = {
  args: {
    canDecide: true,
    onDecide: async () => undefined,
    entries: [
      {
        id: 'cr-open',
        kind: 'change-request',
        title: 'リリース日を2週間延ばす',
        impact: 4,
        relatedWorkItemIds: ['wi-2'],
        scheduleChanges: [{ workItemId: 'wi-2', operation: { type: 'move', targetDate: '2026-12-10' } }],
        status: 'open',
        revision: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
      ...entries,
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('project-raid-log-entry-schedule')).toHaveTextContent('CORE-15 結合テスト を 2026-12-10 へ移動')
    await userEvent.click(canvas.getByTestId('project-raid-log-approve'))
    await expect(canvas.getByTestId('project-raid-log-decide-baseline')).toBeChecked()
    await expect(canvas.getByTestId('project-raid-log-approve-confirm')).toBeVisible()
  },
}

/** Another manager is approving a change request, so a note says who and until when others must wait. */
export const ChangeRequestHeld: Story = {
  args: {
    canDecide: true,
    onDecide: async () => undefined,
    entries: [
      {
        id: 'cr-held',
        kind: 'change-request',
        title: 'リリース日を2週間延ばす',
        impact: 4,
        relatedWorkItemIds: ['wi-2'],
        scheduleChanges: [{ workItemId: 'wi-2', operation: { type: 'move', targetDate: '2026-12-10' } }],
        approvalHold: { heldByMemberId: 'tanaka@example.com', heldAt: '2026-11-18T01:00:00.000Z', expiresAt: '2026-11-18T01:10:00.000Z' },
        status: 'open',
        revision: 2,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T01:00:00.000Z',
      },
      ...entries,
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('project-raid-log-approval-hold')).toHaveTextContent('田中 太郎 さんが承認しています')
  },
}

/** An author states the date change a change request asks for on a related Work Item. */
export const ChangeRequestDates: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-raid-log-add'))
    await userEvent.selectOptions(canvas.getByTestId('project-raid-log-kind'), 'change-request')
    await userEvent.selectOptions(canvas.getByTestId('project-raid-log-related-add'), 'wi-1')
    await userEvent.selectOptions(canvas.getByLabelText('変更: CORE-12 部品の調達'), 'resize')
    await expect(canvas.getByLabelText('新しい終了日: CORE-12 部品の調達')).toBeVisible()
  },
}
