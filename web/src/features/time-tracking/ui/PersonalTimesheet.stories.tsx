import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  createTimeEntryFixture,
  timeTrackingFixtureEntries,
  timeTrackingFixtureRejectionReasons,
  timeTrackingFixtureWeekStart,
  timeTrackingFixtureWorkItems,
} from '../fixtures'
import { createWeekPeriod } from '../model/timePeriod'
import { PersonalTimesheet } from './PersonalTimesheet'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Metadata of the member timesheet stories. */
const meta = {
  title: 'Application/Time Tracking/Personal Timesheet',
  component: PersonalTimesheet,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    teamId: 'core-team',
    formatters: createTimeTrackingFormatters('ja'),
    week: createWeekPeriod(timeTrackingFixtureWeekStart),
    today: '2026-11-10',
    entries: timeTrackingFixtureEntries,
    rejectionReasons: timeTrackingFixtureRejectionReasons,
    workItemOptions: timeTrackingFixtureWorkItems,
    workItemTitles: Object.fromEntries(timeTrackingFixtureWorkItems.map((item) => [item.id, item.title])),
    onMoveWeek: fn(),
    onRetry: fn(),
    onCreateEntry: fn(async () => undefined),
    onUpdateEntry: fn(async () => undefined),
    onSubmitEntry: fn(async () => undefined),
    onSubmitWeek: fn(async () => ({ count: 2, failedEntryIds: [], partialFailure: false, entries: [] })),
    indirectTargets: { projects: [{ id: 'refero', name: 'Refero' }], allowNoProject: true },
    onCreateIndirectEntry: fn(async () => undefined),
    onUpdateIndirectEntry: fn(async () => undefined),
    onDeleteEntry: fn(async () => undefined),
  },
} satisfies Meta<typeof PersonalTimesheet>

export default meta
/** Typed timesheet story. */
type Story = StoryObj<typeof meta>

/** A week with every lifecycle state and a rejected entry to fix. */
export const Week: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('table', { name: 'タスク別・日別の工数' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: '下書きをまとめて提出（2 件）' })).toBeEnabled()
  },
}

/** A meeting recorded as indirect work, without a task, and a draft being deleted. */
export const IndirectWork: Story = {
  args: {
    entries: [
      ...timeTrackingFixtureEntries,
      createTimeEntryFixture({
        id: 'entry-meeting',
        workItemId: undefined,
        category: 'meeting',
        durationOnly: true,
        startAt: '2026-11-10T15:00:00.000Z',
        endAt: '2026-11-10T17:00:00.000Z',
        durationMinutes: 120,
        description: 'Weekly sync',
      }),
      createTimeEntryFixture({
        id: 'entry-training',
        workItemId: undefined,
        category: 'training',
        startAt: '2026-11-11T09:00:00.000Z',
        endAt: '2026-11-11T10:30:00.000Z',
        durationMinutes: 90,
        description: 'Timed training',
      }),
    ],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('rowheader', { name: '間接作業・会議' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: '間接作業を追加' }))
    await expect(canvas.getByRole('form', { name: '間接作業を追加' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'キャンセル' }))
    const [firstDelete] = canvas.getAllByRole('button', { name: /^削除 / })
    if (!firstDelete) throw new Error('Expected a delete button.')
    await userEvent.click(firstDelete)
    await userEvent.click(canvas.getByRole('button', { name: '削除をやめる' }))
    await expect(firstDelete).toHaveFocus()
    await userEvent.click(firstDelete)
    await userEvent.click(canvas.getByRole('button', { name: 'この下書きを削除' }))
    await expect(args.onDeleteEntry).toHaveBeenCalledTimes(1)

    // Editing only the note of a timed entry keeps its start and end.
    const timedRow = canvas.getByText('Timed training').closest('li')
    if (!(timedRow instanceof HTMLElement)) throw new Error('Expected the timed entry row.')
    await userEvent.click(within(timedRow).getByRole('button', { name: /^編集 / }))
    const form = canvas.getByRole('form', { name: '間接作業を編集' })
    const note = within(form).getByRole('textbox', { name: 'メモ' })
    await userEvent.clear(note)
    await userEvent.type(note, 'Renamed training')
    await userEvent.click(within(form).getByRole('button', { name: '変更を保存' }))
    await expect(args.onUpdateIndirectEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'entry-training' }),
      expect.objectContaining({ description: 'Renamed training', keepRecordedInterval: true }),
    )
  },
}

/** An empty week. */
export const EmptyWeek: Story = {
  args: { entries: [] },
}

/** Phone width; the table scrolls inside its frame. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
