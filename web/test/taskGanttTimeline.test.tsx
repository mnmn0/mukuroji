import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createDefaultDateRangeTaskSchedule } from '../src/tasks/model/taskSchedule'
import {
  createTaskGanttScaledColumns,
  isTaskGanttScale,
  listTaskGanttNonWorkingSpans,
  resolveTaskGanttColumnWidth,
  resolveTaskGanttDateSpan,
  resolveTaskGanttProgressPointX,
} from '../src/tasks/model/taskGanttTimeline'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { taskViewStoryConfigurationsByTeam, taskViewStoryTasks } from '../src/tasks/ui/TaskView.stories.fixtures'

const t = createTranslator('ja')

describe('task Gantt timeline scales', () => {
  afterEach(() => {
    setSystemTime()
  })

  test('aligns week, month, and quarter columns to calendar units', () => {
    const range = { endDate: '2026-12-02', startDate: '2026-11-18' }

    expect(createTaskGanttScaledColumns(range, 'week').columns.map((column) => [
      column.startDate,
      column.endDate,
      column.label,
    ])).toEqual([
      ['2026-11-16', '2026-11-22', '11-16'],
      ['2026-11-23', '2026-11-29', '11-23'],
      ['2026-11-30', '2026-12-06', '11-30'],
    ])
    expect(createTaskGanttScaledColumns(range, 'month').columns).toEqual([
      { endDate: '2026-11-30', label: '2026-11', startDate: '2026-11-01' },
      { endDate: '2026-12-31', label: '2026-12', startDate: '2026-12-01' },
    ])
    expect(createTaskGanttScaledColumns({ endDate: '2027-02-10', startDate: '2026-12-15' }, 'quarter').columns)
      .toEqual([
        { endDate: '2026-12-31', label: '2026 Q4', startDate: '2026-10-01' },
        { endDate: '2027-03-31', label: '2027 Q1', startDate: '2027-01-01' },
      ])
    expect(createTaskGanttScaledColumns(range, 'day').columns).toHaveLength(15)
  })

  test('falls back to a coarser scale when a range needs too many columns', () => {
    const scaled = createTaskGanttScaledColumns({ endDate: '2030-12-31', startDate: '2026-01-01' }, 'day')

    expect(scaled.scale).toBe('week')
    expect(scaled.columns.length).toBeLessThanOrEqual(1_200)
  })

  test('places each date inside its column and widens month and quarter columns', () => {
    const axis = {
      columnWidth: resolveTaskGanttColumnWidth('month'),
      columns: createTaskGanttScaledColumns({ endDate: '2026-12-31', startDate: '2026-11-01' }, 'month').columns,
    }

    expect(resolveTaskGanttColumnWidth('day')).toBe(42)
    expect(resolveTaskGanttColumnWidth('quarter')).toBeGreaterThan(resolveTaskGanttColumnWidth('month'))
    expect(resolveTaskGanttDateSpan(axis, '2026-11-01')).toEqual({ left: 0, right: 56 / 30 })
    expect(resolveTaskGanttDateSpan(axis, '2026-12-01')?.left).toBe(56)
    expect(resolveTaskGanttDateSpan(axis, '2027-01-01')).toBeUndefined()
    expect(isTaskGanttScale('quarter')).toBeTrue()
    expect(isTaskGanttScale('year')).toBeFalse()
  })

  test('places progress points behind, ahead, or on today', () => {
    const axis = {
      columnWidth: 42,
      columns: createTaskGanttScaledColumns({ endDate: '2026-11-30', startDate: '2026-11-01' }, 'day').columns,
    }
    // 2026-11-11 through 2026-11-30 is 20 days; today 2026-11-20 is centered at 19.5 days.
    const base = { axis, endDate: '2026-11-30', startDate: '2026-11-11', today: '2026-11-20', todayX: 19.5 * 42 }

    expect(resolveTaskGanttProgressPointX({ ...base, progressPercent: 25 })).toBe(15 * 42)
    expect(resolveTaskGanttProgressPointX({ ...base, progressPercent: 75 })).toBe(25 * 42)
    expect(resolveTaskGanttProgressPointX({ ...base })).toBe(base.todayX)
    expect(resolveTaskGanttProgressPointX({ axis, today: base.today, todayX: base.todayX, progressPercent: 40 }))
      .toBe(base.todayX)
    expect(resolveTaskGanttProgressPointX({ ...base, endDate: '2026-11-15', progressPercent: 100 })).toBe(base.todayX)
    expect(resolveTaskGanttProgressPointX({ ...base, progressPercent: 0, startDate: '2026-11-25' })).toBe(base.todayX)
    expect(resolveTaskGanttProgressPointX({ ...base, progressPercent: 0 })).toBe(10 * 42)
    // A range clipped by the timeline keeps its progress position, and points outside stay at the edge.
    expect(resolveTaskGanttProgressPointX({ ...base, endDate: '2026-11-20', progressPercent: 50, startDate: '2026-10-22' }))
      .toBe(5 * 42)
    expect(resolveTaskGanttProgressPointX({ ...base, endDate: '2026-11-20', progressPercent: 10, startDate: '2026-10-22' }))
      .toBe(0)
  })

  test('renders the display controls, today line, and today column', () => {
    setSystemTime(new Date('2026-11-20T03:00:00.000Z'))
    const tasks = [{
      ...taskViewStoryTasks[0],
      schedule: createDefaultDateRangeTaskSchedule('2026-11-10', '2026-11-30'),
    }]

    const html = renderToStaticMarkup(
      <TaskGanttView configurationsByTeam={taskViewStoryConfigurationsByTeam} t={t} tasks={tasks} />,
    )

    expect(html).toContain('data-testid="task-gantt-scale"')
    expect(html).toContain('>表示倍率<')
    expect(html).toContain('>四半期</option>')
    expect(html).toContain('aria-pressed="false" class')
    expect(html).toContain('data-testid="task-gantt-today-line"')
    expect(html).toMatch(/aria-current="date" aria-label="2026-11-20"/)
    expect(html).toContain('data-print-root="task-gantt"')
    expect(html).not.toContain('data-testid="task-gantt-progress-line"')
  })

  test('omits the today line when today is outside the timeline', () => {
    setSystemTime(new Date('2027-03-20T03:00:00.000Z'))
    const tasks = [{
      ...taskViewStoryTasks[0],
      schedule: createDefaultDateRangeTaskSchedule('2026-11-10', '2026-11-30'),
    }]

    const html = renderToStaticMarkup(
      <TaskGanttView configurationsByTeam={taskViewStoryConfigurationsByTeam} t={t} tasks={tasks} />,
    )

    expect(html).not.toContain('data-testid="task-gantt-today-line"')
    expect(html).toMatch(/data-testid="task-gantt-today"[^>]*disabled=""/)
  })

  test('shades only single-day columns that fall on non-working days', () => {
    const axis = {
      columnWidth: 20,
      columns: [
        { endDate: '2026-11-20', label: '20', startDate: '2026-11-20' },
        { endDate: '2026-11-21', label: '21', startDate: '2026-11-21' },
        { endDate: '2026-11-29', label: '11-23', startDate: '2026-11-23' },
      ],
    }
    // The week column also contains Sunday but is not shaded, since it mixes working days.
    expect(listTaskGanttNonWorkingSpans(axis, (date) => date !== '2026-11-21' && date !== '2026-11-29'))
      .toEqual([{ date: '2026-11-21', left: 20, right: 40 }])
  })

  test('shades Workspace holidays and non-working weekdays in the day scale', () => {
    setSystemTime(new Date('2026-11-20T03:00:00.000Z'))
    const tasks = [{
      ...taskViewStoryTasks[0],
      schedule: createDefaultDateRangeTaskSchedule('2026-11-16', '2026-11-27'),
    }]
    const workingCalendar = {
      holidays: ['2026-11-23'],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const,
    }

    const html = renderToStaticMarkup(
      <TaskGanttView
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        t={t}
        tasks={tasks}
        workingCalendar={{ ...workingCalendar, workingWeekdays: [...workingCalendar.workingWeekdays] }}
      />,
    )

    const shadedHeaders = [...html.matchAll(/aria-label="(\d{4}-\d{2}-\d{2})"[^>]*data-non-working=""/g)]
      .map((match) => match[1])
    // Sundays and the 11/23 holiday are shaded; the working Saturday 11/21 is not.
    expect(shadedHeaders).toContain('2026-11-22')
    expect(shadedHeaders).toContain('2026-11-23')
    expect(shadedHeaders).not.toContain('2026-11-21')
    expect(shadedHeaders).not.toContain('2026-11-24')
    expect(html.match(/data-testid="task-gantt-non-working-day"/g)?.length).toBe(shadedHeaders.length)

    const unshaded = renderToStaticMarkup(
      <TaskGanttView configurationsByTeam={taskViewStoryConfigurationsByTeam} t={t} tasks={tasks} />,
    )
    expect(unshaded).not.toContain('data-testid="task-gantt-non-working-day"')
  })
})
