import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import type { DirectoryAdministrationTeam } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import type { ProjectMember } from '../api/members'
import { listTeamProfileProjects, summarizeTeamProfileMembers } from '../model/teamProfile'
import { TeamProfilePanel } from './TeamProfilePanel'

const team: DirectoryAdministrationTeam = {
  id: 'core-team',
  nameJa: 'コアチーム',
  nameEn: 'Core Team',
  description: '認証と請求の基盤を担当するチームです。',
  leaderMemberKey: 'sato@example.com',
  projects: [
    { id: 'refero', nameJa: 'Refero', nameEn: 'Refero', tone: 'blue' },
    { id: 'billing', nameJa: '請求基盤', nameEn: 'Billing', tone: 'green' },
  ],
}

const designTeam: DirectoryAdministrationTeam = {
  id: 'design',
  nameJa: 'デザイン',
  nameEn: 'Design',
  projects: [],
}

/** Fields every stored Project member row has. */
const storedMember = {
  workspaceStatus: 'active',
  updatedAt: '2026-11-01T00:00:00.000Z',
} satisfies Pick<ProjectMember, 'workspaceStatus' | 'updatedAt'>

const members = summarizeTeamProfileMembers(
  [
    {
      projectId: 'refero',
      projectName: 'Refero',
      member: { ...storedMember, id: 'sato@example.com', email: 'sato@example.com', name: '佐藤', role: 'manager' },
    },
    {
      projectId: 'billing',
      projectName: '請求基盤',
      member: { ...storedMember, id: 'sato@example.com', email: 'sato@example.com', name: '佐藤', role: 'member' },
    },
    {
      projectId: 'billing',
      projectName: '請求基盤',
      member: { ...storedMember, id: 'tanaka@example.com', email: 'tanaka@example.com', role: 'viewer' },
    },
  ],
  listTeamProfileProjects(team, 'ja'),
)

const meta = {
  title: 'Projects/TeamProfilePanel',
  component: TeamProfilePanel,
  decorators: [
    (Story) => (
      <div className="max-w-3xl bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    teams: [team, designTeam],
    team,
    projectCount: 2,
    members,
    membersLoading: false,
    membersPartial: false,
    workspaceMembers: [
      { memberKey: 'sato@example.com', label: '佐藤' },
      { memberKey: 'suzuki@example.com', label: '鈴木' },
      { memberKey: 'tanaka@example.com', label: 'tanaka@example.com' },
    ],
    workspaceMembersStatus: 'ready',
    pending: false,
    locale: 'ja',
    t: createTranslator('ja'),
    onSelectTeam: () => undefined,
    onSaveProfile: async () => true,
    onAddMember: async (teamId) => ({
      teamId,
      memberKey: 'suzuki@example.com',
      addedProjectIds: ['billing'],
      existingProjectIds: ['refero'],
    }),
    onRetryWorkspaceMembers: () => undefined,
    onRetryMembers: () => undefined,
  },
} satisfies Meta<typeof TeamProfilePanel>

export default meta

type Story = StoryObj<typeof meta>

/** Description, leader, the members of every Project, and the form that adds to all of them. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText('リーダー')).toHaveValue('sato@example.com')
  },
}

/** A Team without active Projects, where no member can be added. */
export const WithoutProjects: Story = {
  args: { team: designTeam, projectCount: 0, members: [] },
}

/** The member list of some Projects could not be read. */
export const PartialMembers: Story = {
  args: { membersPartial: true },
}

/** The Workspace members failed to load, so choices are disabled and a retry is offered. */
export const WorkspaceMembersError: Story = {
  args: { workspaceMembers: [], workspaceMembersStatus: 'error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: '再読み込み' })).toBeEnabled()
  },
}

/** A failed add of a member who is no longer active. */
export const InactiveMember: Story = {
  args: {
    errorMessage: createTranslator('ja')('projects.teamProfile.error.memberInactive'),
  },
}
