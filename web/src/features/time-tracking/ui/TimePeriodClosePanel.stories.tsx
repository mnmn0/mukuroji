import type { TimePeriodClose, WorkspaceTimePeriodResult } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { createTimeTrackingFormatters } from './timeTrackingText'
import { TimePeriodClosePanel } from './TimePeriodClosePanel'

const julyClose: TimePeriodClose = {
  schemaVersion: 1,
  workspaceId: 'workspace-demo',
  teamId: 'core-team',
  month: '2026-07',
  timeZone: 'Asia/Tokyo',
  closedBy: 'manager-1',
  closedAt: '2026-08-02T03:00:00.000Z',
}

const augustWorkspaceClose: WorkspaceTimePeriodResult = {
  month: '2026-08',
  results: [{ teamId: 'core-team', status: 'closed' }, { teamId: 'growth-team', status: 'already-closed' }],
  partialFailure: false,
}

/** Metadata of the month close stories. */
const meta = {
  title: 'Application/Time Tracking/Month Close',
  component: TimePeriodClosePanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    formatMonth: (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`,
    timeZone: 'Asia/Tokyo',
    defaultMonth: '2026-08',
    periods: { closedPeriods: [julyClose], canManagePeriods: true, canManageWorkspacePeriods: false },
    onRetry: fn(),
    onCloseMonth: fn(async () => julyClose),
    onReopenMonth: fn(async () => julyClose),
    workspaceMonth: '2026-08',
    onWorkspaceMonthChange: fn(),
    onRetryWorkspace: fn(),
    teamNames: { 'core-team': 'コア開発', 'growth-team': 'グロース' },
    onCloseWorkspaceMonth: fn(async () => augustWorkspaceClose),
    onReopenWorkspaceMonth: fn(async () => ({ month: '2026-08', results: [], partialFailure: false })),
  },
} satisfies Meta<typeof TimePeriodClosePanel>

export default meta
/** Typed month close story. */
type Story = StoryObj<typeof meta>

/** A manager of the whole Team reopens July with a reason. */
export const Reopen: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '2026年7月 の締めを解除' }))
    await userEvent.type(canvas.getByLabelText('解除の理由'), '請求の訂正')
    await userEvent.click(canvas.getByRole('button', { name: '解除する' }))
    await expect(args.onReopenMonth).toHaveBeenCalledWith('2026-07', '請求の訂正')
  },
}

/** A member who manages only some Projects sees the closed months without actions. */
export const ReadOnly: Story = {
  args: {
    periods: { closedPeriods: [julyClose], canManagePeriods: false, canManageWorkspacePeriods: false },
  },
}

/** A Workspace administrator closes August for every Team. */
export const Workspace: Story = {
  args: {
    periods: { closedPeriods: [], canManagePeriods: true, canManageWorkspacePeriods: true },
    workspaceState: {
      month: '2026-08',
      teams: [{ teamId: 'core-team' }, { teamId: 'growth-team', close: { ...julyClose, teamId: 'growth-team', month: '2026-08' } }],
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '全 Team で締める' }))
    await expect(args.onCloseWorkspaceMonth).toHaveBeenCalledWith('2026-08')
    await expect(await canvas.findByText('1 Team を締めました（締め済みだった Team: 1）。')).toBeInTheDocument()
  },
}

/** The closed months could not be read. */
export const LoadError: Story = {
  args: {
    periods: undefined,
    hasLoadError: true,
  },
}
