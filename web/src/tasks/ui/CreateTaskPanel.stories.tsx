import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test'
import type { ProjectMember } from '../../projects/api'
import { collaborationWorkspaceMemberFixtures } from '../../issues/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import type { CreateWorkItemInput } from '../api/tasks'
import {
  createDefaultDateRangeTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
} from '../model/taskSchedule'
import type { TaskCreateContext } from '../model/taskView'
import { CreateTaskPanel, type CreateTaskPanelProps } from './CreateTaskPanel'

const t = createTranslator('ja')
const assigneeOptions = [
  {
    id: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'member',
    updatedAt: '2026-07-24T00:00:00.000Z',
    workspaceStatus: 'active',
  },
  {
    id: 'suzuki@example.com',
    email: 'suzuki@example.com',
    name: '鈴木 大輔',
    role: 'member',
    updatedAt: '2026-07-24T00:00:00.000Z',
    workspaceStatus: 'active',
  },
] satisfies ProjectMember[]

const quickCaptureContext = {
  projectId: 'refero',
  schedule: {
    calendarPolicy: {
      holidays: ['2026-06-11'],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dueDate: '2026-06-12',
    mode: 'due-date',
    plannedEffortMinutes: 120,
  },
  source: 'table',
  teamId: 'core-team',
  workflowStatusId: 'backlog',
} satisfies TaskCreateContext

const detailedOnlyConfiguration = {
  ...teamWorkItemConfigurationFixture,
  workflow: {
    ...teamWorkItemConfigurationFixture.workflow,
    initialStatusId: 'ready',
    statuses: teamWorkItemConfigurationFixture.workflow.statuses.filter((status) =>
      status.category !== 'backlog',
    ),
  },
} satisfies typeof teamWorkItemConfigurationFixture

let rejectThenRetryAttempts = 0

/** Rejects the first create request so the story can verify recovery and retry. */
const rejectingSubmit = fn(async (input: CreateWorkItemInput) => {
  void input
  rejectThenRetryAttempts += 1
  if (rejectThenRetryAttempts === 1) {
    throw new Error('一度目の登録に失敗しました。')
  }
})

/** Props for the candidate lifecycle harness used by the assignee safety story. */
type AssigneeLifecycleHarnessProps = {
  /** Panel props supplied by the Storybook story. */
  panelProps: CreateTaskPanelProps
}

/**
 * Changes candidate order and membership without remounting the creation panel.
 *
 * @param props - Panel props shared by each candidate state.
 * @returns Candidate controls and the creation panel under test.
 */
function AssigneeLifecycleHarness({ panelProps }: AssigneeLifecycleHarnessProps) {
  const [options, setOptions] = useState<ProjectMember[]>([
    assigneeOptions[1]!,
  ])

  return (
    <>
      <div className="flex gap-2 bg-white p-3">
        <button
          data-testid="assignee-load-viewer"
          onClick={() => setOptions(assigneeOptions)}
          type="button"
        >
          候補を読み込む
        </button>
        <button
          data-testid="assignee-reorder"
          onClick={() => setOptions([assigneeOptions[1]!, assigneeOptions[0]!])}
          type="button"
        >
          候補順を更新
        </button>
        <button
          data-testid="assignee-remove-selected"
          onClick={() => setOptions([assigneeOptions[0]!])}
          type="button"
        >
          選択候補を削除
        </button>
      </div>
      <CreateTaskPanel
        {...panelProps}
        assigneeOptions={options}
        isAssigneeOptionsLoading={false}
      />
    </>
  )
}

/** Storybook metadata for the independent project task creation panel. */
const meta = {
  title: 'Application/Projects/Create Task Panel',
  component: CreateTaskPanel,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] py-6">
        <Story />
      </main>
    ),
  ],
  args: {
    assigneeOptions,
    configuration: teamWorkItemConfigurationFixture,
    isAssigneeOptionsLoading: false,
    isSubmitting: false,
    locale: 'ja',
    onCancel: fn(),
    onSubmit: fn(async (input: CreateWorkItemInput) => {
      void input
    }),
    projectId: 'refero',
    t,
    workspaceMembers: collaborationWorkspaceMemberFixtures,
  },
} satisfies Meta<typeof CreateTaskPanel>

export default meta

/** Story type for the independent project task creation panel. */
type Story = StoryObj<typeof meta>

