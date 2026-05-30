import type { Meta, StoryObj } from '@storybook/react-vite'
import { TaskScreen } from './TaskPage'
import type { ProjectTask } from '../tasks/api'

const storyTasks: ProjectTask[] = [
  {
    id: 'wireframe',
    titleKey: 'tasks.item.wireframe',
    assigneeKey: 'tasks.assignee.sato',
    status: 'in-progress',
    dueDate: '2025/05/26',
    priority: 'high',
  },
  {
    id: 'brand-guideline',
    titleKey: 'tasks.item.brandGuideline',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'review',
    dueDate: '2025/05/27',
    priority: 'medium',
  },
  {
    id: 'seo-research',
    titleKey: 'tasks.item.seoResearch',
    assigneeKey: 'tasks.assignee.yamamoto',
    status: 'todo',
    dueDate: '2025/05/29',
    priority: 'medium',
  },
  {
    id: 'competitor-report',
    titleKey: 'tasks.item.competitorReport',
    assigneeKey: 'tasks.assignee.tanaka',
    status: 'done',
    dueDate: '2025/06/03',
    priority: 'low',
  },
]

const meta = {
  title: 'Application/Projects/Task Page',
  component: TaskScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    locale: 'ja',
    projectId: 'refero',
    tasks: storyTasks,
    userInitial: 'J',
  },
} satisfies Meta<typeof TaskScreen>

export default meta

/**
 * タスク専用画面 Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * DynamoDB から取得したタスク一覧を表示する標準状態です。
 */
export const Default: Story = {}

/**
 * 認証とタスク取得中の loading 表示です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
  },
}

/**
 * 英語 locale でタスク一覧を表示する状態です。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}

/**
 * Lambda API の取得失敗を表示する状態です。
 */
export const LoadingError: Story = {
  args: {
    taskErrorMessage: 'Lambda returned 500.',
    tasks: [],
  },
}
