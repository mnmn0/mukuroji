import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { ProjectDecisionEntry } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { createDecisionDateTimeFormatter } from '../model/projectDecisionMessages'
import type { ProjectDecisionReferenceOption } from './ProjectDecisionForm'
import { ProjectDecisionLogPanel } from './ProjectDecisionLogPanel'

const entries: ProjectDecisionEntry[] = [
  {
    id: 'decision-2',
    title: '認証基盤は Cognito を使う',
    content: '自前の認証は作らず、Cognito のユーザープールに寄せる。',
    rationale: '運用負荷と監査要件を考えると、マネージドサービスの方が安い。',
    decidedAt: '2026-11-20T05:00:00.000Z',
    deciderMemberIds: ['sato@example.com'],
    deciderNote: '週次定例',
    relatedWorkItemIds: ['wi-1'],
    sources: [
      { url: 'https://github.com/example/repo/blob/main/docs/adr/0003-auth.md', label: 'ADR 0003' },
      { url: 'https://example.slack.com/archives/C1/p1', label: 'Slack thread' },
    ],
    status: 'active',
    origin: 'project',
    recordedByMemberId: 'sato@example.com',
    revision: 1,
    createdAt: '2026-11-20T05:10:00.000Z',
    updatedAt: '2026-11-20T05:10:00.000Z',
  },
  {
    id: 'decision-1',
    title: '認証は自前で作る',
    content: '初期は自前のセッション管理で始める。',
    decidedAt: '2026-11-01T05:00:00.000Z',
    status: 'superseded',
    supersededByEntryId: 'decision-2',
    origin: 'work-item',
    recordedByMemberId: 'tanaka@example.com',
    revision: 2,
    createdAt: '2026-11-01T05:10:00.000Z',
    updatedAt: '2026-11-20T05:10:00.000Z',
  },
]

/** Project members who may be named as deciders. */
const memberOptions: ProjectDecisionReferenceOption[] = [
  { id: 'sato@example.com', label: '佐藤 花子' },
  { id: 'tanaka@example.com', label: '田中 太郎' },
]

/** Work Items of the Project. */
const workItemOptions: ProjectDecisionReferenceOption[] = [
  { id: 'wi-1', label: 'CORE-12 ログイン画面' },
  { id: 'wi-2', label: 'CORE-15 権限設定' },
]

const meta = {
  title: 'Projects/ProjectDecisionLogPanel',
  component: ProjectDecisionLogPanel,
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
    memberOptions,
    workItemOptions,
    formatDateTime: createDecisionDateTimeFormatter('ja'),
    t: createTranslator('ja'),
    onReload: () => undefined,
    onSave: async () => undefined,
  },
} satisfies Meta<typeof ProjectDecisionLogPanel>

/** Project decision log panel Storybook metadata. */
export default meta

/** Story type for Project decision log panel examples. */
type Story = StoryObj<typeof meta>

/** A Project member opens the form to record a new decision. */
export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('project-decision-log-add'))
    await expect(canvas.getByTestId('project-decision-form')).toBeVisible()
    await expect(canvas.getByTestId('project-decision-form-title')).toBeVisible()
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
  args: { t: createTranslator('en'), formatDateTime: createDecisionDateTimeFormatter('en') },
}

/** A failed load offers a retry. */
export const LoadError: Story = {
  args: { entries: undefined, hasLoadError: true },
}
