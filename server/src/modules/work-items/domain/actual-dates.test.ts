import { describe, expect, test } from 'bun:test'
import {
  WorkItemActualDateError,
  applyWorkItemStatusTransitionToActualDates,
  correctWorkItemActualDates,
} from './actual-dates'

describe('applyWorkItemStatusTransitionToActualDates', () => {
  test('records the start on the first entry into started', () => {
    expect(applyWorkItemStatusTransitionToActualDates({}, 'unstarted', 'started', '2026-11-02'))
      .toEqual({ actualStartDate: '2026-11-02' })
    expect(applyWorkItemStatusTransitionToActualDates(
      { actualStartDate: '2026-11-02' },
      'unstarted',
      'started',
      '2026-11-09',
    )).toEqual({ actualStartDate: '2026-11-02' })
  })

  test('records both dates when work completes without a started status', () => {
    expect(applyWorkItemStatusTransitionToActualDates({}, 'backlog', 'completed', '2026-11-05'))
      .toEqual({ actualStartDate: '2026-11-05', actualEndDate: '2026-11-05' })
    expect(applyWorkItemStatusTransitionToActualDates({}, undefined, 'completed', '2026-11-05'))
      .toEqual({ actualStartDate: '2026-11-05', actualEndDate: '2026-11-05' })
  })

  test('removes the end on reopen and records the latest completion again', () => {
    const completed = { actualStartDate: '2026-11-02', actualEndDate: '2026-11-05' }
    const reopened = applyWorkItemStatusTransitionToActualDates(completed, 'completed', 'started', '2026-11-06')
    expect(reopened).toEqual({ actualStartDate: '2026-11-02' })
    expect(applyWorkItemStatusTransitionToActualDates(reopened, 'started', 'completed', '2026-11-10'))
      .toEqual({ actualStartDate: '2026-11-02', actualEndDate: '2026-11-10' })
    expect(applyWorkItemStatusTransitionToActualDates(completed, 'completed', 'canceled', '2026-11-06'))
      .toEqual({ actualStartDate: '2026-11-02' })
  })

  test('keeps rows without actual dates unchanged while the category stays the same', () => {
    expect(applyWorkItemStatusTransitionToActualDates({}, 'completed', 'completed', '2026-11-05'))
      .toEqual({})
    expect(applyWorkItemStatusTransitionToActualDates({}, 'started', 'started', '2026-11-05'))
      .toEqual({})
  })

  test('does not record dates for backlog, unstarted, or canceled entries', () => {
    expect(applyWorkItemStatusTransitionToActualDates({}, undefined, 'backlog', '2026-11-05')).toEqual({})
    expect(applyWorkItemStatusTransitionToActualDates({}, 'backlog', 'canceled', '2026-11-05')).toEqual({})
  })

  test('moves a corrected start back to the completion date', () => {
    expect(applyWorkItemStatusTransitionToActualDates(
      { actualStartDate: '2026-11-08' },
      'started',
      'completed',
      '2026-11-06',
    )).toEqual({ actualStartDate: '2026-11-06', actualEndDate: '2026-11-06' })
  })
})

describe('correctWorkItemActualDates', () => {
  const completed = { actualStartDate: '2026-11-02', actualEndDate: '2026-11-05' }

  test('replaces and removes individual dates', () => {
    expect(correctWorkItemActualDates(completed, { actualStartDate: '2026-11-01' }, 'completed', '2026-11-16'))
      .toEqual({ actualStartDate: '2026-11-01', actualEndDate: '2026-11-05' })
    expect(correctWorkItemActualDates({ actualStartDate: '2026-11-02' }, { actualStartDate: null }, 'started', '2026-11-16'))
      .toEqual({})
  })

  test('rejects invalid, out-of-range, future, and inconsistent dates', () => {
    const invalid = [
      [{ actualStartDate: '2026-11-31' }, 'completed'],
      // Before the supported canonical date range, which the Gantt timeline cannot render.
      [{ actualStartDate: '0026-11-02' }, 'completed'],
      [{ actualStartDate: '2026-11-17' }, 'completed'],
      [{ actualEndDate: '2026-11-03' }, 'started'],
      [{ actualStartDate: null }, 'completed'],
      [{ actualStartDate: '2026-11-06' }, 'completed'],
    ] as const
    for (const [correction, category] of invalid) {
      expect(() => correctWorkItemActualDates(completed, correction, category, '2026-11-16'))
        .toThrow(WorkItemActualDateError)
    }
  })
})
