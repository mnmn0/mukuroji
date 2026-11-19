import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import { SWRConfig } from 'swr'
import { expect, fn, userEvent, within } from 'storybook/test'
import { teamIssueFixtures } from '../../issues/fixtures'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  DocumentRelationTargetLabel,
  DocumentRelationTargetPicker,
  LinkableDocumentPicker,
} from './DocumentLinkPicker'

/** API state a link picker story reproduces. */
type LinkStoryScenario = 'results' | 'loading' | 'error'

const storyAccessToken = 'storybook-document-links-token'
const t = createTranslator('ja')

/** Search results the stories return for every query. */
const linkSearchResults: WorkspaceSearchResult[] = [
  {
    entityType: 'work-item',
    highlights: [],
    id: 'team/core-team/issue/onboarding-friction',
    status: 'started',
    subtitle: 'CORE-1',
    title: '初回オンボーディングの離脱要因を減らす',
    url: '/teams/core-team/issues/onboarding-friction',
  },
  {
    entityType: 'project',
    highlights: [],
    id: 'refero',
    title: 'Refero',
    url: '/projects/refero',
  },
  {
    entityType: 'document',
    highlights: [],
    id: 'document-meeting-notes',
    subtitle: 'Refero',
    title: '週次定例の議事録',
    url: '/documents/document-meeting-notes',
  },
]

/**
 * Replaces fetch with fixture responses for one scenario.
 *
 * @param scenario - Whether reads succeed, never finish, or fail.
 * @returns Restores the original fetch.
 */
function installLinkStoryFetch(scenario: LinkStoryScenario) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      globalThis.location.origin,
    )
    if (scenario === 'loading') return new Promise<Response>(() => undefined)
    if (scenario === 'error') {
      return Response.json({ message: '一時的に利用できません。' }, { status: 503 })
    }
    if (url.pathname.endsWith('/search')) {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as {
        entityTypes?: string[]
      }
      return Response.json({
        results: linkSearchResults.filter(
          (result) =>
            !filters.entityTypes ||
            filters.entityTypes.includes(result.entityType),
        ),
      })
    }
    if (url.pathname.endsWith('/teams/projects')) {
      return Response.json({ teams: projectDirectoryFixtures })
    }
    if (url.pathname.includes('/issues/')) {
      return Response.json({ issue: { ...teamIssueFixtures[0], key: 'CORE-1' } })
    }
    return Response.json(
      { message: `Unexpected Storybook request: ${url.pathname}` },
      { status: 404 },
    )
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

/**
 * Document link picker の Storybook metadata です。
 */
const meta = {
  title: 'Application/Documents/Link Picker',
  component: DocumentRelationTargetPicker,
  args: {
    accessToken: storyAccessToken,
    onSelect: fn(async () => undefined),
    t,
  },
  decorators: [
    (Story) => (
      <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
        <div className="max-w-md p-6">
          <Story />
        </div>
      </SWRConfig>
    ),
  ],
} satisfies Meta<typeof DocumentRelationTargetPicker>

/**
 * Document link picker の Storybook metadata です。
 */
export default meta

/**
 * Document link picker stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Typing a title shows permission-filtered Work Item candidates.
 */
export const SearchResults: Story = {
  beforeEach: () => installLinkStoryFetch('results'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText('リンク先を検索'), 'オンボーディング')
    await expect(
      await canvas.findByText('初回オンボーディングの離脱要因を減らす'),
    ).toBeInTheDocument()
  },
}

/**
 * The picker waits for a search that has not answered yet.
 */
export const Searching: Story = {
  beforeEach: () => installLinkStoryFetch('loading'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText('リンク先を検索'), '議事録')
    await expect(await canvas.findByText('検索しています…')).toBeInTheDocument()
  },
}

/**
 * A failed search offers a retry.
 */
export const SearchFailed: Story = {
  beforeEach: () => installLinkStoryFetch('error'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText('リンク先を検索'), '議事録')
    await expect(await canvas.findByText('検索できませんでした。')).toBeInTheDocument()
  },
}

/**
 * Choosing a candidate keeps it disabled while the link is saved.
 */
export const Saving: Story = {
  args: {
    onSelect: fn(() => new Promise<void>(() => undefined)),
  },
  beforeEach: () => installLinkStoryFetch('results'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText('リンク先を検索'), 'オンボーディング')
    await userEvent.click(
      await canvas.findByText('初回オンボーディングの離脱要因を減らす'),
    )
    await expect(await canvas.findByText('リンク中…')).toBeInTheDocument()
  },
}

/**
 * Whiteboard cards offer only Work Items, so the kind selector is hidden.
 */
export const WorkItemsOnly: Story = {
  args: { kinds: ['work-item'] },
  beforeEach: () => installLinkStoryFetch('results'),
}

/**
 * The existing-Document picker shown on a Work Item, Project, or Goal.
 */
export const ExistingDocument: Story = {
  beforeEach: () => installLinkStoryFetch('results'),
  render: () => (
    <LinkableDocumentPicker
      accessToken={storyAccessToken}
      linkedDocumentIds={new Set()}
      onSelect={fn(async () => undefined)}
      t={t}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText('リンクするドキュメントを検索'),
      '議事録',
    )
    await expect(await canvas.findByText('週次定例の議事録')).toBeInTheDocument()
  },
}

/**
 * Linked Work Item and Project labels read with the viewer's token.
 */
export const LinkedTargetLabels: Story = {
  beforeEach: () => installLinkStoryFetch('results'),
  render: () => (
    <div className="grid gap-3">
      <DocumentRelationTargetLabel
        accessToken={storyAccessToken}
        locale="ja"
        target={{
          kind: 'work-item',
          workItemId: 'team/core-team/issue/onboarding-friction',
        }}
        t={t}
      />
      <DocumentRelationTargetLabel
        accessToken={storyAccessToken}
        locale="ja"
        target={{ kind: 'project', projectId: 'refero' }}
        t={t}
      />
    </div>
  ),
}

/**
 * Labels whose read failed offer a retry instead of claiming the target is hidden.
 */
export const LinkedTargetLabelsFailed: Story = {
  beforeEach: () => installLinkStoryFetch('error'),
  render: LinkedTargetLabels.render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findAllByRole('button', { name: '再試行' }),
    ).toHaveLength(2)
  },
}
