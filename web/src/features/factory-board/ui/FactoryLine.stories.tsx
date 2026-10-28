import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { factoryBoardFixtureProjectNames, factoryBoardFixtureReports, factoryLineFixture } from '../fixtures'
import { FactoryBoard, type FactoryBoardProps } from './FactoryBoard'
import { createFactoryBoardLabels } from './factoryBoardLabels'

/**
 * Keeps the view and selection in story state, as the page does.
 *
 * @param props - Board props; `view` and `selectedWorkItemId` are the initial values.
 * @returns Board with local view and selection.
 */
function StatefulFactoryLine(props: FactoryBoardProps) {
  const [view, setView] = useState(props.view)
  const [selectedWorkItemId, setSelectedWorkItemId] = useState(props.selectedWorkItemId)
  return (
    <FactoryBoard
      {...props}
      onSelect={(workItemId) => {
        setSelectedWorkItemId(workItemId)
        props.onSelect(workItemId)
      }}
      onViewChange={(next) => {
        setView(next)
        props.onViewChange?.(next)
      }}
      selectedWorkItemId={selectedWorkItemId}
      view={view}
    />
  )
}

/** Metadata of the Factory board line view stories. */
const meta = {
  title: 'Application/Factory Board/Line',
  component: FactoryBoard,
  decorators: [(Story) => <div className="min-h-svh bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    board: factoryLineFixture,
    view: 'line',
    isLoading: false,
    labels: createFactoryBoardLabels('ja'),
    projectNames: factoryBoardFixtureProjectNames,
    formatDateTime: (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)),
    onRefresh: fn(),
    onSelect: fn(),
    onViewChange: fn(),
    onRelease: fn(async () => undefined),
    onNavigate: fn(),
    getWorkItemHref: (item) => `/teams/core/issues?issueId=${encodeURIComponent(item.workItem.id)}`,
    reports: { items: factoryBoardFixtureReports, isLoading: false, onRetry: fn() },
  },
  render: (args) => <StatefulFactoryLine {...args} />,
} satisfies Meta<typeof FactoryBoard>

export default meta
/** Typed line view story. */
type Story = StoryObj<typeof meta>

/** The whole line with every station holding work. */
export const WholeLine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('img', { name: 'ソフトウェア工場のライン' })).toBeInTheDocument()
    await expect(canvas.getByRole('button', { name: /全体/u })).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.getByRole('complementary')).toHaveTextContent('ライン全体')
  },
}

/** Choosing a station moves the camera and lists its tasks; a task opens its detail. */
export const StationChosen: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /02\s*実装/u }))
    const panel = canvas.getByRole('complementary')
    await expect(panel).toHaveTextContent('エージェントが実装を進めています。')
    await expect(panel).toHaveTextContent('停滞中')
    await userEvent.click(within(panel).getByRole('button', { name: /返金一覧に取引 ID/u }))
    await expect(args.onSelect).toHaveBeenCalledWith('refund-ids')
    // Focus moves into the detail on the next frame.
    await waitFor(() => expect(canvas.getByRole('complementary')).toHaveFocus())
    await userEvent.click(canvas.getByRole('button', { name: '工程に戻る' }))
    // Returning puts focus back on the task that opened the detail.
    await waitFor(() => expect(canvas.getByRole('button', { name: /返金一覧に取引 ID/u })).toHaveFocus())
    // Choosing another station while a task is open shows that station's tasks.
    await userEvent.click(canvas.getByRole('button', { name: /返金一覧に取引 ID/u }))
    await userEvent.click(canvas.getByRole('button', { name: /03\s*検証/u }))
    await expect(canvas.getByRole('complementary')).toHaveTextContent('エージェントがテストや確認コマンドを実行しました。')
  },
}

/** The decision station, where people act. */
export const DecisionStation: Story = { args: { initialFocusedStation: 'decision' } }

/** The repair bay beside the line holds failed runs. */
export const RepairBay: Story = { args: { initialFocusedStation: 'repair' } }

/** English labels keep the same hierarchy. */
export const English: Story = { args: { labels: createFactoryBoardLabels('en'), initialFocusedStation: 'verify' } }

/** The view switch returns to the lanes. */
export const SwitchToLanes: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'レーン' }))
    await expect(args.onViewChange).toHaveBeenCalledWith('lanes')
    await expect(canvas.getByRole('region', { name: '処理中' })).toBeInTheDocument()
  },
}

/** Phone width stacks the line above the panel. */
export const Phone: Story = {
  args: { initialFocusedStation: 'build' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
