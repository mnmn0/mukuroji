import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import type { DirectoryAdministrationTeam, UpdateDirectoryTeamProfileInput } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import type { ProjectMember } from '../api/members'
import { listTeamProfileProjects, summarizeTeamProfileMembers } from '../model/teamProfile'
import { TeamProfilePanel, type TeamProfilePanelProps } from './TeamProfilePanel'

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

/**
 * Stores saves in local state, as the reloaded directory would, so the form remounts after a save.
 *
 * @param props - Story args of the panel.
 * @returns The panel over a Team that changes on save.
 */
function SavingTeamProfilePanel(props: TeamProfilePanelProps) {
  const [current, setCurrent] = useState(team)
  const save = async (_teamId: string, input: UpdateDirectoryTeamProfileInput) => {
    setCurrent(({ leaderMemberKey: _cleared, ...previous }) => ({
      ...previous,
      description: input.description,
      // Choosing no leader clears the stored one, as the server does.
      ...(input.leaderMemberKey === null ? {} : { leaderMemberKey: input.leaderMemberKey }),
      profileRevision: (previous.profileRevision ?? 0) + 1,
    }))
    return true
  }
  return <TeamProfilePanel {...props} team={current} teams={[current, designTeam]} onSaveProfile={save} />
}

/** A saved change reloads the Team, and the confirmation stays after the form is rebuilt. */
export const SavedAfterReload: Story = {
  render: (args) => <SavingTeamProfilePanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const description = canvas.getByLabelText('説明')
    await userEvent.clear(description)
    await userEvent.type(description, '新しい説明')
    await userEvent.click(canvas.getByRole('button', { name: '保存' }))
    await expect(await canvas.findByText('保存しました。')).toBeVisible()
    await expect(canvas.getByLabelText('説明')).toHaveValue('新しい説明')
  },
}

/** Choosing no leader and saving keeps the leader cleared after the reload. */
export const ClearedLeaderAfterReload: Story = {
  render: (args) => <SavingTeamProfilePanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByLabelText('リーダー'), '')
    await userEvent.click(canvas.getByRole('button', { name: '保存' }))
    await expect(await canvas.findByText('保存しました。')).toBeVisible()
    await expect(canvas.getByLabelText('リーダー')).toHaveValue('')
  },
}

/** Choosing another leader and saving shows that member as the leader after the reload. */
export const ChangedLeaderAfterReload: Story = {
  render: (args) => <SavingTeamProfilePanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(canvas.getByLabelText('リーダー'), 'suzuki@example.com')
    await userEvent.click(canvas.getByRole('button', { name: '保存' }))
    await expect(await canvas.findByText('保存しました。')).toBeVisible()
    await expect(canvas.getByLabelText('リーダー')).toHaveValue('suzuki@example.com')
  },
}

/**
 * Lets the story stand in for another administrator who saves the Team in the background.
 *
 * @param props - Story args of the panel.
 * @returns The panel with a control that reloads a newer Team.
 */
function ConcurrentlyUpdatedTeamProfilePanel(props: TeamProfilePanelProps) {
  const [current, setCurrent] = useState(team)
  const updateElsewhere = () => setCurrent((previous) => ({
    ...previous,
    description: '別の管理者の説明',
    profileRevision: (previous.profileRevision ?? 0) + 1,
  }))
  return (
    <>
      <button onClick={updateElsewhere} type="button">別の管理者が更新</button>
      <TeamProfilePanel {...props} team={current} teams={[current, designTeam]} />
    </>
  )
}

/** A background reload keeps unsaved edits and offers to discard them for the newer values. */
export const UpdatedWhileEditing: Story = {
  render: (args) => <ConcurrentlyUpdatedTeamProfilePanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const description = canvas.getByLabelText('説明')
    await userEvent.clear(description)
    await userEvent.type(description, '編集中の説明')
    await userEvent.click(canvas.getByRole('button', { name: '別の管理者が更新' }))
    await expect(canvas.getByLabelText('説明')).toHaveValue('編集中の説明')
    await expect(canvas.getByTestId('team-profile-changed-elsewhere')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: '編集を破棄して最新の内容を表示' }))
    await expect(canvas.getByLabelText('説明')).toHaveValue('別の管理者の説明')
    await expect(canvas.queryByTestId('team-profile-changed-elsewhere')).toBeNull()
  },
}

/** A background reload without unsaved edits shows the newer values right away. */
export const UpdatedWithoutEdits: Story = {
  render: (args) => <ConcurrentlyUpdatedTeamProfilePanel {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '別の管理者が更新' }))
    await expect(canvas.getByLabelText('説明')).toHaveValue('別の管理者の説明')
    await expect(canvas.queryByTestId('team-profile-changed-elsewhere')).toBeNull()
  },
}
