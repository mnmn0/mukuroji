import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { referoTaskFixtures } from '../fixtures'
import { TaskHeader } from './TaskHeader'

/** Isolated project navigation and summary coverage. */
const meta = {
  title: 'Application/Tasks/Header',
  component: TaskHeader,
  args: {
    activeTab: 'board', isProjectQuickAccess: false, isCreateTaskOpen: false,
    onCreateTaskOpenChange: fn(), onMobileSidebarOpen: fn(), onProjectQuickAccessToggle: fn(),
    onTabChange: fn(), projectName: 'プロダクト改善', teamName: '開発チーム',
    tasks: referoTaskFixtures, userInitial: 'M', t: createTranslator('ja'),
  },
} satisfies Meta<typeof TaskHeader>
export default meta
/** Typed project header story. */
type Story = StoryObj<typeof meta>
/** Compact counters and one primary creation action. */
export const Default: Story = {}
/** Long project names and tab navigation at phone width. */
export const Mobile: Story = {
  args: { projectName: 'プロダクトの初回セットアップとアクセス権限の改善' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
