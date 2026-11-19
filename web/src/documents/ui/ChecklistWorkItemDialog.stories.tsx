import type { Meta, StoryObj } from '@storybook/react-vite'
import { SWRConfig } from 'swr'
import { expect, fn, within } from 'storybook/test'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { ChecklistWorkItemDialog } from './ChecklistWorkItemDialog'

/** Project member API state a dialog story reproduces. */
type MemberStoryScenario = 'members' | 'loading' | 'error'

const t = createTranslator('ja')

/**
 * Replaces fetch with Project member fixture responses for one scenario.
 *
 * @param scenario - Whether member reads succeed, never finish, or fail.
 * @returns Restores the original fetch.
 */
function installMemberStoryFetch(scenario: MemberStoryScenario) {
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
    const match = /\/projects\/([^/]+)\/members$/u.exec(url.pathname)
    if (match) {
      return Response.json({
        members: [
          {
            email: 'demo@example.com',
            id: 'demo@example.com',
            name: '山田 花子',
            role: 'manager',
            updatedAt: '2026-11-01T00:00:00.000Z',
            workspaceStatus: 'active',
          },
          {
            email: 'sato@example.com',
            id: 'sato@example.com',
            name: '佐藤 一郎',
            role: 'member',
            updatedAt: '2026-11-01T00:00:00.000Z',
            workspaceStatus: 'active',
          },
        ],
        projectId: decodeURIComponent(match[1] ?? ''),
      })
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
 * Checklist Work Item dialog の Storybook metadata です。
 */
const meta = {
  title: 'Application/Documents/Checklist Work Item Dialog',
  component: ChecklistWorkItemDialog,
  args: {
    accessToken: 'storybook-checklist-work-item-token',
    currentUserKey: 'demo@example.com',
    defaultProjectId: 'refero',
    itemText: '見積もりを金曜までに送る',
    onClose: fn(),
    onSubmit: fn(async () => undefined),
    t,
    teams: projectDirectoryFixtures,
  },
  decorators: [
    (Story) => (
      <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
        <Story />
      </SWRConfig>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ChecklistWorkItemDialog>

/**
 * Checklist Work Item dialog の Storybook metadata です。
 */
export default meta

/**
 * Checklist Work Item dialog stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * The item text, the Document's Project, and the current user are selected first.
 */
export const Default: Story = {
  beforeEach: () => installMemberStoryFetch('members'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByRole('option', { name: '山田 花子' })).toBeInTheDocument()
    await expect(canvas.getByDisplayValue('見積もりを金曜までに送る')).toBeVisible()
  },
}

/**
 * The assignee list says it is loading while Project members are read.
 */
export const LoadingAssignees: Story = {
  beforeEach: () => installMemberStoryFetch('loading'),
}

/**
 * A failed member read is shown with a reload action instead of an empty list.
 */
export const AssigneesError: Story = {
  beforeEach: () => installMemberStoryFetch('error'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByText('担当者の候補を読み込めませんでした。'),
    ).toBeVisible()
    await expect(canvas.getByRole('button', { name: '再読み込み' })).toBeVisible()
  },
}

/**
 * After the Work Item was created but the link failed, only the link is retried.
 */
export const LinkOnlyRetry: Story = {
  args: {
    linkOnly: true,
  },
  beforeEach: () => installMemberStoryFetch('members'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(canvas.getByRole('button', { name: 'リンクをやり直す' })).toBeEnabled()
    await expect(canvas.getByDisplayValue('見積もりを金曜までに送る')).toBeDisabled()
  },
}
