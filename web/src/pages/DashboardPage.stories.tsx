import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProjectTaskScreen } from './DashboardPage'

const meta = {
  title: 'Application/Projects/Task Screen',
  component: ProjectTaskScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    locale: 'ja',
    userInitial: 'J',
  },
} satisfies Meta<typeof ProjectTaskScreen>

export default meta

/**
 * プロジェクトタスク画面 Story の型です。
 */
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = {
  args: {
    isLoading: true,
  },
}

export const English: Story = {
  args: {
    locale: 'en',
  },
}
