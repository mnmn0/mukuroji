import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanonicalWorkItem, WorkItemScheduleChangePreview } from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'
import { isProjectTaskDirectScheduleCancelled } from '../src/task-views/model/projectTaskDirectActionRequest'
import {
  createBuiltInTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
} from '../src/task-views/model/taskViewSurfaceState'
import { startWorkItemListScheduleChange } from '../src/task-views/model/workItemListScheduleChange'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import {
  createDefaultDueDateTaskSchedule,
  createMoveTaskScheduleOperation,
} from '../src/tasks/model/taskSchedule'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { MyTasksWorkspaceView } from '../src/workspace/ui/MyTasksWorkspaceView'

const [fixture] = referoTaskFixtures
if (!fixture) throw new Error('Expected a task fixture.')
const task: CanonicalWorkItem = {
  ...fixture,
  dueDate: '2026-06-03',
  schedule: createDefaultDueDateTaskSchedule('2026-06-03'),
}

/**
 * Builds a preview that moves the fixture's due date by two days.
 *
 * @returns The preview.
 */
function createPreview(): WorkItemScheduleChangePreview {
  return {
    affectedMilestoneIds: [],
    affectedProjects: [],
    conflicts: [],
    evaluatedRevisions: [{ expectedRevision: task.revision, teamId: task.teamId, workItemId: task.id }],
    expectedRevision: task.revision,
    impacts: [{
      after: createDefaultDueDateTaskSchedule('2026-06-05'),
      before: task.schedule,
      dateDeltaDays: 2,
      expectedRevision: task.revision,
      kind: 'direct',
      teamId: task.teamId,
      workItemId: task.id,
    }],
    planningRevision: 3,
    relationGraphRevision: 2,
    requiresConfirmation: true,
    warnings: [],
  }
}

describe('Work Item list schedule change', () => {
  test('persists only after the view confirms the preview', async () => {
    const confirmed: CanonicalWorkItem[] = []
    const handle = startWorkItemListScheduleChange(
      'core-team',
      task,
      createMoveTaskScheduleOperation('2026-06-05'),
      {
        confirm: async (target) => {
          const next = { ...target, revision: target.revision + 1 }
          confirmed.push(next)
          return next
        },
        preview: async () => createPreview(),
      },
      true,
      'unavailable',
    )

    const controller = await handle.preview
    expect(controller.preview.impacts[0]?.workItemId).toBe(task.id)
    expect(confirmed).toHaveLength(0)
    const result = await controller.confirm()
    expect(result.revision).toBe(task.revision + 1)
    expect(confirmed).toHaveLength(1)
  })

  test('does not persist a cancelled preview', async () => {
    let confirmCalls = 0
    const handle = startWorkItemListScheduleChange(
      'my-tasks',
      task,
      createMoveTaskScheduleOperation('2026-06-05'),
      {
        confirm: async (target) => {
          confirmCalls += 1
          return target
        },
        preview: async () => createPreview(),
      },
      true,
      'unavailable',
    )

    const controller = await handle.preview
    expect(controller.cancel()).toBe(true)
    const error = await controller.confirm().catch((reason: unknown) => reason)
    expect(isProjectTaskDirectScheduleCancelled(error)).toBe(true)
    expect(confirmCalls).toBe(0)
  })

  test('refuses a Work Item the person cannot change without requesting a preview', async () => {
    let previewCalls = 0
    const handle = startWorkItemListScheduleChange(
      'core-team',
      task,
      createMoveTaskScheduleOperation('2026-06-05'),
      {
        confirm: async (target) => target,
        preview: async () => {
          previewCalls += 1
          return createPreview()
        },
      },
      false,
      'unavailable',
    )

    await expect(handle.preview).rejects.toThrow('unavailable')
    expect(previewCalls).toBe(0)
  })

  test('reports a failed preview to the view', async () => {
    const failure = new Error('preview failed')
    const handle = startWorkItemListScheduleChange(
      'core-team',
      task,
      createMoveTaskScheduleOperation('2026-06-05'),
      {
        confirm: async (target) => target,
        preview: async () => {
          throw failure
        },
      },
      true,
      'unavailable',
    )

    await expect(handle.preview).rejects.toBe(failure)
  })
})

describe('My Tasks table editing', () => {
  const t = createTranslator('ja')
  const presentation = taskViewDefinitionToPresentationSettings(
    createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'table'),
  )
  const configurationsByTeam = { 'core-team': { configuration: teamWorkItemConfigurationFixture } }

  /**
   * Renders the My Tasks table with the given edit permission.
   *
   * @param canEdit - Whether rows are writable.
   * @returns Static markup of the table.
   */
  const render = (canEdit: boolean) => renderToStaticMarkup(
    <MyTasksWorkspaceView
      canEditTask={() => canEdit}
      configurationFailedTeamIds={[]}
      configurationsByTeam={configurationsByTeam}
      onRequestScheduleChange={(target, operation) => startWorkItemListScheduleChange(
        'my-tasks',
        target,
        operation,
        { confirm: async (item) => item, preview: async () => createPreview() },
        true,
        'unavailable',
      )}
      onUpdatePriority={async () => undefined}
      presentation={presentation}
      t={t}
      tasks={[task]}
      teams={projectDirectoryFixtures}
      viewMode="table"
    />,
  )

  test('offers the due date and priority editors on writable rows', () => {
    const html = render(true)
    expect(html).toContain(`data-testid="my-tasks-table-due-edit-refero-${task.id}"`)
    expect(html).toContain(`data-testid="my-tasks-table-priority-edit-refero-${task.id}"`)
  })

  test('keeps read-only rows as plain text', () => {
    const html = render(false)
    expect(html).not.toContain('my-tasks-table-due-edit-')
    expect(html).not.toContain('my-tasks-table-priority-edit-')
    expect(html).toContain('2026-06-03')
  })
})
