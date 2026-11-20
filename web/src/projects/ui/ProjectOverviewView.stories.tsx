import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { factoryBoardFixture } from '../../features/factory-board/fixtures'
import { planningSnapshotFixture } from '../../planning/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { projectDirectoryFixtures } from '../fixtures'
import {
  findProjectOverviewUpdateTarget,
  selectProjectOverviewSchedule,
  summarizeProjectOverviewAgentRuns,
  summarizeProjectOverviewMembers,
  summarizeProjectOverviewWorkItems,
} from '../model/projectOverview'
import { ProjectOverviewView } from './ProjectOverviewView'

const coreTeam = projectDirectoryFixtures[0]

const meta = {
  title: 'Application/Projects/Project Overview',
  component: ProjectOverviewView,
  args: {
    agentRuns: summarizeProjectOverviewAgentRuns(factoryBoardFixture, 'refero'),
    isMembersLoading: false,
    isPlanningError: false,
    isPlanningLoading: false,
    isWorkItemsLoading: false,
    locale: 'ja',
    members: summarizeProjectOverviewMembers([
      { id: 'lead', email: 'lead@example.com', name: '佐藤 リード', role: 'manager', updatedAt: '2026-06-01T00:00:00.000Z', workspaceStatus: 'active' },
      { id: 'dev', email: 'dev@example.com', name: '鈴木 開発', role: 'member', updatedAt: '2026-06-01T00:00:00.000Z', workspaceStatus: 'active' },
      { id: 'guest', email: 'guest@example.com', role: 'viewer', updatedAt: '2026-06-01T00:00:00.000Z', workspaceStatus: 'active' },
    ]),
    project: {
      ...coreTeam.projects[0],
      lifecycleState: 'active',
      charter: {
        code: 'REF',
        owner: { userId: 'lead', displayName: '佐藤 リード' },
        plannedStartDate: '2026-06-01',
        plannedEndDate: '2026-09-30',
      },
    },
    schedule: selectProjectOverviewSchedule(planningSnapshotFixture.entities, 'core-team', 'refero'),
    t: createTranslator('ja'),
    team: coreTeam,
    updateTarget: findProjectOverviewUpdateTarget(planningSnapshotFixture.updateTargets, 'core-team', 'refero'),
    workItemSummary: summarizeProjectOverviewWorkItems(referoTaskFixtures, 'core-team', new Date('2026-06-10T00:00:00.000Z')),
  },
  decorators: [(Story) => (
    <MemoryRouter>
      <div className="bg-[var(--workbench-canvas)] p-4">
        <Story />
      </div>
    </MemoryRouter>
  )],
} satisfies Meta<typeof ProjectOverviewView>

/** Project overview with health, schedule, progress, members, and related views. */
export default meta

/** Story variants of the Project overview. */
type Story = StoryObj<typeof meta>

/** Every widget loaded on a desktop width. */
export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('link', { name: 'Work Item 一覧を開く' }))
      .toHaveAttribute('href', '/projects/refero/issues?teamId=core-team')
    await expect(canvas.getByRole('link', { name: '進捗報告を開く' }))
      .toHaveAttribute('href', '/planning/portfolio?targetType=project&teamId=core-team&projectId=refero')
    await expect(canvas.getByRole('link', { name: 'Factory board を開く' }))
      .toHaveAttribute('href', '/teams/core-team/factory')
  },
}

/** Every widget loaded on a 390px phone width. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** Each failed read is shown in its own widget. */
export const PartialFailure: Story = {
  args: {
    agentRuns: undefined,
    agentRunsError: 'load',
    membersError: 'load',
    isPlanningError: true,
    members: undefined,
    schedule: undefined,
    workItemSummary: undefined,
    workItemsError: 'limit',
  },
}