/** Submits a valid task and all default custom-field values. */
export const SuccessfulSubmit: Story = {
  args: {
    initialMode: 'detailed',
    onSubmit: fn(async (input: CreateWorkItemInput) => {
      void input
    }),
  },
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement)

    await step('Enter the required task and custom-field values', async () => {
      await userEvent.type(
        canvas.getByRole('textbox', { name: 'タスク名' }),
        'オンボーディング導線を確認する',
      )
      await userEvent.selectOptions(
        canvas.getByRole('combobox', { name: '担当者' }),
        'sato@example.com',
      )
      await userEvent.type(
        canvas.getByRole('textbox', { name: 'Customer impact' }),
        'EnterpriseCustomersCanFinishOnboarding',
      )
    })

    await step('Submit the canonical task input', async () => {
      await userEvent.click(canvas.getByRole('button', { name: '登録' }))

      await expect(args.onSubmit).toHaveBeenCalledWith({
        assigneeUserId: 'sato@example.com',
        customFieldValues: {
          'customer-impact': 'EnterpriseCustomersCanFinishOnboarding',
          disciplines: ['frontend'],
          estimate: 8,
          'release-blocker': false,
          'risk-level': 'moderate',
          'story-points': 3,
        },
        priority: 'medium',
        schedule: createDefaultUnscheduledTaskSchedule(),
        title: 'オンボーディング導線を確認する',
        workItemTypeId: 'default',
        workflowStatusId: 'backlog',
      })
    })
  },
}

/** Captures a title using the inherited backlog status and default assignee. */
export const QuickCapture: Story = {
  args: {
    context: quickCaptureContext,
    currentUserProjectKey: 'sato@example.com',
    initialMode: 'quick',
    onSubmit: fn(async (input: CreateWorkItemInput) => {
      void input
    }),
  },
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement)

    await step('Enter a title in quick-capture mode', async () => {
      await userEvent.type(
        canvas.getByRole('textbox', { name: 'タスク名' }),
        'リリース前の確認事項を整理する',
      )
      await userEvent.click(canvas.getByRole('button', { name: '登録' }))
    })

    await expect(args.onSubmit).toHaveBeenCalledWith({
      assigneeUserId: 'sato@example.com',
      customFieldValues: {},
      priority: 'medium',
      quickCapture: true,
      schedule: quickCaptureContext.schedule,
      title: 'リリース前の確認事項を整理する',
      workItemTypeId: 'default',
      workflowStatusId: 'backlog',
    })
  },
}

