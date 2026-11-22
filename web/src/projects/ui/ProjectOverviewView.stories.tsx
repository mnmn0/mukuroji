import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { documentBacklinkFixtures, documentSummaryFixtures } from '../../documents/fixtures'
import { factoryBoardFixture } from '../../features/factory-board/fixtures'
import { planningSnapshotFixture } from '../../planning/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { projectDirectoryFixtures, projectRaidLogFixtures } from '../fixtures'
import {
  findProjectOverviewUpdateTarget,
  selectProjectOverviewDocuments,
  selectProjectOverviewSchedule,
  summarizeProjectOverviewActionItems,
  summarizeProjectOverviewAgentRuns,
  summarizeProjectOverviewMembers,
  summarizeProjectOverviewRaid,
  summarizeProjectOverviewWorkItems,
} from '../model/projectOverview'
import { ProjectOverviewView } from './ProjectOverviewView'

const coreTeam = projectDirectoryFixtures[0]

const meta = {
  title: 'Application/Projects/Project Overview',
  component: ProjectOverviewView,
  args: {
    actionItems: summarizeProjectOverviewActionItems(
      [
        {
          assigneeMemberKey: 'dev',
          blockId: 'actions',
          documentId: 'doc-roadmap',
          documentTitle: '定例 2026-06-05',
          dueDate: '2026-06-08',
          itemId: 'item-1',
          text: 'ベンダーに納期を再確認する',
        },
        {
          assigneeMemberKey: 'lead',
          blockId: 'actions',
          documentId: 'doc-roadmap',
          documentTitle: '定例 2026-06-05',
          dueDate: '2026-06-12',
          itemId: 'item-2',
          text: '次フェーズの見積もりを共有する',
          workItemId: 'team/core-team/issue/REF-12',
        },
        {
          blockId: 'actions',
          documentId: 'doc-design',
          documentTitle: '設計レビュー',
          itemId: 'item-3',
          text: 'API の命名を決める',
        },
      ],
      1,
      [
        { id: 'lead', email: 'lead@example.com', name: '佐藤 リード', role: 'manager', updatedAt: '2026-06-01T00:00:00.000Z', workspaceStatus: 'active' },
        { id: 'dev', email: 'dev@example.com', name: '鈴木 開発', role: 'member', updatedAt: '2026-06-01T00:00:00.000Z', workspaceStatus: 'active' },
      ],
      '2026-06-10',
    ),
    agentRuns: summarizeProjectOverviewAgentRuns(factoryBoardFixture, 'refero'),
    documents: selectProjectOverviewDocuments('refero', documentBacklinkFixtures, documentSummaryFixtures, false),
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
    raid: summarizeProjectOverviewRaid(projectRaidLogFixtures, '2026-06-10'),
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
    await expect(canvas.getByRole('link', { name: 'ドキュメントを開く' }))
      .toHaveAttribute('href', '/documents?projectId=refero')
    await expect(canvas.getByText('主要部品のベンダー納期遅延')).toBeVisible()
    await expect(canvas.getByText('次フェーズで対応することで合意。')).toBeVisible()
    await expect(canvas.getByText('ベンダーに納期を再確認する')).toBeVisible()
    await expect(canvas.getByText('期限: 2026-06-08（期限切れ）')).toBeVisible()
  },
}

/** Every widget loaded on a desktop width, without interaction checks, for the visual regression suite. */
export const AllWidgets: Story = {}

/** Every widget loaded on a 390px phone width. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

/** Each failed read is shown in its own widget. */
export const PartialFailure: Story = {
  args: {
    actionItems: undefined,
    actionItemsError: 'load',
    agentRuns: undefined,
    agentRunsError: 'load',
    documentsError: 'load',
    membersError: 'load',
    raid: undefined,
    raidError: 'load',
    isPlanningError: true,
    members: undefined,
    schedule: undefined,
    workItemSummary: undefined,
    workItemsError: 'limit',
  },
}
