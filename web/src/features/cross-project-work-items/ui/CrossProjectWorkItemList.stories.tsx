import type { CanonicalWorkItem } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { projectDirectoryFixtures } from '../../../projects/fixtures'
import { createTranslator } from '../../../shared/i18n/i18n'
import { taskViewStorySelectedTask } from '../../../tasks/ui/TaskView.stories.fixtures'
import { teamWorkItemConfigurationFixture } from '../../../work-items/fixtures'
import {
  createCrossProjectWorkItemProjectOptions,
  defaultCrossProjectWorkItemListState,
  groupCrossProjectWorkItems,
} from '../model/crossProjectWorkItems'
import { CrossProjectWorkItemList } from './CrossProjectWorkItemList'

/** Readable Work Items spread over two Teams and three Projects. */
const storyWorkItems: CanonicalWorkItem[] = [
  { ...taskViewStorySelectedTask, id: 'refero-1', key: 'CORE-1', teamId: 'core-team', assignedProjectId: 'refero', title: 'Review the wireframe', assigneeName: 'Sato' },
  {
    ...taskViewStorySelectedTask,
    id: 'roadmap-1',
    key: 'CORE-2',
    teamId: 'core-team',
    assignedProjectId: 'product-roadmap',
    title: 'Draft the Q1 roadmap',
    assigneeName: 'Suzuki',
    contributorAssignments: [
      { assignmentId: 'c-1', memberUserId: 'demo@example.com', jobRoleId: 'designer', status: 'planned' },
    ],
  },
  { ...taskViewStorySelectedTask, id: 'brand-1', key: 'DES-1', teamId: 'design-team', assignedProjectId: 'brand-refresh', title: 'Refresh the logo', assigneeName: 'Tanaka' },
]

const changeState = fn()

/** Storybook metadata for the Workspace-wide Work Item list. */
const meta = {
  args: {
    configurationsByTeam: {
      'core-team': { configuration: { ...teamWorkItemConfigurationFixture, scopeId: 'core-team' } },
      'design-team': { configuration: { ...teamWorkItemConfigurationFixture, scopeId: 'design-team' } },
    },
    groups: groupCrossProjectWorkItems(storyWorkItems, 'project', projectDirectoryFixtures),
    isLoading: false,
    jobRoleOptions: [
      { key: 'core-team:designer', teamId: 'core-team', jobRoleId: 'designer', name: 'Designer', teamName: 'コアチーム' },
    ],
    loadFailed: false,
    memberLabels: new Map([['demo@example.com', 'Demo User']]),
    memberOptions: [{ id: 'demo@example.com', label: 'Demo User' }],
    onChangeState: changeState,
    onCopyLink: async () => true,
    onOpenWorkItem: fn(),
    onRetry: fn(),
    projectOptions: createCrossProjectWorkItemProjectOptions(projectDirectoryFixtures),
    state: defaultCrossProjectWorkItemListState,
    t: createTranslator('en'),
    teams: projectDirectoryFixtures,
    totalCount: storyWorkItems.length,
  },
  component: CrossProjectWorkItemList,
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-6xl"><Story /></div>
      </main>
    ),
  ],
  parameters: { layout: 'fullscreen' },
  title: 'Application/Work Items/Cross-Project List',
} satisfies Meta<typeof CrossProjectWorkItemList>

export default meta

/** Story type derived from the cross-Project Work Item list metadata. */
type Story = StoryObj<typeof meta>

/** Open Work Items of every readable Project, grouped by Project. */
export const GroupedByProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByTestId('cross-project-work-item-group')).toHaveLength(3)
    await expect(canvas.getByText('Demo User (Designer)')).toBeVisible()
    await userEvent.click(canvas.getByLabelText('I own or contribute'))
    await expect(changeState).toHaveBeenCalledWith(expect.objectContaining({ mine: true }))
  },
}

/** The same Work Items grouped by accountable owner. */
export const GroupedByOwner: Story = {
  args: {
    groups: groupCrossProjectWorkItems(storyWorkItems, 'assignee', projectDirectoryFixtures),
    state: { ...defaultCrossProjectWorkItemListState, grouping: 'assignee' },
  },
}

/** The same Work Items as a read-only board, one swimlane per Project. */
export const Board: Story = {
  args: { state: { ...defaultCrossProjectWorkItemListState, layout: 'board' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByTestId('cross-project-work-item-lane')).toHaveLength(3)
    await expect(canvas.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.queryByRole('combobox', { name: /Review the wireframe/ })).toBeNull()
  },
}

/** The same Work Items on a read-only Gantt chart, with a heading row per Project. */
export const Gantt: Story = {
  args: { state: { ...defaultCrossProjectWorkItemListState, layout: 'gantt' } },
}

/** Work Items are still loading. */
export const Loading: Story = {
  args: { groups: [], isLoading: true, totalCount: 0 },
}

/** No Work Item matches the filters. */
export const Empty: Story = {
  args: {
    groups: [],
    state: { ...defaultCrossProjectWorkItemListState, mine: true },
    totalCount: 0,
  },
}

/** The read failed; the page shows its load notice, so the list hides the count and empty text. */
export const LoadFailed: Story = {
  args: { groups: [], loadFailed: true, totalCount: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByTestId('cross-project-work-items-count')).toBeNull()
    await expect(canvas.getByRole('button', { name: 'Reload Work Items' })).toBeVisible()
  },
}
