import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import type { ProjectMember } from '../../projects/api'
import { collaborationWorkspaceMemberFixtures } from '../../issues/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import type { CreateProjectTaskInput } from '../api/tasks'
import { createDefaultUnscheduledTaskSchedule } from '../model/taskSchedule'
import type { TaskCreateContext } from '../model/taskView'
import { CreateTaskPanel } from './CreateTaskPanel'

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
    onSubmit: fn(async (input: CreateProjectTaskInput) => {
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
    onSubmit: fn(async (input: CreateProjectTaskInput) => {
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
        workflowStatusId: 'backlog',
      })
    })
  },
}

/** Captures a title using the inherited backlog status and default assignee. */
export const QuickCapture: Story = {
  args: {
    context: quickCaptureContext,
    initialMode: 'quick',
    onSubmit: fn(async (input: CreateProjectTaskInput) => {
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
      workflowStatusId: 'backlog',
    })
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
    onSubmit: fn(async (input: CreateProjectTaskInput) => {
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
