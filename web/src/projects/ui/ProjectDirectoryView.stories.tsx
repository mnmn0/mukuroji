import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type {
  PlanningUpdateTargetSummary,
  ProjectQuickAccessItem,
} from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import type { ProjectDirectoryTeam } from '../api/directory'
import { projectDirectoryFixtures } from '../fixtures'
import {
  createProjectDirectoryAssigneeOptions,
  createProjectDirectoryRows,
  filterProjectDirectoryRows,
  paginateProjectDirectoryRows,
  type ProjectDirectoryFilters,
} from '../model/projectDirectoryView'
import {
  isProjectInQuickAccess,
  toggleProjectQuickAccess,
} from '../model/projectQuickAccess'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { createWorkItemSummaryFromWorkItems } from '../../work-items/model/workItemSummary'
import { ProjectDirectoryView } from './ProjectDirectoryView'

const defaultRows = createProjectDirectoryRows(
  projectDirectoryFixtures,
  createWorkItemSummaryFromWorkItems(referoTaskFixtures, new Date('2026-06-10T00:00:00.000Z')),
  (item) => item.projectId === 'refero' || item.projectId === 'brand-refresh',
)
const defaultAssigneeOptions = createProjectDirectoryAssigneeOptions(defaultRows)
const defaultPlanningUpdateTargets: readonly PlanningUpdateTargetSummary[] = [{
  target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
  cadence: {
    updateOwnerMemberKey: 'demo@example.com',
    cadence: { unit: 'week', count: 1 },
    timeZone: 'Asia/Tokyo',
    nextDueAt: '2026-08-14T08:00:00.000Z',
    reminderHoursBefore: 24,
  },
  updateState: 'overdue',
  latestVersion: 3,
  latestUpdate: {
    id: 'project-directory-update-3',
    version: 3,
    health: 'on-track',
    risk: 'low',
    summary: 'Release scope is stable; final evidence review remains.',
    progressSnapshot: { percent: 78, linkedWorkItemCount: 6 },
    authorMemberKey: 'demo@example.com',
    coveredDueAt: '2026-08-07T08:00:00.000Z',
    createdAt: '2026-08-07T07:30:00.000Z',
  },
  updatedAt: '2026-08-07T07:30:00.000Z',
}]

const meta = {
  title: 'Projects/ProjectDirectoryView',
  component: ProjectDirectoryView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    assignees: defaultAssigneeOptions.assignees,
    filteredCount: defaultRows.length,
    filters: {
      query: '',
      quickAccessOnly: false,
      status: 'all',
    },
    hasUnassignedProjects: defaultAssigneeOptions.hasUnassignedProjects,
    page: 1,
    pageCount: 1,
    planningUpdateTargets: defaultPlanningUpdateTargets,
    rows: defaultRows,
    t: createTranslator('ja'),
    teams: projectDirectoryFixtures,
    totalCount: defaultRows.length,
    onAssigneeChange: () => undefined,
    onClearFilters: () => undefined,
    onLifecycleChange: () => undefined,
    onOpenProject: () => undefined,
    onOpenPlanningUpdate: () => undefined,
    onPageChange: () => undefined,
    onQuickAccessOnlyChange: () => undefined,
    onSearchChange: () => undefined,
    onStatusChange: () => undefined,
    onTeamChange: () => undefined,
    onToggleQuickAccess: () => undefined,
  },
} satisfies Meta<typeof ProjectDirectoryView>

/** Project directory Storybook metadata. */
export default meta

/** Story type for Project directory examples. */
type Story = StoryObj<typeof meta>

/** Searchable Project directory with representative Workspace data. */
export const Default: Story = {}

/** Phone users can reach every directory filter without pushing results offscreen. */
export const MobileFilters: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    if (!window.matchMedia('(max-width: 760px)').matches) return
    const canvas = within(canvasElement)
    const disclosure = canvas.getByRole('button', { name: /絞り込み・並べ替え/ })
    await expect(canvas.queryByRole('combobox')).not.toBeInTheDocument()
    await userEvent.click(disclosure)
    await expect(canvas.getAllByRole('combobox')).toHaveLength(4)
    await userEvent.click(disclosure)
    await expect(disclosure).toHaveFocus()
  },
}

/** Charter summaries show the lifecycle badge, code, owner, and planned period per Project. */
export const WithCharters: Story = {
  args: {
    rows: defaultRows.map((row, index) => index === 0
      ? {
          ...row,
          lifecycleState: 'active' as const,
          code: 'OPS-1',
          owner: { userId: 'demo@example.com', displayName: 'Demo User' },
          plannedStartDate: '2026-04-01',
          plannedEndDate: '2027-03-31',
        }
      : index === 1
        ? { ...row, lifecycleState: 'on-hold' as const, code: 'MKT-7' }
        : row),
  },
}

