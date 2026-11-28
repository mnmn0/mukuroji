import type { Meta, StoryObj } from '@storybook/react-vite'
import type { TeamDecisionLogResponse, WorkspaceSearchResult } from '@mukuroji/contracts'
import { MemoryRouter } from 'react-router'
import { SWRConfig, unstable_serialize } from 'swr'
import { expect, within } from 'storybook/test'
import type { ProjectDirectoryTeam } from '../api'
import type { TeamDecisionNotes } from '../queries/useTeamDecisionNotes'
import { TeamDecisionLogView } from './TeamDecisionLogView'

/** Session token used only to key the fixtures. */
const storyToken = 'story-token'

/** Team whose Projects are listed. */
const team: ProjectDirectoryTeam = {
  id: 'core-team',
  name: 'Core',
  projects: [
    { id: 'atlas', name: 'Atlas' },
    { id: 'borealis', name: 'Borealis' },
  ],
}

/** Decisions and decided change requests across the Team. */
const log: TeamDecisionLogResponse = {
  teamId: team.id,
  truncated: false,
  items: [
    {
      kind: 'decision',
      projectId: 'atlas',
      decidedAt: '2026-11-20T05:00:00.000Z',
      entry: {
        id: 'decision-1',
        title: '認証基盤は Cognito を使う',
        content: '自前の認証は作らず、Cognito のユーザープールに寄せる。',
        rationale: '運用負荷と監査要件を考えると、マネージドサービスの方が安い。',
        decidedAt: '2026-11-20T05:00:00.000Z',
        deciderMemberIds: ['sato@example.com'],
        sources: [{ url: 'https://github.com/example/repo/blob/main/docs/adr/0003-auth.md', label: 'ADR 0003' }],
        status: 'active',
        origin: 'project',
        recordedByMemberId: 'sato@example.com',
        revision: 1,
        createdAt: '2026-11-20T05:10:00.000Z',
        updatedAt: '2026-11-20T05:10:00.000Z',
      },
    },
    {
      kind: 'change-request',
      projectId: 'borealis',
      decidedAt: '2026-11-18T03:00:00.000Z',
      entry: {
        id: 'cr-1',
        kind: 'change-request',
        title: '帳票出力を範囲に追加',
        impact: 5,
        response: '次フェーズで対応することで合意。',
        status: 'closed',
        decision: { outcome: 'approved', decidedAt: '2026-11-18T03:00:00.000Z', decidedByMemberId: 'tanaka@example.com' },
        revision: 3,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-11-18T03:00:00.000Z',
      },
    },
  ],
}

/** One decision note kept on a Work Item. */
const note: WorkspaceSearchResult = {
  id: 'context-item-1',
  entityType: 'context-item',
  title: 'API は v2 だけを公開する',
  subtitle: 'decision',
  body: '旧 API は 12 月末で止める。',
  url: '/workspace/core-team/issues/wi-1',
  projectId: 'atlas',
  updatedAt: '2026-11-19T02:00:00.000Z',
  highlights: [],
}

/** Notes found by Workspace search. */
const notes: TeamDecisionNotes = { notes: [note], truncated: false }

/**
 * Builds SWR fallback data for the view's three queries, so the stories never call the API.
 *
 * @param data - Log and notes to show.
 * @returns Fallback values by serialized SWR key.
 */
function fallbackFor(data: { log: TeamDecisionLogResponse; notes: TeamDecisionNotes }) {
  const scopeKey = team.projects.map((project) => `${team.id}\0${project.id}`).join('\n')
  return {
    [unstable_serialize(['team-decision-log', storyToken, team.id, '', ''])]: data.log,
    [unstable_serialize(['team-decision-notes', storyToken, team.id, '', ''])]: data.notes,
    [unstable_serialize(['active-directory-members', storyToken, scopeKey])]: {
      errors: [],
      members: [
        { id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子', workspaceStatus: 'active', role: 'member', updatedAt: '2026-11-20T00:00:00.000Z' },
        { id: 'tanaka@example.com', email: 'tanaka@example.com', name: '田中 太郎', workspaceStatus: 'active', role: 'manager', updatedAt: '2026-11-20T00:00:00.000Z' },
      ],
    },
  }
}

const meta = {
  title: 'Projects/TeamDecisionLogView',
  component: TeamDecisionLogView,
  parameters: { fallback: fallbackFor({ log, notes }) },
  decorators: [
    (Story, context) => (
      <MemoryRouter>
        <SWRConfig
          value={{ provider: () => new Map(), fallback: context.parameters.fallback, shouldRetryOnError: false, revalidateOnMount: false }}
        >
          <div className="max-w-4xl bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
            <Story />
          </div>
        </SWRConfig>
      </MemoryRouter>
    ),
  ],
  args: { accessToken: storyToken, locale: 'ja', team },
} satisfies Meta<typeof TeamDecisionLogView>

/** Team decision log Storybook metadata. */
export default meta

/** Story type for Team decision log examples. */
type Story = StoryObj<typeof meta>

/** Decisions, a decided change request, and a decision note across the Team. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('認証基盤は Cognito を使う')).toBeVisible()
    await expect(canvas.getByTestId('team-decision-change-request')).toHaveTextContent('帳票出力を範囲に追加')
    await expect(canvas.getByRole('link', { name: 'API は v2 だけを公開する' })).toBeVisible()
  },
}

/** More matches than the list shows. */
export const Truncated: Story = {
  parameters: { fallback: fallbackFor({ log: { ...log, truncated: true }, notes: { ...notes, truncated: true } }) },
}

/** Nothing recorded in the Team yet. */
export const Empty: Story = {
  parameters: { fallback: fallbackFor({ log: { ...log, items: [] }, notes: { notes: [], truncated: false } }) },
}

/** English labels. */
export const English: Story = {
  args: { locale: 'en' },
}
