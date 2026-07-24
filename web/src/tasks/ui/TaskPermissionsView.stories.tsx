import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskPermissionsView } from './TaskPermissionsView'
import {
  taskViewStoryProjectMembers,
  taskViewStoryProjectUsers,
} from './TaskView.stories.fixtures'

const t = createTranslator('ja')

const meta = {
  title: 'Application/Projects/Task Views/Permissions',
  component: TaskPermissionsView,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    canManageProjectMembers: true,
    isProjectMembersLoading: false,
    isProjectUsersLoading: false,
    isSystemAdmin: false,
    projectId: 'refero',
    projectMembers: taskViewStoryProjectMembers,
    projectName: 'Refero',
    projectUserQuery: '',
    projectUsers: taskViewStoryProjectUsers,
    t,
    onLoadMoreProjectUsers: async () => undefined,
    onProjectUserQueryChange: () => undefined,
    onRemoveProjectMember: async () => undefined,
    onUpdateProjectMember: async () => undefined,
  },
} satisfies Meta<typeof TaskPermissionsView>

/** Storybook metadata for the independent project task permissions view. */
export default meta

/** Story type for the independent task permissions view. */
type Story = StoryObj<typeof meta>

/** Manageable project membership view. */
export const Default: Story = {}

/** Read-only project membership view. */
export const ReadOnly: Story = {
  args: {
    canManageProjectMembers: false,
  },
}
