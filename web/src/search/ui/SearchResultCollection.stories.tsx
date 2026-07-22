import type { SearchViewLayout, WorkspaceSearchResult } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SearchResultCollection } from './SearchResultCollection'

const storyResults = [
  {
    id: 'launch-review',
    entityType: 'work-item',
    title: 'ローンチ前の承認条件を確認',
    subtitle: '共通ローンチ · Demo User',
    url: '/projects/shared-launch/issues?teamId=core-team&issueId=launch-review',
    teamId: 'core-team',
    projectId: 'shared-launch',
    status: 'review',
    assigneeUserId: 'demo@example.com',
    creatorUserId: 'owner@example.com',
    dueDate: '2026-07-14',
    updatedAt: '2026-07-12T08:00:00.000Z',
    highlights: [
      {
        field: 'title',
        fragments: [
          { text: 'ローンチ前の', matched: false },
          { text: '承認', matched: true },
          { text: '条件を確認', matched: false },
        ],
      },
    ],
  },
  {
    id: 'roadmap',
    entityType: 'project',
    title: 'プロダクトロードマップ',
    subtitle: 'コアチーム',
    url: '/projects/product-roadmap/issues?teamId=core-team',
    teamId: 'core-team',
    projectId: 'product-roadmap',
    updatedAt: '2026-07-11T07:30:00.000Z',
    highlights: [],
  },
  {
    id: 'comment-approval',
    entityType: 'comment',
    title: '承認者の確認コメント',
    subtitle: 'ローンチ前の承認条件を確認',
    body: '必要な承認者が揃ったらレビューへ移動します。',
    url: '/projects/shared-launch/issues?teamId=core-team&issueId=launch-review#comment-comment-approval',
    teamId: 'core-team',
    projectId: 'shared-launch',
    parentId: 'launch-review',
    creatorUserId: 'sato@example.com',
    createdAt: '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-10T09:00:00.000Z',
    highlights: [
      {
        field: 'body',
        fragments: [
          { text: '必要な', matched: false },
          { text: '承認者', matched: true },
          { text: 'が揃ったらレビューへ移動します。', matched: false },
        ],
      },
    ],
  },
  {
    id: 'design-team',
    entityType: 'team',
    title: 'デザインチーム',
    subtitle: '2 projects',
    url: '/teams/design-team/overview',
    teamId: 'design-team',
    updatedAt: '2026-07-09T09:00:00.000Z',
    highlights: [],
  },
] satisfies WorkspaceSearchResult[]

const tableLayout = {
  columns: ['title', 'type', 'status', 'assignee', 'project', 'updatedAt'],
  mode: 'table',
  sort: [{ field: 'relevance', direction: 'desc' }],
} satisfies SearchViewLayout

/**
 * SearchResultCollectionのStorybook metaです。
 */
const meta = {
  title: 'Application/Search/Results',
  component: SearchResultCollection,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    layout: tableLayout,
    locale: 'ja',
    onNavigate: () => undefined,
    results: storyResults,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--workbench-canvas)] p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchResultCollection>

export default meta

/**
 * Search result storiesの型です。
 */
type Story = StoryObj<typeof meta>

/**
 * 複数entityとhighlightを含むtable表示です。
 */
export const Table: Story = {}

/**
 * Statusでgroup化したboard表示です。
 */
export const Board: Story = {
  args: {
    layout: {
      ...tableLayout,
      groupBy: 'status',
      mode: 'board',
    },
  },
}

/**
 * Due date単位のcalendar表示です。
 */
export const Calendar: Story = {
  args: {
    layout: {
      ...tableLayout,
      mode: 'calendar',
    },
  },
}

/**
 * Due dateまたは更新日時で並べるtimeline表示です。
 */
export const Timeline: Story = {
  args: {
    layout: {
      ...tableLayout,
      mode: 'timeline',
    },
  },
}

/**
 * 英語localeでの高密度table表示です。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}
