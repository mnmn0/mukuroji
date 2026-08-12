import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import type { TeamIssueDetail, UpdateTeamIssueInput } from '../../issues/api'
import { collaborationWorkspaceMemberFixtures } from '../../issues/fixtures'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { TaskDetailPane } from './TaskDetailPane'
import {
  taskViewStoryProjectMembers,
  taskViewStoryPlanningSnapshot,
  taskViewStorySelectedIssueDetail,
  taskViewStorySelectedTask,
  taskViewStoryTasks,
} from './TaskView.stories.fixtures'

const t = createTranslator('ja')

const taskDetailStoryProjects = [
  { id: 'refero', name: 'Refero', tone: 'blue' },
  { id: 'product-roadmap', name: 'プロダクトロードマップ', tone: 'yellow' },
] satisfies ProjectDirectoryTeam['projects']

const mismatchedIssueDetail = {
  ...taskViewStorySelectedIssueDetail,
  issue: {
    ...taskViewStorySelectedIssueDetail.issue,
    id: 'different-task',
    title: '別のタスクの古い詳細',
  },
} satisfies TeamIssueDetail

/**
 * Creates an isolated successful update spy for an interactive detail-pane story.
 *
 * @returns A promise-returning update callback whose calls Storybook can inspect.
 */
function createUpdateIssueSpy() {
  return fn(async (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => {
    void teamId
    void issueId
    void input
  })
}

/** Storybook metadata for the independent selected-task detail pane. */
const meta = {
  title: 'Application/Projects/Task Views/Detail Pane',
  render: (args) => <TaskDetailPane {...args} />,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-[var(--workbench-border)]">
          <Story />
        </div>
      </main>
    ),
  ],
  args: {
    assigneeOptions: taskViewStoryProjectMembers,
    configuration: teamWorkItemConfigurationFixture,
    currentWorkspaceMemberKey: 'demo@example.com',
    detail: taskViewStorySelectedIssueDetail,
    isLoading: false,
    isRelationCandidatesLoading: false,
    locale: 'ja',
    planningSnapshot: taskViewStoryPlanningSnapshot,
    projects: taskDetailStoryProjects,
    relationCandidates: taskViewStoryTasks.filter(
      (candidate) => candidate.id !== taskViewStorySelectedTask.id,
    ),
    t,
    task: taskViewStorySelectedTask,
    workspaceMembers: collaborationWorkspaceMemberFixtures,
  },
} satisfies Meta<typeof TaskDetailPane>

export default meta

/** Story type for the independent selected-task detail pane. */
type Story = StoryObj<typeof meta>

/** Editable detail pane that submits the changed canonical Work Item fields. */
export const Default: Story = {
  args: {
    onUpdateIssue: createUpdateIssueSpy(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const titleInput = canvas.getByRole('textbox', { name: 'Issue' })

    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, '更新済みワイヤーフレームを確認する')
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'ステータス' }),
      'review',
    )
    const customerImpactInput = canvas.getByRole('textbox', {
      name: 'Customer impact',
    })
    await userEvent.clear(customerImpactInput)
    await userEvent.type(
      customerImpactInput,
      'EnterpriseCustomersCanCompleteSetup',
    )
    await userEvent.click(canvas.getByRole('button', { name: '変更を保存' }))

    await expect(args.onUpdateIssue).toHaveBeenCalledTimes(1)
    await expect(args.onUpdateIssue).toHaveBeenCalledWith(
      'core-team',
      'wireframe',
      expect.objectContaining({
        assignedProjectId: 'refero',
        title: '更新済みワイヤーフレームを確認する',
        workflowStatusId: 'review',
      }),
    )
  },
}

/** Selected task whose detail response is still loading and cannot yet be edited. */
export const Loading: Story = {
  args: {
    detail: undefined,
    isLoading: true,
    onUpdateIssue: createUpdateIssueSpy(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('詳細を確認しています。')).toBeVisible()
    await expect(canvas.getByRole('button', { name: '変更を保存' })).toBeDisabled()
  },
}

/** Loaded detail pane displaying a recoverable query or mutation error. */
export const Error: Story = {
  args: {
    errorMessage: 'Issue 詳細を保存できませんでした。',
    onUpdateIssue: createUpdateIssueSpy(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Issue 詳細を保存できませんでした。')).toBeVisible()
    await expect(canvas.getByRole('button', { name: '変更を保存' })).toBeEnabled()
  },
}

/** Matching detail rendered without update permission. */
export const ReadOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('textbox', { name: 'Issue' })).toBeDisabled()
    await expect(canvas.getByRole('button', { name: '変更を保存' })).toBeDisabled()
    await expect(
      canvas.getByText(
        'このタスクを編集する権限がありません。Workspace の owner または admin に依頼してください。',
      ),
    ).toBeVisible()
  },
}

/** Stale detail for another task is ignored while the current task remains read-only. */
export const MismatchedDetail: Story = {
  args: {
    detail: mismatchedIssueDetail,
    onUpdateIssue: createUpdateIssueSpy(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const titleInput = canvas.getByRole('textbox', { name: 'Issue' })

    await expect(titleInput).toHaveValue(taskViewStorySelectedTask.title)
    await expect(titleInput).toBeDisabled()
    await expect(canvas.queryByDisplayValue('別のタスクの古い詳細')).not.toBeInTheDocument()
    await expect(canvas.getByRole('button', { name: '変更を保存' })).toBeDisabled()
  },
}

/** Detail pane shown before a task has been selected. */
export const Empty: Story = {
  args: {
    detail: undefined,
    task: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.getByText('タスクを選択すると詳細を確認できます。'),
    ).toBeVisible()
    await expect(canvas.queryByRole('button', { name: '変更を保存' })).not.toBeInTheDocument()
  },
}
