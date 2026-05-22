import type { Meta, StoryObj } from '@storybook/react-vite'
import { Sidebar } from './Sidebar'
import type { SidebarTeam } from './Sidebar'

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

const meta = {
  title: 'Application/Navigation/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    teams,
    defaultActiveTeamId: 'johns-first-team',
    defaultActiveProjectId: 'refero',
    inboxCount: 3,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-slate-50">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Collapsed: Story = {
  args: {
    defaultCollapsed: true,
  },
}

export const ProjectListScrolled: Story = {
  args: {
    defaultActiveTeamId: 'johns-first-team',
    defaultActiveProjectId: 'refero',
    teams: [
      {
        id: 'johns-first-team',
        name: "John's First Team",
        expanded: true,
        projects: [
          { id: 'refero', name: 'Refero', tone: 'blue' },
          { id: 'marketing', name: 'Marketing', tone: 'purple' },
          { id: 'customer-stories', name: 'Customer Stories', tone: 'green' },
          { id: 'product-roadmap', name: 'Product Roadmap', tone: 'yellow' },
          { id: 'launch-plan', name: 'Launch Plan', tone: 'blue' },
          { id: 'brand-refresh', name: 'Brand Refresh', tone: 'purple' },
          { id: 'analytics', name: 'Analytics', tone: 'green' },
        ],
      },
      ...teams.slice(1),
    ],
  },
}
