import type { AiPlanningDraft } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import type { TeamIssueDetail, UpdateTeamIssueInput } from '../../issues/api'
import { collaborationWorkspaceMemberFixtures } from '../../issues/fixtures'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import {
  TaskDetailPane,
  type TaskDetailAiAssistanceRenderContext,
  type TaskDetailAiAssistanceRenderer,
  type TaskDetailPaneProps,
} from './TaskDetailPane'
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

/** Local Planning draft used to exercise the neutral Task detail renderer slot. */
const storyAiPlanningDraft = {
  kind: 'planning',
  title: {
    value: 'Complete launch accessibility review',
    reason: 'The remaining launch gate needs a final accessibility review.',
    confidence: 'high',
    citationIds: [],
  },
  priority: {
    value: 'high',
    reason: 'The review blocks the staged launch window.',
    confidence: 'medium',
    citationIds: [],
  },
  status: {
    value: 'review',
    reason: 'The final review is active.',
    confidence: 'medium',
    citationIds: [],
  },
  plannedEffortMinutes: {
    value: 240,
    reason: 'The review is expected to take two hours.',
    confidence: 'low',
    citationIds: [],
  },
  subtasks: [],
  dependencies: [],
} satisfies AiPlanningDraft

/** Props for the local planning slot fixture used by Task detail stories. */
type StoryPlanningAssistantProps = {
  /** Neutral renderer context supplied by the Task detail pane. */
  context: TaskDetailAiAssistanceRenderContext
}

/**
 * Renders a local planning-slot fixture without coupling Task UI stories to AI feature internals.
 *
 * @param props - Neutral Task detail renderer context.
 * @returns A review-only planning fixture with the same adoption boundary as the feature.
 */
