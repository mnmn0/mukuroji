import type { TimePeriodClose, WorkspaceTimePeriodResult } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { WorkspaceTimePeriodPanel } from './WorkspaceTimePeriodPanel'

const augustClose: TimePeriodClose = {
  schemaVersion: 1,
  workspaceId: 'workspace-demo',
  teamId: 'growth-team',
  month: '2026-08',
  timeZone: 'Asia/Tokyo',
  closedBy: 'manager-1',
  closedAt: '2026-09-02T03:00:00.000Z',
}

const augustWorkspaceClose: WorkspaceTimePeriodResult = {
  month: '2026-08',
  results: [{ teamId: 'core-team', status: 'closed' }, { teamId: 'growth-team', status: 'already-closed' }],
  partialFailure: false,
}

/** Metadata of the Workspace month close stories. */
const meta = {
  title: 'Application/Time Tracking/Workspace Month Close',
  component: WorkspaceTimePeriodPanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    timeZone: 'Asia/Tokyo',
    workspaceMonth: '2026-08',
    onWorkspaceMonthChange: fn(),
    onRetryWorkspace: fn(),
    workspaceState: {
      month: '2026-08',
      teams: [{ teamId: 'core-team', name: 'コア開発' }, { teamId: 'growth-team', name: 'グロース', close: augustClose }],
    },
    onCloseWorkspaceMonth: fn(async () => augustWorkspaceClose),
    onReopenWorkspaceMonth: fn(async () => ({ month: '2026-08', results: [], partialFailure: false })),
  },
} satisfies Meta<typeof WorkspaceTimePeriodPanel>

export default meta
/** Typed Workspace month close story. */
type Story = StoryObj<typeof meta>

/** A Workspace administrator closes August for every Team. */
export const CloseEveryTeam: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '全 Team で締める' }))
    await expect(args.onCloseWorkspaceMonth).toHaveBeenCalledWith('2026-08')
    await expect(await canvas.findByText('1 Team を締めました（締め済みだった Team: 1）。')).toBeInTheDocument()
  },
}

/** The Workspace month could not be read. */
export const LoadError: Story = {
  args: {
    workspaceState: undefined,
    hasWorkspaceLoadError: true,
  },
}
