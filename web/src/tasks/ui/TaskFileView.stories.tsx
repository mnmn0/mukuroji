import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { collaborationWorkspaceMemberFixtures } from '../../issues/fixtures'
import { TaskFileView } from './TaskFileView'
import { taskViewStoryProjectFiles } from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Storybook metadata for the independent project task file view. */
const meta = {
  title: 'Application/Projects/Task Views/File',
  component: TaskFileView,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    currentWorkspaceMemberKey: 'demo@example.com',
    locale: 'ja',
    projectFiles: taskViewStoryProjectFiles,
    t,
    workspaceMembers: collaborationWorkspaceMemberFixtures,
  },
} satisfies Meta<typeof TaskFileView>

export default meta

/** Story type for the independent task file view. */
type Story = StoryObj<typeof meta>

/** Project-scoped file controller view. */
export const Default: Story = {}
