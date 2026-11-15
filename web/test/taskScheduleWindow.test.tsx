import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { taskViewStoryConfigurationsByTeam, taskViewStoryTasks } from '../src/tasks/ui/TaskView.stories.fixtures'
import {
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
} from '../src/tasks/model/taskSchedule'
import {
  createTaskCalendarMonthWindow,
  createTaskGanttWindow,
  getCurrentTaskMonth,
  isTaskScheduleInWindow,
  listTaskScheduleWindowDates,
  shiftTaskMonth,
} from '../src/tasks/model/taskScheduleWindow'
import { TaskCalendarView } from '../src/tasks/ui/TaskCalendarView'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'

const t = createTranslator('ja')

describe('task schedule window', () => {
  test('creates month and Gantt windows across year boundaries', () => {
    expect(getCurrentTaskMonth(new Date(2026, 10, 15))).toBe('2026-11')
    expect(shiftTaskMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftTaskMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftTaskMonth('2026-11', -23)).toBe('2024-12')
    expect(createTaskCalendarMonthWindow('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(createTaskGanttWindow('2026-11')).toEqual({ from: '2026-11-01', to: '2027-01-31' })
    expect(listTaskScheduleWindowDates({ from: '2026-12-30', to: '2027-01-02' })).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
    expect(() => shiftTaskMonth('2026-13', 1)).toThrow(RangeError)
  })

  test('matches the server overlap rule for each schedule mode', () => {
    const window = { from: '2026-11-01', to: '2026-11-30' }
    expect(isTaskScheduleInWindow(createDefaultDueDateTaskSchedule('2026-11-30'), window)).toBeTrue()
    expect(isTaskScheduleInWindow(createDefaultDueDateTaskSchedule('2026-12-01'), window)).toBeFalse()
    expect(isTaskScheduleInWindow(
      createDefaultDateRangeTaskSchedule('2026-10-26', '2026-11-02'),
      window,
    )).toBeTrue()
    expect(isTaskScheduleInWindow(
      createDefaultDateRangeTaskSchedule('2026-10-01', '2026-10-30'),
      window,
    )).toBeFalse()
    expect(isTaskScheduleInWindow(createDefaultUnscheduledTaskSchedule(), window)).toBeFalse()
  })

  test('shows every date of the selected calendar month and only the cards placed on them', () => {
    const base = taskViewStoryTasks[0]!
    const tasks = [
      { ...base, id: 'in-month', dueDate: '2026-11-15', schedule: createDefaultDueDateTaskSchedule('2026-11-15') },
      { ...base, id: 'next-month', dueDate: '2026-12-01', schedule: createDefaultDueDateTaskSchedule('2026-12-01') },
      { ...base, id: 'no-date', dueDate: '', schedule: createDefaultUnscheduledTaskSchedule() },
    ]
    const html = renderToStaticMarkup(
      <TaskCalendarView
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        month="2026-11"
        onMonthChange={() => undefined}
        t={t}
        tasks={tasks}
      />,
    )

    expect(html).toContain('data-testid="task-calendar-month-navigation"')
    expect(html).toContain('2026-11-01 – 2026-11-30')
    expect(html.match(/data-testid="task-calendar-day-/gu)).toHaveLength(30)
    expect(html).toContain('data-testid="task-calendar-item-in-month"')
    expect(html).toContain('data-testid="task-calendar-item-no-date"')
    expect(html).not.toContain('data-testid="task-calendar-item-next-month"')
    expect(html).toContain(t('tasks.count').replace('{count}', '2'))
  })

  test('spans the Gantt timeline over the selected period and clips bars that cross it', () => {
    const base = taskViewStoryTasks[0]!
    const tasks = [{
      ...base,
      id: 'across',
      dueDate: '2027-02-10',
      schedule: createDefaultDateRangeTaskSchedule('2026-10-20', '2027-02-10'),
    }]
    const html = renderToStaticMarkup(
      <TaskGanttView
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        onWindowStartMonthChange={() => undefined}
        t={t}
        tasks={tasks}
        windowStartMonth="2026-11"
      />,
    )

    expect(html).toContain('data-testid="task-gantt-period-navigation"')
    expect(html).toContain('2026-11-01 – 2027-01-31')
    expect(html.match(/role="columnheader"/gu)?.length).toBe(92 + 1)
    expect(html).not.toContain('aria-label="2026-10-31"')
    expect(html).not.toContain('aria-label="2027-02-01"')
    expect(html).toContain('data-testid="task-gantt-bar-across"')
  })
})