function StoryPlanningAssistant({ context }: StoryPlanningAssistantProps) {
  const [isConfirmationVisible, setConfirmationVisible] = useState(false)
  const canAdopt = context.aiAssistanceEnabled && !context.isMutationPending &&
    (context.canAdoptPlanningDraft?.(storyAiPlanningDraft) ?? true)

  /** Opens the replacement confirmation or stages the local fixture draft. */
  const adopt = () => {
    if (!canAdopt) return
    if (
      context.requirePlanningAdoptionConfirmation ||
      context.shouldConfirmPlanningAdoption?.(storyAiPlanningDraft)
    ) {
      setConfirmationVisible(true)
      return
    }
    context.onPlanningAdopt?.(storyAiPlanningDraft)
  }

  if (!context.aiAssistanceEnabled) return null

  return (
    <section className="grid gap-3 border-y border-[var(--workbench-border)] py-4" data-testid="story-ai-planning">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {context.t('ai.planning.workItem.title')}
          </h3>
          <p className="text-xs font-medium text-[var(--workbench-muted)]">
            {context.t('ai.planning.workItem.description')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-[44px] px-4"
          disabled={!canAdopt}
          onClick={adopt}
          type="button"
        >
          {context.t('ai.planning.workItem.adopt')}
        </button>
      </div>
      <p className="text-sm font-medium text-[var(--workbench-muted)]">
        {context.t('ai.planning.field.effort')}: {context.t('ai.planning.effort.minutes').replace(
          '{minutes}',
          String(storyAiPlanningDraft.plannedEffortMinutes?.value ?? 0),
        )}
      </p>
      {isConfirmationVisible ? (
        <div className="border-l-2 border-amber-500 bg-amber-50 px-4 py-3" role="alert">
          <p className="text-sm font-semibold">{context.t('ai.planning.replaceDraftTitle')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary min-h-[44px] px-4"
              onClick={() => setConfirmationVisible(false)}
              type="button"
            >
              {context.t('ai.planning.keepManualDraft')}
            </button>
            <button
              className="workbench-button-primary min-h-[44px] px-4"
              onClick={() => {
                setConfirmationVisible(false)
                context.onPlanningAdopt?.(storyAiPlanningDraft)
              }}
              type="button"
            >
              {context.t('ai.planning.replaceManualDraft')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Creates the local neutral renderer supplied to Task detail stories.
 *
 * @param enabled - Whether this story should render its planning fixture.
 * @returns A renderer that keeps the Task story independent from AI feature internals.
 */
function createStoryAiAssistanceRenderer(enabled: boolean): TaskDetailAiAssistanceRenderer {
  return (context) => ({
    planning: enabled ? <StoryPlanningAssistant context={context} /> : undefined,
  })
}

/** Storybook metadata for the independent selected-task detail pane. */
type TaskDetailPaneStoryArgs = TaskDetailPaneProps & {
  /** Whether this story should mount the local neutral AI planning slot fixture. */
  showAiAssistance?: boolean
}

const meta = {
  title: 'Application/Projects/Task Views/Detail Pane',
  render: ({ showAiAssistance = false, ...args }) => (
    <TaskDetailPane
      {...args}
      renderAiAssistance={createStoryAiAssistanceRenderer(showAiAssistance)}
    />
  ),
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
} satisfies Meta<TaskDetailPaneStoryArgs>

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

/** Evidence-first Work Item plan with fields, effort, child work, and dependencies. */
export const AiWorkPlan: Story = {
  args: {
    onUpdateIssue: createUpdateIssueSpy(),
    showAiAssistance: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', {
      name: '対応する項目をフォームで使用',
    }))

    await expect(canvas.getByRole('textbox', { name: 'Issue' }))
      .toHaveValue('Complete launch accessibility review')
    await expect(canvas.getByRole('combobox', { name: '優先度' }))
      .toHaveValue('high')
    await expect(canvas.getByRole('combobox', { name: 'ステータス' }))
      .toHaveValue('review')
    await expect(canvas.getByRole('spinbutton', { name: '予定工数（分）' }))
      .toHaveValue(null)
    await expect(canvas.getByText('予定工数 · レビュー専用')).toBeVisible()
    await expect(args.onUpdateIssue).not.toHaveBeenCalled()

    const customerImpactInput = canvas.getByRole('textbox', {
      name: 'Customer impact',
    })
    await userEvent.clear(customerImpactInput)
    await userEvent.type(customerImpactInput, 'AccessibilityReviewReady')
    await userEvent.click(canvas.getByRole('button', { name: '変更を保存' }))
    await expect(args.onUpdateIssue).toHaveBeenCalledTimes(1)
    await expect(args.onUpdateIssue).toHaveBeenCalledWith(
      'core-team',
      'wireframe',
      expect.objectContaining({
        priority: 'high',
        title: 'Complete launch accessibility review',
        workflowStatusId: 'review',
      }),
    )
  },
}

/** Manual supported-field edits are confirmed before the audited approval decision. */
export const AiWorkPlanWithManualEdits: Story = {
  args: {
    onUpdateIssue: createUpdateIssueSpy(),
    showAiAssistance: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const titleInput = canvas.getByRole('textbox', { name: 'Issue' })

    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, 'Keep this manual title')
    await userEvent.click(canvas.getByRole('button', {
      name: '対応する項目をフォームで使用',
    }))

    await expect(canvas.getByText('手動の編集を保持しますか？')).toBeVisible()
    await expect(args.onUpdateIssue).not.toHaveBeenCalled()

    await userEvent.click(canvas.getByRole('button', { name: '手動の編集を保持' }))
    await expect(titleInput).toHaveValue('Keep this manual title')

    await userEvent.click(canvas.getByRole('button', {
      name: '対応する項目をフォームで使用',
    }))
    await userEvent.click(canvas.getByRole('button', { name: 'AI draft で置き換え' }))

    await expect(canvas.getByRole('textbox', { name: 'Issue' }))
      .toHaveValue('Complete launch accessibility review')
    await expect(args.onUpdateIssue).not.toHaveBeenCalled()
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
