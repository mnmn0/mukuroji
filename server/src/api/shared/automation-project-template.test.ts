import { expect, test } from 'bun:test'
import { expandProjectTemplateWorkItems } from './automation-project-template'

test('places template Work Items on working days from the Project start, parents first', () => {
  // 2026-12-05 is a Saturday, so offset 0 starts on Monday 2026-12-07.
  const expanded = expandProjectTemplateWorkItems([
    {
      title: '要件定義',
      startOffsetWorkingDays: 0,
      durationWorkingDays: 5,
      children: [
        { title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 },
        { title: 'レビュー', startOffsetWorkingDays: 2, durationWorkingDays: 3 },
      ],
    },
    { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 1 },
  ], '2026-12-05')

  expect(expanded.map((item) => ({
    index: item.index,
    parentIndex: item.parentIndex,
    title: item.title,
    startDate: item.schedule.startDate,
    endDate: item.schedule.endDate,
    durationDays: item.schedule.durationDays,
  }))).toEqual([
    { index: 0, parentIndex: undefined, title: '要件定義', startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 5 },
    { index: 1, parentIndex: 0, title: 'ヒアリング', startDate: '2026-12-07', endDate: '2026-12-08', durationDays: 2 },
    { index: 2, parentIndex: 0, title: 'レビュー', startDate: '2026-12-09', endDate: '2026-12-11', durationDays: 3 },
    { index: 3, parentIndex: undefined, title: '設計', startDate: '2026-12-14', endDate: '2026-12-14', durationDays: 1 },
  ])
  expect(expanded[0]?.schedule).toMatchObject({
    mode: 'date-range',
    calendarPolicy: { workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], holidays: [] },
  })
})