/** Customers linked to a Project by Customer Requests are listed in its row. */
export const WithLinkedCustomers: Story = {
  args: {
    projectCustomerLinks: [{
      projectId: defaultRows[0]?.projectId ?? 'refero',
      customers: [
        { customerId: 'acme', name: 'Acme Corporation', requestCount: 2 },
        { customerId: 'globex', name: 'Globex', requestCount: 1 },
        { customerId: 'initech', name: 'Initech', requestCount: 1 },
      ],
    }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = defaultRows[0]
    if (!row) throw new Error('The story needs a Project row.')
    await expect(canvas.getByTestId(`project-customers-${row.teamId}-${row.projectId}`))
      .toHaveTextContent('顧客: Acme Corporation, Globex ほか1社')
  },
}

/** English Project directory with the attention facet selected. */
export const EnglishAttention: Story = {
  args: {
    filters: {
      query: '',
      quickAccessOnly: false,
      status: 'attention',
    },
    t: createTranslator('en'),
  },
}

/** Empty result state after applying a search query. */
export const NoFilterMatches: Story = {
  args: {
    filteredCount: 0,
    filters: {
      query: 'no matching project',
      quickAccessOnly: false,
      status: 'all',
    },
    rows: [],
  },
}

/** Project discovery remains readable when Quick Access could not be loaded. */
export const QuickAccessUnavailable: Story = {
  args: {
    isQuickAccessUnavailable: true,
  },
}

/** Twenty-Team by twenty-Project acceptance fixture with live filtering and pagination. */
export const LargeWorkspace20By20: Story = {
  render: () => <LargeProjectDirectoryStory />,
}

/**
 * Renders the interactive 400-Project acceptance fixture used for visual QA.
 *
 * @returns A stateful Project directory story with bounded result pages.
 */
function LargeProjectDirectoryStory() {
  const teams = useMemo(() => createLargeProjectDirectory(), [])
  const [quickAccessItems, setQuickAccessItems] = useState<ProjectQuickAccessItem[]>([
    { projectId: 'project-1-1', teamId: 'team-1' },
    { projectId: 'project-2-3', teamId: 'team-2' },
    { projectId: 'project-10-10', teamId: 'team-10' },
  ])
  const [filters, setFilters] = useState<ProjectDirectoryFilters>({
    query: '',
    quickAccessOnly: false,
    status: 'all',
  })
  const [page, setPage] = useState(1)
  const rows = useMemo(
    () => createProjectDirectoryRows(
      teams,
      createWorkItemSummaryFromWorkItems([], new Date('2026-06-10T00:00:00.000Z')),
      (item) => isProjectInQuickAccess(quickAccessItems, item),
    ),
    [quickAccessItems, teams],
  )
  const filteredRows = filterProjectDirectoryRows(rows, filters)
  const currentPage = paginateProjectDirectoryRows(filteredRows, page)
  const assigneeOptions = createProjectDirectoryAssigneeOptions(rows)

  /** Applies a partial filter update and resets visual pagination. */
  const updateFilters = (next: Partial<ProjectDirectoryFilters>) => {
    setFilters((current) => ({ ...current, ...next }))
    setPage(1)
  }

  return (
    <ProjectDirectoryView
      assignees={assigneeOptions.assignees}
      filteredCount={filteredRows.length}
      filters={filters}
      hasUnassignedProjects={assigneeOptions.hasUnassignedProjects}
      page={currentPage.page}
      pageCount={currentPage.pageCount}
      rows={currentPage.rows}
      t={createTranslator('ja')}
      teams={teams}
      totalCount={rows.length}
      onAssigneeChange={(assigneeId) => updateFilters({ assigneeId })}
      onClearFilters={() => updateFilters({
        assigneeId: undefined,
        query: '',
        quickAccessOnly: false,
        status: 'all',
        teamId: undefined,
      })}
      onOpenProject={() => undefined}
      onPageChange={setPage}
      onQuickAccessOnlyChange={(quickAccessOnly) => updateFilters({ quickAccessOnly })}
      onSearchChange={(query) => updateFilters({ query })}
      onStatusChange={(status) => updateFilters({ status })}
      onTeamChange={(teamId) => updateFilters({ teamId })}
      onToggleQuickAccess={(project) => {
        setQuickAccessItems((current) => toggleProjectQuickAccess(current, {
          projectId: project.projectId,
          teamId: project.teamId,
        }).items)
      }}
    />
  )
}

/**
 * Creates the maximum Team and Project fixture described by Issue #176.
 *
 * @returns Twenty Teams containing twenty Projects each.
 */
function createLargeProjectDirectory(): ProjectDirectoryTeam[] {
  const tones: readonly NonNullable<
    ProjectDirectoryTeam['projects'][number]['tone']
  >[] = ['blue', 'purple', 'green', 'yellow']
  return Array.from({ length: 20 }, (_, teamIndex): ProjectDirectoryTeam => ({
    id: `team-${teamIndex + 1}`,
    name: `チーム ${String(teamIndex + 1).padStart(2, '0')}`,
    projects: Array.from({ length: 20 }, (_, projectIndex) => ({
      id: `project-${teamIndex + 1}-${projectIndex + 1}`,
      name: `プロジェクト ${String(teamIndex + 1).padStart(2, '0')}-${String(projectIndex + 1).padStart(2, '0')}`,
      tone: tones[projectIndex % tones.length] ?? 'blue',
    })),
  }))
}
