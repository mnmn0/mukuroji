import { describe, expect, test } from 'bun:test'
import {
  applyTaskGanttDisplaySettings,
  createTaskGanttDisplayBinding,
  readTaskGanttDisplaySettings,
} from '../src/tasks/model/taskGanttDisplay'
import {
  createBuiltInTaskViewDefinition,
  presentationSettingsToTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
} from '../src/task-views/model/taskViewSurfaceState'
import type { TaskViewPresentationSettings } from '../src/task-views/model/taskViewPresentation'

describe('Gantt display settings in a task view', () => {
  const definition = createBuiltInTaskViewDefinition(
    'team',
    { kind: 'team', teamId: 'team-1' },
    'gantt',
  )

  test('defaults to the automatic scale without one-line rows or the progress line', () => {
    expect(readTaskGanttDisplaySettings(
      taskViewDefinitionToPresentationSettings(definition).display,
    )).toEqual({ isCompact: false, scale: 'auto', showsProgressLine: false })
  })

  test('round-trips through the saved definition so a saved view restores the chart', () => {
    const presentation = taskViewDefinitionToPresentationSettings(definition)
    const next = presentationSettingsToTaskViewDefinition(
      definition,
      applyTaskGanttDisplaySettings(presentation, {
        isCompact: true,
        scale: 'month',
        showsProgressLine: true,
      }),
    )

    expect(next.layout.displayOptions).toMatchObject({
      ganttCompactRows: true,
      ganttProgressLine: true,
      ganttScale: 'month',
    })
    expect(readTaskGanttDisplaySettings(
      taskViewDefinitionToPresentationSettings(next).display,
    )).toEqual({ isCompact: true, scale: 'month', showsProgressLine: true })
  })

  test('binds the chart only when the page can change the task view', () => {
    const presentation = taskViewDefinitionToPresentationSettings(definition)
    expect(createTaskGanttDisplayBinding(presentation, undefined)).toEqual({})
    expect(createTaskGanttDisplayBinding(undefined, () => {})).toEqual({})

    const changes: TaskViewPresentationSettings[] = []
    const binding = createTaskGanttDisplayBinding(presentation, (settings) => {
      changes.push(settings)
    })
    expect(binding.display).toEqual({ isCompact: false, scale: 'auto', showsProgressLine: false })
    binding.onDisplayChange?.({ isCompact: false, scale: 'week', showsProgressLine: false })
    expect(changes.map((settings) => settings.display.ganttScale)).toEqual(['week'])
  })
})
