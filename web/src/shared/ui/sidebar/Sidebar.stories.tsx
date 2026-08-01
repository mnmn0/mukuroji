import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { createSidebarLabels } from '../../i18n/i18n'
import { Sidebar } from './Sidebar'
import type {
  SidebarQuickAccessProject,
  SidebarProjectTone,
  SidebarTeam,
} from './Sidebar'

const teams: SidebarTeam[] = [
  {
    id: 'johns-first-team',
    name: "John's First Team",
    expanded: true,
    projects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'marketing', name: 'Marketing', tone: 'purple' },
      { id: 'customer-stories', name: 'Customer Stories', tone: 'green' },
      { id: 'product-roadmap', name: 'Product Roadmap', tone: 'yellow' },
    ],
  },
  {
    id: 'design-team',
    name: 'Design Team',
  },
  {
    id: 'sales-team',
    name: 'Sales Team',
  },
]

const quickAccessProjects: SidebarQuickAccessProject[] = [
  {
    name: 'Refero',
    projectId: 'refero',
    teamId: 'johns-first-team',
    teamName: "John's First Team",
    tone: 'blue',
  },
  {
    name: 'Customer Stories',
    projectId: 'customer-stories',
    teamId: 'johns-first-team',
    teamName: "John's First Team",
    tone: 'green',
  },
]

const projectTones: readonly SidebarProjectTone[] = [
  'blue',
  'purple',
  'green',
  'yellow',
]

const largeTeams: SidebarTeam[] = Array.from({ length: 20 }, (_, teamIndex) => ({
  id: `team-${teamIndex + 1}`,
  name: `Team ${String(teamIndex + 1).padStart(2, '0')}`,
  projects: Array.from({ length: 20 }, (_, projectIndex) => ({
    id: `team-${teamIndex + 1}-project-${projectIndex + 1}`,
    name: `Project ${String(projectIndex + 1).padStart(2, '0')}`,
    tone: projectTones[projectIndex % projectTones.length],
  })),
}))

const largeQuickAccessProjects: SidebarQuickAccessProject[] = largeTeams[0]?.projects
  ?.slice(0, 8)
  .map((project) => ({
    name: project.name,
    projectId: project.id,
    teamId: largeTeams[0]?.id ?? '',
    teamName: largeTeams[0]?.name ?? '',
    tone: project.tone,
  })) ?? []

const meta = {
  title: 'Application/Navigation/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    teams,
    quickAccessProjects,
    labels: createSidebarLabels('ja'),
    defaultActiveTeamId: 'johns-first-team',
    defaultActiveProjectId: 'refero',
    inboxCount: 3,
    onArchiveProject: async () => undefined,
    onArchiveTeam: async () => undefined,
    onCreateProject: async () => undefined,
    onCreateTeam: async () => undefined,
    onOpenSearch: () => undefined,
    onMoveQuickAccessProject: async () => undefined,
    onRemoveQuickAccessProject: async () => undefined,
    onShowAllQuickAccess: () => undefined,
    onShowAllProjects: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-slate-50">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>

/** Sidebar stories の metadata です。 */
export default meta

/** Storybook story type for Sidebar examples. */
type Story = StoryObj<typeof meta>

/** Default expanded sidebar state. */
export const Default: Story = {}

/** Collapsed sidebar expands before exposing the searchable Team switcher. */
export const Collapsed: Story = {
  args: {
    defaultCollapsed: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', {
      name: "チームを切り替える: John's First Team",
    }))
    await expect(canvas.getByRole('complementary')).toHaveAttribute(
      'data-collapsed',
      'false',
    )
    await expect(canvas.getByPlaceholderText('チームを検索')).toBeVisible()
  },
}

/** English sidebar labels. */
export const English: Story = {
  args: {
    labels: createSidebarLabels('en'),
  },
}

/** Sidebar with the create modal open. */
export const CreateModalOpen: Story = {
  args: {
    defaultCreatePanelOpen: true,
  },
}

/** Sidebar manager with explicit ordering and removal controls. */
export const QuickAccessManager: Story = {
  args: {
    defaultQuickAccessManagerOpen: true,
  },
}

/** Twenty Teams with twenty Projects each remain discoverable through the switcher. */
export const LargeDirectory20By20: Story = {
  args: {
    defaultActiveTeamId: 'team-1',
    defaultActiveProjectId: 'team-1-project-1',
    quickAccessProjects: largeQuickAccessProjects,
    teams: largeTeams,
  },
}

/** Searchable Team switcher narrows a large directory without expanding a tree. */
export const TeamSearch: Story = {
  args: {
    defaultActiveTeamId: 'team-1',
    quickAccessProjects: largeQuickAccessProjects,
    teams: largeTeams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Team 01' }))
    const input = canvas.getByPlaceholderText('チームを検索')
    await userEvent.type(input, 'Team 18')
    await expect(canvas.getByRole('button', { name: 'Team 18' })).toBeVisible()
    await expect(canvas.queryByRole('button', { name: 'Team 02' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect(canvas.getByRole('button', { name: 'Team 01' })).toHaveFocus()
    await expect(canvas.getByRole('button', { name: 'Team 01' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  },
}
