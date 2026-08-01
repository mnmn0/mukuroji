import type { Meta, StoryObj } from '@storybook/react-vite'
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
import { referoTaskFixtures } from '../../tasks/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { ProjectDirectoryView } from './ProjectDirectoryView'

const defaultRows = createProjectDirectoryRows(
  projectDirectoryFixtures,
  referoTaskFixtures,
  (projectId) => projectId === 'refero' || projectId === 'brand-refresh',
)
const defaultAssigneeOptions = createProjectDirectoryAssigneeOptions(defaultRows)

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
    rows: defaultRows,
    t: createTranslator('ja'),
    teams: projectDirectoryFixtures,
    totalCount: defaultRows.length,
    onAssigneeChange: () => undefined,
    onClearFilters: () => undefined,
    onOpenProject: () => undefined,
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
  const [quickAccessIds, setQuickAccessIds] = useState([
    'project-1-1',
    'project-2-3',
    'project-10-10',
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
      [],
      (projectId) => quickAccessIds.includes(projectId),
    ),
    [quickAccessIds, teams],
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
        setQuickAccessIds((current) => current.includes(project.projectId)
          ? current.filter((projectId) => projectId !== project.projectId)
          : [...current, project.projectId])
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
