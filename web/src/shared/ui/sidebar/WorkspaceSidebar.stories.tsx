import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { createSidebarLabels } from '../../i18n/i18n'
import type { SidebarTeam } from './Sidebar'
import { WorkspaceSidebar, type WorkspaceSidebarProps } from './WorkspaceSidebar'

const teams: SidebarTeam[] = [
  {
    id: 'johns-first-team',
    name: "John's First Team",
    expanded: true,
    projects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'marketing', name: 'Marketing', tone: 'purple' },
      { id: 'customer-stories', name: 'Customer Stories', tone: 'green' },
    ],
  },
  {
    id: 'design-team',
    name: 'Design Team',
  },
]

const meta = {
  title: 'Application/Navigation/WorkspaceSidebar',
  component: WorkspaceSidebar,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    teams,
    labels: createSidebarLabels('ja'),
    defaultActiveTeamId: 'johns-first-team',
    defaultActiveProjectId: 'refero',
    inboxCount: 3,
    isMobileOpen: false,
    mobileCloseLabel: 'サイドバーを閉じる',
    mobileDialogLabel: 'モバイルサイドバー',
    onMobileClose: () => undefined,
    onOpenSearch: () => undefined,
    onSelectNav: () => undefined,
    onSelectProject: () => undefined,
    onSelectTeamView: () => undefined,
  },
  render: (args) => <WorkspaceSidebarStory {...args} />,
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-slate-50">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceSidebar>

/** WorkspaceSidebar stories の metadata です。 */
export default meta

/** Storybook story type for WorkspaceSidebar examples. */
type Story = StoryObj<typeof meta>

/** Desktop sidebar with its mobile drawer closed. */
export const Desktop: Story = {}

/** Mobile drawer open state with an interactive close and reopen flow. */
export const MobileOpen: Story = {
  args: {
    isMobileOpen: true,
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const dialog = canvas.getByRole('dialog', { name: 'モバイルサイドバー' })
    const dialogCanvas = within(dialog)
    const teamButton = dialogCanvas.getByRole('button', { name: "John's First Team" })

    await expect(teamButton).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(teamButton)
    await expect(teamButton).toHaveAttribute('aria-expanded', 'false')
    await expect(canvas.getByRole('dialog', { name: 'モバイルサイドバー' })).toBeInTheDocument()

    await userEvent.click(dialogCanvas.getByRole('button', { name: 'サイドバーを閉じる' }))
    await expect(canvas.queryByRole('dialog', { name: 'モバイルサイドバー' })).not.toBeInTheDocument()

    await userEvent.click(canvas.getByRole('button', { name: 'モバイルサイドバーを開く' }))
    await expect(canvas.getByRole('dialog', { name: 'モバイルサイドバー' })).toBeInTheDocument()
  },
}

function WorkspaceSidebarStory(args: WorkspaceSidebarProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(args.isMobileOpen)

  return (
    <>
      <WorkspaceSidebar
        {...args}
        isMobileOpen={isMobileOpen}
        onMobileClose={() => {
          setIsMobileOpen(false)
          args.onMobileClose()
        }}
      />
      <button
        className="m-4 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm"
        type="button"
        onClick={() => setIsMobileOpen(true)}
      >
        モバイルサイドバーを開く
      </button>
    </>
  )
}
