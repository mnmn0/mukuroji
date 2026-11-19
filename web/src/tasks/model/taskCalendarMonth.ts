import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { resolveTaskSchedule, resolveTaskSchedulePrimaryDate } from './taskSchedule'
import {
  createTaskCalendarMonthWindow,
  listTaskScheduleWindowDates,
} from './taskScheduleWindow'
import { createTaskKey } from './taskView'

/**
 * Lists the Work Items a monthly calendar shows, in the order its cards appear.
 *
 * The calendar places a Work Item on its schedule's primary date and keeps unscheduled Work Items
 * in a bucket after the dates, so keyboard navigation and action targets match the shown cards:
 * Work Items dated outside the month are left out.
 *
 * @param tasks - Filtered Work Items given to the calendar.
 * @param month - Month the calendar shows, in `YYYY-MM` form.
 * @returns The Work Items dated in the month by date, then the unscheduled ones.
 */
export function listTaskCalendarMonthTasks<Task extends CanonicalWorkItem>(
  tasks: readonly Task[],
  month: string,
): Task[] {
  const monthDates = new Set(listTaskScheduleWindowDates(createTaskCalendarMonthWindow(month)))
  const scheduledTasks = tasks.flatMap((task) => {
    const date = resolveTaskSchedulePrimaryDate(resolveTaskSchedule(task))
    return date && monthDates.has(date) ? [{ date, task }] : []
  })
  const unscheduledTasks = tasks.filter((task) => resolveTaskSchedule(task).mode === 'unscheduled')
  return [
    ...scheduledTasks
      .toSorted((left, right) =>
        left.date.localeCompare(right.date) || compareTaskKeys(left.task, right.task))
      .map(({ task }) => task),
    ...unscheduledTasks.toSorted(compareTaskKeys),
  ]
}

/**
 * Orders two Work Items the way the calendar orders the cards of one cell.
 *
 * @param left - First Work Item.
 * @param right - Second Work Item.
 * @returns A negative, zero, or positive comparison result.
 */
function compareTaskKeys(left: CanonicalWorkItem, right: CanonicalWorkItem): number {
  return createTaskKey(left).localeCompare(createTaskKey(right))
}
