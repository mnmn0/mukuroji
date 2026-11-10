import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import {
  factoryBoardFixture,
  factoryBoardFixtureProjectNames,
  factoryBoardFixtureReports,
} from '../fixtures'
import { FactoryBoard, type FactoryBoardProps } from './FactoryBoard'
import { createFactoryBoardLabels } from './factoryBoardLabels'

/**
 * Keeps the selection in story state, as the page does, so tiles open the detail pane.
 *
 * @param props - Board props; `selectedWorkItemId` is the initial selection.
 * @returns Board with local selection.
 */
function StatefulFactoryBoard(props: FactoryBoardProps) {
  const [selectedWorkItemId, setSelectedWorkItemId] = useState(props.selectedWorkItemId)
  return (
    <FactoryBoard
      {...props}
      onSelect={(workItemId) => {
        setSelectedWorkItemId(workItemId)
        props.onSelect(workItemId)
      }}
      selectedWorkItemId={selectedWorkItemId}
    />
  )
}

/** Metadata of the Factory board stories. */
const meta = {
  title: 'Application/Factory Board/Board',
  component: FactoryBoard,
  decorators: [(Story) => <div className="min-h-svh bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    board: factoryBoardFixture,
    isLoading: false,
    labels: createFactoryBoardLabels('ja'),
    projectNames: factoryBoardFixtureProjectNames,
    formatDateTime: (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)),
    onRefresh: fn(),
    onSelect: fn(),
    onRelease: fn(async () => undefined),
    onNavigate: fn(),
    getWorkItemHref: (item) => `/teams/core/issues?issueId=${encodeURIComponent(item.workItem.id)}`,
    reports: { items: factoryBoardFixtureReports, isLoading: false, onRetry: fn() },
  },
  render: (args) => <StatefulFactoryBoard {...args} />,
} satisfies Meta<typeof FactoryBoard>

export default meta
/** Typed Factory board story. */
type Story = StoryObj<typeof meta>

/** Every lane is populated, with run-less Work Items at the end of the processing lane. */
export const PopulatedLanes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('region', { name: '処理中' })).toBeInTheDocument()
    await expect(canvas.getByTestId('factory-board-no-run')).toBeInTheDocument()
    await expect(canvas.queryByText(/%/u)).not.toBeInTheDocument()
  },
}

/** English labels keep the same hierarchy. */
export const English: Story = { args: { labels: createFactoryBoardLabels('en') } }

/** A Team with nothing on the board. */
export const Empty: Story = { args: { board: { ...factoryBoardFixture, items: [] } } }

/** First read in progress. */
export const Loading: Story = { args: { board: undefined, isLoading: true } }

/** A failed first read shows the error and a retry, never an empty board. */
export const LoadError: Story = {
  args: { board: undefined, errorMessage: createFactoryBoardLabels('ja').loadError },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('alert')).toHaveTextContent(createFactoryBoardLabels('ja').loadError)
    await expect(canvas.queryByText(createFactoryBoardLabels('ja').empty)).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: 'もう一度読み込む' }))
    await expect(args.onRefresh).toHaveBeenCalled()
  },
}

/** A failed background read keeps the last board and still offers a retry. */
export const RefreshError: Story = { args: { errorMessage: createFactoryBoardLabels('ja').loadError } }

/** A read bound was reached, so the board says it may be incomplete. */
export const Incomplete: Story = { args: { board: { ...factoryBoardFixture, finishedRunsHasMore: true } } }

/** A blocker report and an expired lease, each selectable for details. */
export const StalledAndBlocked: Story = {
  args: { board: { ...factoryBoardFixture, items: factoryBoardFixture.items.filter((item) => ['schema-change', 'stalled-import'].includes(item.workItem.id)) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('region', { name: '判断待ち' })).toHaveTextContent('ブロッカー')
    await expect(canvas.getByRole('region', { name: '停滞' })).toHaveTextContent('期限切れから 20 分')
    await userEvent.click(canvas.getByRole('button', { name: /CSV インポート/u }))
    await expect(canvas.getByRole('complementary')).toHaveTextContent('期限内に操作がありません')
  },
}

/** The detail pane shows the report timeline, checks, artifacts, start revision, and actions. */
export const DetailOpen: Story = {
  args: { selectedWorkItemId: 'auth-flow' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const detail = canvas.getByRole('complementary')
    await expect(detail).toHaveTextContent('開始 revision')
    await expect(within(detail).getByRole('link', { name: /#42/u })).toHaveAttribute('href', 'https://github.com/example/mukuroji/pull/42')
    await userEvent.click(within(detail).getByRole('link', { name: 'Work Item を開く' }))
    await expect(args.onNavigate).toHaveBeenCalledWith('/teams/core/issues?issueId=auth-flow')
  },
}

/** A failed report read in the detail offers its own retry. */
export const DetailReportsError: Story = {
  args: { selectedWorkItemId: 'auth-flow', reports: { isLoading: false, errorMessage: createFactoryBoardLabels('ja').reportsError, onRetry: fn() } },
}

/** Phone width stacks the lanes; selecting a tile switches to the detail with a back action. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tile = canvas.getByRole('button', { name: /API の認証フロー/u })
    await userEvent.click(tile)
    await expect(canvas.getByRole('complementary')).toHaveTextContent('報告の時系列')
  },
}

/** Phone width with the detail already open. */
export const PhoneDetailOpen: Story = {
  args: { selectedWorkItemId: 'schema-change' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
