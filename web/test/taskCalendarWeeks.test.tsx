import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createDefaultDueDateTaskSchedule } from '../src/tasks/model/taskSchedule'
import {
  groupTaskCalendarDaysByWeek,
  resolveTaskCalendarWeekdayKey,
} from '../src/tasks/model/taskCalendarMonth'
import { TaskCalendarView } from '../src/tasks/ui/TaskCalendarView'
import { taskViewStoryTasks } from '../src/tasks/ui/TaskView.stories.fixtures'

const t = createTranslator('ja')

describe('task Calendar weeks', () => {
  test('groups dates into weeks that start on the Workspace week start', () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-07', '2026-11-08', '2026-11-09']
      .map((date) => ({ date }))

    expect(groupTaskCalendarDaysByWeek(days, 1).map((week) => [
      week.weekStartDate,
      week.weekEndDate,
      week.days.map((day) => day.date),
    ])).toEqual([
      ['2026-10-26', '2026-11-01', ['2026-11-01']],
      ['2026-11-02', '2026-11-08', ['2026-11-02', '2026-11-07', '2026-11-08']],
      ['2026-11-09', '2026-11-15', ['2026-11-09']],
    ])
    expect(groupTaskCalendarDaysByWeek(days, 0).map((week) => week.weekStartDate))
      .toEqual(['2026-11-01', '2026-11-08'])
  })

  test('names a week past year 9999 by its shown dates', () => {
    expect(groupTaskCalendarDaysByWeek([{ date: '9999-12-30' }, { date: '9999-12-31' }], 1))
      .toEqual([{
        days: [{ date: '9999-12-30' }, { date: '9999-12-31' }],
        weekEndDate: '9999-12-31',
        weekStartDate: '9999-12-27',
      }])
  })

  test('labels weekdays', () => {
    expect(resolveTaskCalendarWeekdayKey('2026-11-22')).toBe('tasks.calendar.day.sun')
    expect(resolveTaskCalendarWeekdayKey('2026-11-23')).toBe('tasks.calendar.day.mon')
    expect(resolveTaskCalendarWeekdayKey('2026-11-28')).toBe('tasks.calendar.day.sat')
  })

  test('shows a month under week headings from the Workspace week start', () => {
    const tasks = [{ ...taskViewStoryTasks[0], schedule: createDefaultDueDateTaskSchedule('2026-11-10') }]
    const sundayHtml = renderToStaticMarkup(
      <TaskCalendarView
        calendarPeriods={{ fiscalYearStartMonth: 4, weekStartDay: 0 }}
        month="2026-11"
        t={t}
        tasks={tasks}
      />,
    )
    const mondayHtml = renderToStaticMarkup(<TaskCalendarView month="2026-11" t={t} tasks={tasks} />)

    expect(sundayHtml).toContain('data-testid="task-calendar-week-2026-11-01"')
    expect(sundayHtml).toContain('2026-11-29 〜 2026-12-05 の週')
    expect(sundayHtml).not.toContain('data-testid="task-calendar-week-2026-10-26"')
    expect(mondayHtml).toContain('data-testid="task-calendar-week-2026-10-26"')
    expect(mondayHtml).toContain('data-testid="task-calendar-week-2026-11-30"')
    expect(mondayHtml).toMatch(/dateTime="2026-11-10">2026-11-10<span[^>]*>火<\/span>/)
  })
})
