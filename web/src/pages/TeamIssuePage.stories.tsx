import type { Meta, StoryObj } from '@storybook/react-vite'
import { TeamIssueScreen } from './TeamIssuePage'
import {
  teamIssueActivityFixtures,
  teamIssueCommentFixtures,
  teamIssueFixtures,
} from '../issues/fixtures'
import type { ProjectMember } from '../projects/api'
import { projectDirectoryFixtures } from '../projects/fixtures'

const assigneeOptions: ProjectMember[] = [
  {
    id: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
  {
    id: 'suzuki@example.com',
    email: 'suzuki@example.com',
    name: '鈴木 大輔',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
]

const meta = {
  title: 'Application/Teams/Issue Page',
  component: TeamIssueScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    locale: 'ja',
    activity: teamIssueActivityFixtures,
    assigneeOptions,
    comments: teamIssueCommentFixtures,
    issues: teamIssueFixtures,
    selectedIssueId: 'onboarding-friction',
    teamId: 'core-team',
    teamName: 'コアチーム',
    teams: projectDirectoryFixtures,
    userInitial: 'J',
  },
} satisfies Meta<typeof TeamIssueScreen>

/**
 * TeamIssueScreen を fullscreen layout で確認する Storybook metadata です。
 */
export default meta

/**
 * チーム Issue 画面 Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * チーム所有 Issue を一覧と詳細ペインで表示する標準状態です。
 */
export const Default: Story = {}

/**
 * Issue が未登録の空状態です。
 */
export const Empty: Story = {
  args: {
    activity: [],
    comments: [],
    issues: [],
    selectedIssueId: undefined,
  },
}

/**
 * Issue 一覧取得失敗時の表示です。
 */
export const LoadingError: Story = {
  args: {
    issueErrorMessage: 'Issue 一覧を取得できませんでした',
    issues: [],
    selectedIssueId: undefined,
  },
}