/** Defaults quick capture to the authenticated viewer instead of the first candidate. */
export const QuickCaptureDefaultsToViewer: Story = {
  args: {
    context: {
      ...quickCaptureContext,
      assigneeUserId: undefined,
    },
    currentUserProjectKey: 'suzuki@example.com',
    initialMode: 'quick',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const assignee = canvas.getByRole('combobox', { name: '担当者' })

    await expect(assignee).toHaveValue('suzuki@example.com')
    await expect(assignee).toHaveDisplayValue(/自分/)
    await expect(canvas.getByRole('button', { name: 'クイック登録' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  },
}

/** Uses quick capture for ordinary header creation when the backlog workflow permits it. */
export const HeaderCreationDefaultsToQuickCapture: Story = {
  args: {
    context: { projectId: 'refero', source: 'header', teamId: 'core-team' },
    currentUserProjectKey: 'sato@example.com',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('button', { name: 'クイック登録' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(canvas.queryByRole('combobox', { name: 'ステータス' })).toBeNull()
  },
}

/** Keeps an inherited date range in detailed mode instead of dropping its dates. */
export const DateRangeContextRemainsDetailed: Story = {
  args: {
    context: {
      projectId: 'refero',
      schedule: createDefaultDateRangeTaskSchedule('2026-06-08', '2026-06-10'),
      source: 'calendar',
      teamId: 'core-team',
      workflowStatusId: 'backlog',
    },
    currentUserProjectKey: 'sato@example.com',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('button', { name: '詳細登録' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(canvas.queryByRole('button', { name: 'クイック登録' })).toBeNull()
    await expect(canvas.getByRole('combobox', { name: 'スケジュール種別' })).toHaveValue('date-range')
  },
}

/** Keeps an invalid inherited assignee visible until the user chooses a valid candidate. */
export const InvalidContextAssigneeRequiresChoice: Story = {
  args: {
    context: {
      ...quickCaptureContext,
      assigneeUserId: 'removed@example.com',
    },
    currentUserProjectKey: 'sato@example.com',
    initialMode: 'quick',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('combobox', { name: '担当者' })).toHaveValue('')
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      '引き継いだ担当者は現在の候補にいません。担当者を選択してください。',
    )
  },
}

/** Keeps assignee intent stable while candidates arrive, reorder, and remove a selection. */
export const AssigneeCandidateLifecycle: Story = {
  args: {
    context: {
      ...quickCaptureContext,
      assigneeUserId: undefined,
    },
    currentUserProjectKey: 'sato@example.com',
    initialMode: 'quick',
  },
  render: (args) => <AssigneeLifecycleHarness panelProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const assignee = canvas.getByRole('combobox', { name: '担当者' })

    await expect(assignee).toHaveValue('')
    await userEvent.click(canvas.getByTestId('assignee-load-viewer'))
    await expect(assignee).toHaveValue('sato@example.com')
    await userEvent.selectOptions(assignee, 'suzuki@example.com')
    await userEvent.click(canvas.getByTestId('assignee-reorder'))
    await expect(assignee).toHaveValue('suzuki@example.com')
    await userEvent.click(canvas.getByTestId('assignee-remove-selected'))
    await expect(assignee).toHaveValue('')
  },
}

/** Ignores same-tick duplicate submits while the first create request is pending. */
export const PendingSubmitBlocksDuplicate: Story = {
  args: {
    context: quickCaptureContext,
    currentUserProjectKey: 'sato@example.com',
    initialMode: 'quick',
    onSubmit: fn(async (input: CreateWorkItemInput) => {
      void input
      return new Promise<void>(() => undefined)
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.type(canvas.getByRole('textbox', { name: 'タスク名' }), '重複登録を防ぐ')
    const form = canvas.getByTestId('create-task-form')
    fireEvent.submit(form)
    fireEvent.submit(form)
    await expect(args.onSubmit).toHaveBeenCalledTimes(1)
    await expect(canvas.getByRole('button', { name: '登録中' })).toBeDisabled()
  },
}

/** Shows a rejected create, preserves the entered fields, and allows a retry. */
export const RejectThenRetry: Story = {
  args: {
    context: quickCaptureContext,
    currentUserProjectKey: 'sato@example.com',
    initialMode: 'quick',
    onSubmit: rejectingSubmit,
  },
  play: async ({ args, canvasElement }) => {
    rejectThenRetryAttempts = 0
    args.onSubmit.mockClear()
    const canvas = within(canvasElement)
    const title = canvas.getByRole('textbox', { name: 'タスク名' })
    const assignee = canvas.getByRole('combobox', { name: '担当者' })

    await userEvent.type(title, '再試行する登録')
    await userEvent.click(canvas.getByRole('button', { name: '登録' }))
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('一度目の登録に失敗しました。'))
    await expect(title).toHaveValue('再試行する登録')
    await expect(assignee).toHaveValue('sato@example.com')
    await expect(canvas.getByRole('button', { name: '登録' })).toBeEnabled()

    await userEvent.click(canvas.getByRole('button', { name: '登録' }))
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledTimes(2))
  },
}

/** Prevents IME confirmation Enter from submitting the form. */
export const CompositionEnterDoesNotSubmit: Story = {
  args: {
    context: quickCaptureContext,
    currentUserProjectKey: 'sato@example.com',
    initialMode: 'quick',
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const title = canvas.getByRole('textbox', { name: 'タスク名' })

    await userEvent.type(title, 'IME入力を保持する')
    expect(fireEvent.keyDown(title, { isComposing: true, key: 'Enter', keyCode: 229 })).toBe(false)
    await expect(args.onSubmit).not.toHaveBeenCalled()
    await userEvent.click(canvas.getByRole('button', { name: '登録' }))
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledTimes(1))
  },
}

/** Falls back to detailed creation when the configuration has no backlog status. */
export const DetailedWhenQuickCaptureUnavailable: Story = {
  args: {
    configuration: detailedOnlyConfiguration,
    initialMode: 'quick',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.queryByRole('button', { name: 'クイック登録' })).toBeNull()
    await expect(canvas.getByRole('button', { name: '詳細登録' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(canvas.getByRole('combobox', { name: '担当者' })).toBeVisible()
  },
}

/** Rejects a custom multi-select value that exceeds its configured item limit. */
export const CustomFieldValidation: Story = {
  args: {
    initialMode: 'detailed',
    onSubmit: fn(async (input: CreateWorkItemInput) => {
      void input
    }),
  },
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement)

    await step('Enter a task with too many disciplines', async () => {
      await userEvent.type(
        canvas.getByRole('textbox', { name: 'タスク名' }),
        'リリース対象を確認する',
      )
      await userEvent.selectOptions(
        canvas.getByRole('combobox', { name: '担当者' }),
        'suzuki@example.com',
      )
      await userEvent.type(
        canvas.getByRole('textbox', { name: 'Customer impact' }),
        'CustomersNeedACoordinatedRelease',
      )
      await userEvent.selectOptions(
        canvas.getByRole('listbox', { name: 'Disciplines' }),
        ['frontend', 'backend', 'design', 'research'],
      )
    })

    await step('Keep the invalid task in the form', async () => {
      await userEvent.click(canvas.getByRole('button', { name: '登録' }))

      await expect(canvas.getByRole('alert')).toHaveTextContent(
        '文字数または件数が上限を超えています。',
      )
      await expect(args.onSubmit).not.toHaveBeenCalled()
    })
  },
}

/** Keeps the entered form available while a create mutation error is displayed. */
export const MutationError: Story = {
  args: {
    initialMode: 'detailed',
    errorMessage: 'タスクを登録できませんでした。もう一度お試しください。',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.getByText('タスクを登録できませんでした。もう一度お試しください。'),
    ).toBeVisible()
    await expect(canvas.getByRole('textbox', { name: 'タスク名' })).toBeEnabled()
    await expect(canvas.getByRole('button', { name: '登録' })).toBeEnabled()
  },
}
