import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import {
  WorkItemExternalLinksPanel,
} from './WorkItemExternalLinksPanel'
import { createWorkItemExternalLinksLabels } from './externalLinkLabels'
import {
  externalLinkInstallationFixtures,
  externalWorkItemLinkFixtures,
} from './externalLinksFixtures'

const labels = createWorkItemExternalLinksLabels('en')

const meta = {
  title: 'Application/Work Items/External Links',
  component: WorkItemExternalLinksPanel,
  parameters: {
    layout: 'padded',
  },
  args: {
    canManage: true,
    installations: externalLinkInstallationFixtures,
    labels,
    links: externalWorkItemLinkFixtures,
    onCreate: async () => undefined,
    onLoadMore: async () => undefined,
    onRetry: async () => undefined,
    onUnlink: async () => undefined,
    onUpdateDirection: async () => undefined,
  },
} satisfies Meta<typeof WorkItemExternalLinksPanel>

export default meta

/**
 * Work Item 外部 link Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * 複数 account と同期状態を source card で表示します。
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('GH-29')).toBeVisible()
    await expect(canvas.getByText('mukuroji-platform')).toBeVisible()
    const addButton = canvas.getByRole('button', { name: labels.addLink })
    await expect(addButton).toBeEnabled()
    await userEvent.click(addButton)
    await expect(canvas.getByRole('combobox', { name: labels.installation })).toHaveValue('connector-github-product')
    await expect(canvas.getByRole('combobox', { name: labels.resourceType })).toHaveValue('issue')
    await expect(canvas.getByRole('textbox', { name: labels.externalUrl })).toHaveAttribute('type', 'url')
  },
}

/**
 * External link がまだ無い初回利用状態です。
 */
export const Empty: Story = {
  args: {
    links: [],
  },
}

/**
 * Connected installation が無く link を追加できない状態です。
 */
export const NoConnectedAccount: Story = {
  args: {
    installations: externalLinkInstallationFixtures.map((installation) => ({
      ...installation,
      status: 'disconnected' as const,
    })),
    links: [],
  },
}

/**
 * Permission が無く既存 link を参照だけできる状態です。
 */
export const ReadOnly: Story = {
  args: {
    canManage: false,
    onCreate: undefined,
    onUnlink: undefined,
    onUpdateDirection: undefined,
  },
}

/**
 * External link の読み込み中を示す skeleton 状態です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    links: [],
  },
}

/**
 * External link の取得に失敗し recovery action を表示する状態です。
 */
export const ErrorState: Story = {
  args: {
    errorMessage: labels.loadError,
    links: [],
  },
}

/**
 * Cursor の次 page を取得できる状態です。
 */
export const HasMore: Story = {
  args: {
    hasMore: true,
  },
}

/**
 * 取得済み source card を保持しながら追加 page の retry を案内します。
 */
export const PaginationError: Story = {
  args: {
    hasMore: true,
    loadMoreErrorMessage: labels.loadMoreError,
  },
}

/**
 * Connector 切断後も source card を残し、再接続が必要なことを示します。
 */
export const DisconnectedLinkedSource: Story = {
  args: {
    installations: externalLinkInstallationFixtures.map((installation) => ({
      ...installation,
      status: 'disconnected' as const,
    })),
  },
}
