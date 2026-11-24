import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type {
  WorkCalendar,
  WorkCalendarAdjustment,
  WorkCalendarChangeImpact,
  WorkCalendarChangeResult,
  WorkCalendarResponse,
} from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { createWorkCalendarDraft, type WorkCalendarDraft } from '../model/workCalendarDraft'
import {
  WorkCalendarAdjustmentFields,
  WorkCalendarImpactSummary,
  WorkCalendarPanel,
  WorkCalendarResultSummary,
  type WorkCalendarPanelProps,
} from './WorkCalendarPanel'

const t = createTranslator('ja')

/** Stored Team calendar that adds one company day off to a Monday-to-Friday Workspace calendar. */
const storedTeamCalendar: WorkCalendar = {
  scope: { kind: 'team', teamId: 'core-team' },
  additionalHolidays: ['2026-12-09'],
  changeAdjustment: 'keep-end-date',
  revision: 2,
  updatedAt: '2026-11-22T00:00:00.000Z',
  updatedBy: 'user#owner@example.com',
}

/** Calendar response of the Team. */
const teamCalendar: WorkCalendarResponse = {
  scope: { kind: 'team', teamId: 'core-team' },
  calendar: storedTeamCalendar,
  changeAdjustment: 'keep-end-date',
  resolvedPolicy: {
    workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    holidays: ['2026-12-09'],
    timeZone: 'Asia/Tokyo',
    calendarSource: 'shared',
  },
  inheritedPolicy: {
    workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    holidays: [],
    timeZone: 'Asia/Tokyo',
    calendarSource: 'shared',
  },
  canManage: true,
}

/** Previewed change that moves two Work Items. */
const impact: WorkCalendarChangeImpact = {
  adjustment: 'keep-end-date',
  followingCount: 12,
  changedCount: 2,
  fallbackToKeepDurationCount: 1,
  examples: [
    {
      teamId: 'core-team',
      workItemId: 'item-1',
      title: '設計レビュー',
      before: { startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 5 },
      after: { startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 4 },
    },
    {
      teamId: 'core-team',
      workItemId: 'item-2',
      title: 'リリース準備',
      before: { startDate: '2026-12-09', endDate: '2026-12-09', durationDays: 1 },
      after: { startDate: '2026-12-09', endDate: '2026-12-10', durationDays: 1 },
    },
  ],
}

/** Saved change where one Work Item changed while the rewrite ran. */
const resultWithConflict: WorkCalendarChangeResult = {
  calendar: { ...storedTeamCalendar, revision: 3 },
  impact,
  updatedCount: 1,
  conflictCount: 1,
}

/** Props of {@link EditableWorkCalendarPanel}. */
type EditableWorkCalendarPanelProps = {
  /** Calendar the panel starts from. */
  calendar: WorkCalendarResponse
}

/**
 * Keeps the edited draft in state, as the panel container does.
 *
 * @param props - Starting calendar.
 * @returns The panel wired to local state.
 */
function EditableWorkCalendarPanel({ calendar }: EditableWorkCalendarPanelProps) {
  const [draft, setDraft] = useState<WorkCalendarDraft>(() => createWorkCalendarDraft(calendar))
  return (
    <div className="max-w-3xl p-6">
      <WorkCalendarPanel {...baseProps} calendar={calendar} draft={draft} onDraftChange={setDraft} />
    </div>
  )
}

/** Props shared by the panel stories. */
const baseProps: WorkCalendarPanelProps = {
  scopeOptions: [
    { value: 'core-team', label: 'Core' },
    { value: 'core-team:project-1', label: 'Core / 新製品' },
  ],
  selectedScope: 'core-team',
  calendar: teamCalendar,
  draft: createWorkCalendarDraft(teamCalendar),
  isLoading: false,
  impact: undefined,
  result: undefined,
  isBusy: false,
  t,
  onScopeChange: () => undefined,
  onDraftChange: () => undefined,
  onPreview: () => undefined,
  onSave: () => undefined,
  onRetry: () => undefined,
}

const meta = {
  title: 'Application/Workspace/Work Calendar Panel',
  component: WorkCalendarPanel,
  args: baseProps,
} satisfies Meta<typeof WorkCalendarPanel>

/** Team and Project calendar editor with the change preview (ADR 0058). */
export default meta

/** Story variants for the Team and Project calendar editor. */
type Story = StoryObj<typeof meta>

/** Adding a company day off and overriding the inherited weekdays. */
export const Editable: Story = {
  render: () => <EditableWorkCalendarPanel calendar={teamCalendar} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('work-calendar-weekday-monday')).toBeDisabled()
    await userEvent.click(canvas.getByTestId('work-calendar-inherit-weekdays'))
    await expect(canvas.getByTestId('work-calendar-weekday-monday')).toBeEnabled()
    await userEvent.type(canvas.getByTestId('work-calendar-holiday-draft'), '2026-12-24')
    await userEvent.click(canvas.getByTestId('work-calendar-holiday-add'))
    await expect(canvas.getByText('2026-12-24')).toBeInTheDocument()
  },
}

/** Previewed Work Items that the change moves. */
export const Previewed: Story = {
  args: { impact },
}

/** Saved change with a Work Item that changed while the rewrite ran. */
export const SavedWithConflict: Story = {
  args: { result: resultWithConflict },
}

/** Read-only for a member who cannot manage the calendar. */
export const ReadOnly: Story = {
  args: { calendar: { ...teamCalendar, canManage: false } },
}

/** Failed save, such as a newer calendar saved by another member. */
export const Failed: Story = {
  args: { errorMessage: t('workspace.workCalendar.error.failed') },
}

/**
 * Previews and applies the Workspace calendar adjustment with fixtures, as the Workspace
 * settings section does after its calendar is saved.
 *
 * @returns The adjustment controls with a preview and a result.
 */
function WorkspaceAdjustmentPreview() {
  const [adjustment, setAdjustment] = useState<WorkCalendarAdjustment>('keep-duration')
  const [applied, setApplied] = useState(false)
  return (
    <div className="grid max-w-3xl gap-3 p-6">
      <WorkCalendarAdjustmentFields adjustment={adjustment} disabled={false} onChange={setAdjustment} t={t} />
      <button
        className="workbench-button-primary justify-self-start"
        data-testid="workspace-work-calendar-apply"
        onClick={() => setApplied(true)}
        type="button"
      >
        {t('workspace.workCalendar.apply')}
      </button>
      {applied ? null : <WorkCalendarImpactSummary impact={{ ...impact, adjustment }} t={t} />}
      {applied ? <WorkCalendarResultSummary result={{ impact, updatedCount: 2, conflictCount: 0 }} t={t} /> : null}
    </div>
  )
}

/** Workspace calendar adjustment: the previewed impact, then the applied result. */
export const WorkspaceAdjustment: Story = {
  render: () => <WorkspaceAdjustmentPreview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('work-calendar-impact')).toBeInTheDocument()
    await userEvent.click(canvas.getByTestId('workspace-work-calendar-apply'))
    await expect(canvas.getByTestId('work-calendar-result')).toBeInTheDocument()
  },
}
