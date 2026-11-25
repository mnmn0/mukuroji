import type { AgentRunHistoryEntry } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { mergeRunHistories, runHistoryProjectKey } from '../model/runHistory'
import { RunHistoryView, type RunHistoryFilterState, type RunHistoryViewProps } from './RunHistoryView'
import { createRunHistoryLabels } from './runHistoryLabels'

/** Labels of the stories. */
const labels = createRunHistoryLabels('ja')

/** Date format of the stories. */
const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

/**
 * Creates one finished run of the story history.
 *
 * @param teamId - Team of the run.
 * @param sequence - Distinguishes runs; a higher number finished later.
 * @param patch - Fields to override.
 * @returns The run.
 */
function entry(teamId: string, sequence: number, patch: Partial<AgentRunHistoryEntry> = {}): AgentRunHistoryEntry {
  const finishedAt = new Date(Date.UTC(2026, 10, 20, sequence)).toISOString()
  return {
    schemaVersion: 1, runId: `run_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, teamId,
    workItemId: `task-${sequence}`, assigneeUserId: 'member-1', runtime: 'claude-code', agentName: 'Claude Code', state: 'finished',
    outcome: 'completed', startRevision: 2, leaseMinutes: 30,
    startedAt: new Date(Date.UTC(2026, 10, 20, sequence) - 75 * 60_000).toISOString(),
    lastHeartbeatAt: finishedAt, leaseExpiresAt: finishedAt, stalled: false, finishedAt, finishedBy: 'agent', reportCount: 2,
    workItemTitle: `ログイン画面の不具合を直す ${sequence}`, ...patch,
  }
}

/** History of two Teams with every outcome. */
const history = mergeRunHistories([
  {
    teamId: 'team-core', from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T23:59:59.000Z', hasMore: false,
    runs: [
      entry('team-core', 9, { projectId: 'refero' }),
      entry('team-core', 7, { projectId: 'refero', outcome: 'failed', runtime: 'codex', agentName: 'Codex' }),
      entry('team-core', 3, { outcome: 'paused' }),
    ],
  },
  {
    teamId: 'team-mobile', from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T23:59:59.000Z', hasMore: false,
    runs: [
      entry('team-mobile', 8, { projectId: 'refero', outcome: 'released', workItemTitle: 'Push 通知の設定画面' }),
      entry('team-mobile', 5, { outcome: 'superseded' }),
    ],
  },
], { 'team-core': 'Core', 'team-mobile': 'Mobile' })

/** Filters the history opens with. */
const initialFilters: RunHistoryFilterState = { days: 7, teamId: '', outcome: '', runtime: '', projectId: '', mineOnly: false }

/**
 * Keeps the filters in story state, as the page does.
 *
 * @param props - View props; `filters` is the initial value.
 * @returns View with local filters.
 */
function StatefulRunHistoryView(props: RunHistoryViewProps) {
  const [filters, setFilters] = useState(props.filters)
  return (
    <RunHistoryView
      {...props}
      filters={filters}
      onFiltersChange={(next) => {
        setFilters(next)
        props.onFiltersChange(next)
      }}
    />
  )
}

/** Metadata of the Run history stories. */
const meta = {
  title: 'Application/Factory Board/Run History',
  component: RunHistoryView,
  decorators: [(Story) => <div className="min-h-svh bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    labels,
    filters: initialFilters,
    teams: [{ id: 'team-core', name: 'Core' }, { id: 'team-mobile', name: 'Mobile' }],
    projects: [
      { id: runHistoryProjectKey('team-core', 'refero'), name: 'Refero (Core)' },
      { id: runHistoryProjectKey('team-mobile', 'refero'), name: 'Refero アプリ (Mobile)' },
    ],
    history,
    isLoading: false,
    projectNames: {
      [runHistoryProjectKey('team-core', 'refero')]: 'Refero',
      [runHistoryProjectKey('team-mobile', 'refero')]: 'Refero アプリ',
    },
    formatDateTime: (value) => dateTimeFormat.format(new Date(value)),
    getWorkItemHref: (row) => `/teams/${row.teamId}/issues?issueId=${row.workItemId}`,
    onNavigate: fn(),
    onFiltersChange: fn(),
    onRetry: fn(),
    onDownload: fn(),
  },
  render: (args) => <StatefulRunHistoryView {...args} />,
} satisfies Meta<typeof RunHistoryView>

export default meta

/** Story type of the Run history. */
type Story = StoryObj<typeof meta>

/** Runs of two Teams; the same Project ID keeps each Team's name, and filters and CSV respond. */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByTestId('run-history-row')).toHaveLength(5)
    await expect(canvas.getByText('Refero アプリ')).toBeVisible()
    await userEvent.selectOptions(canvas.getByLabelText(labels.outcome), 'failed')
    await expect(args.onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
    await userEvent.click(canvas.getByRole('button', { name: labels.download }))
    await expect(args.onDownload).toHaveBeenCalled()
    await userEvent.click(canvas.getByRole('link', { name: 'Push 通知の設定画面' }))
    await expect(args.onNavigate).toHaveBeenCalledWith('/teams/team-mobile/issues?issueId=task-8')
  },
}

/** First read of the current filters. */
export const Loading: Story = {
  args: { history: undefined, isLoading: true },
}

/** No run matches the filters; the CSV download is unavailable. */
export const Empty: Story = {
  args: { history: { rows: [], hasMore: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(labels.empty)).toBeVisible()
    await expect(canvas.getByRole('button', { name: labels.download })).toBeDisabled()
  },
}

/** The read failed; the alert offers a retry. */
export const LoadError: Story = {
  args: { history: undefined, errorMessage: labels.loadError },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('alert')).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: labels.retry }))
    await expect(args.onRetry).toHaveBeenCalled()
  },
}

/** A Team had more runs in the period than one read returns, so the note says runs were left out. */
export const Truncated: Story = {
  args: { history: { ...history, hasMore: true } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('note')).toHaveTextContent(labels.incomplete)
  },
}

/** One Team's history may not be read by the viewer; the rest is shown and that Team is named. */
export const DeniedTeam: Story = {
  args: { history: { ...history, deniedTeamNames: ['Mobile'] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('run-history-denied-teams')).toHaveTextContent(labels.deniedTeams.replace('{teams}', 'Mobile'))
    await expect(canvas.getAllByTestId('run-history-row')).toHaveLength(5)
  },
}
