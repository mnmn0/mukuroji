import type { Meta, StoryObj } from '@storybook/react-vite'
import { SEARCH_SCHEMA_VERSION, type WorkspaceSearchResult } from '@mukuroji/contracts'
import { expect, userEvent, within } from 'storybook/test'
import { WorkspaceCommandMenu } from './WorkspaceCommandMenu'

/** Search API behavior a command menu story reproduces. */
type CommandMenuSearchScenario = 'crowded' | 'project-search-failed'

/** Work Item title matches that fill every Workspace-wide result slot. */
const crowdedWorkItemResults: WorkspaceSearchResult[] = Array.from({ length: 12 }, (_, index) => ({
  entityType: 'work-item',
  highlights: [],
  id: `login-task-${index + 1}`,
  projectId: 'refero',
  subtitle: 'Refero',
  teamId: 'core-team',
  title: `ログイン画面の改善 ${index + 1}`,
  url: `/teams/core-team/issues/login-task-${index + 1}`,
}))

/** Project matches only the Project-only search reaches. */
const loginProjectResults: WorkspaceSearchResult[] = [{
  entityType: 'project',
  highlights: [],
  id: 'login-platform',
  teamId: 'core-team',
  title: 'ログイン基盤',
  url: '/projects/login-platform?teamId=core-team',
}]

/**
 * Replaces fetch with a search API fixture for one story and returns the cleanup.
 *
 * @param scenario - Search API behavior to reproduce.
 * @returns A function that restores the original fetch.
 */
function installCommandMenuSearchFetch(scenario: CommandMenuSearchScenario) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location.origin)
    if (!url.pathname.endsWith('/search')) {
      return Response.json({ message: `Unexpected Storybook request: ${url.pathname}` }, { status: 404 })
    }
    const projectOnly = (url.searchParams.get('filters') ?? '').includes('entityTypes')
    if (projectOnly && scenario === 'project-search-failed') {
      return Response.json({ message: '一時的に利用できません。' }, { status: 503 })
    }
    return Response.json({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      results: projectOnly ? loginProjectResults : crowdedWorkItemResults,
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

/**
 * WorkspaceCommandMenuのStorybook metaです。
 */
const meta = {
  title: 'Application/Search/Command Menu',
  component: WorkspaceCommandMenu,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    currentLocation: '/projects/refero/issues?teamId=core-team',
    isOpen: true,
    locale: 'ja',
    onClose: () => undefined,
    onNavigate: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--workbench-canvas)] p-8">
        <div className="workbench-panel mx-auto max-w-4xl p-8">
          <p className="workbench-eyebrow">Workspace</p>
          <h1 className="workbench-title mt-3 text-page-title">Command menu preview</h1>
        </div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceCommandMenu>

export default meta

/**
 * WorkspaceCommandMenu storiesの型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Project画面でquick createを利用できるcommand menuです。
 */
export const ProjectContext: Story = {}

/**
 * 英語localeのcommand menuです。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}

/**
 * Mobile viewportで全幅に近いcommand menuを確認する状態です。
 */
export const Mobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
}

/**
 * Work Item のタイトル一致で埋まっても、Project 専用検索の一致が末尾に残る状態です。
 */
export const CrowdedWorkItemsWithProject: Story = {
  args: { accessToken: 'storybook-command-menu-token' },
  beforeEach: () => installCommandMenuSearchFetch('crowded'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.type(canvas.getByLabelText('検索と command を開く'), 'ログイン')
    await expect(await canvas.findByText('ログイン基盤')).toBeInTheDocument()
  },
}

/**
 * Project 専用検索だけが失敗し、Workspace 全体の結果と再試行を出す状態です。
 */
export const ProjectSearchFailed: Story = {
  args: { accessToken: 'storybook-command-menu-token' },
  beforeEach: () => installCommandMenuSearchFetch('project-search-failed'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.type(canvas.getByLabelText('検索と command を開く'), 'ログイン')
    await expect(await canvas.findByText(/Project の候補を読み込めませんでした/u)).toBeInTheDocument()
    await expect(canvas.getByRole('button', { name: '再試行' })).toBeInTheDocument()
  },
}
