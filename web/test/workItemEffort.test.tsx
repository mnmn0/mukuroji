import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { isCanonicalWorkItem } from '../src/work-items/api/contractValidation'
import {
  isWorkItemEffortColumnField,
  resolveRecordedRemainingEffortMinutes,
  resolveWorkItemDraftRevision,
  resolveWorkItemEffortColumnValue,
  toWorkItemEffortPatch,
} from '../src/work-items/model/workItemEffort'
import { WorkItemEffortCell } from '../src/work-items/ui/WorkItemEffortCells'
import { WorkItemEffortProgressEditor } from '../src/work-items/ui/WorkItemEffortProgressEditor'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { createTaskInversePatch } from '../src/tasks/model/taskView'
import { TaskGanttView } from '../src/tasks/ui/TaskGanttView'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createDefaultDateRangeTaskSchedule } from '../src/tasks/model/taskSchedule'
import { taskViewStoryConfigurationsByTeam, taskViewStoryTasks } from '../src/tasks/ui/TaskView.stories.fixtures'

const [baseWorkItem] = teamIssueFixtures
if (!baseWorkItem) throw new Error('Team Work Item fixtures must not be empty.')

/** A started Work Item with an 8 hour estimate and 2 hours remaining. */
const estimated: CanonicalWorkItem = {
  ...baseWorkItem,
  statusCategory: 'started',
  schedule: { ...baseWorkItem.schedule, plannedEffortMinutes: 480 },
  remainingEffortMinutes: 120,
  progressPercent: 30,
}

describe('Work Item effort and progress', () => {
  test('reads recorded remaining effort as zero for finished Work Items in the time panel', () => {
    expect(resolveRecordedRemainingEffortMinutes(estimated)).toBe(120)
    expect(resolveRecordedRemainingEffortMinutes({ ...estimated, statusCategory: 'completed' })).toBe(0)
    expect(resolveRecordedRemainingEffortMinutes({ ...estimated, statusCategory: 'canceled' })).toBe(0)
    // Without a recorded value an open Work Item stays unknown, so the panel falls back to the estimate.
    expect(resolveRecordedRemainingEffortMinutes({ statusCategory: 'started' })).toBeUndefined()
  })

  test('keeps unsaved Project and Work Item Type choices after an effort-only save', () => {
    /** Picks the fields the other detail forms edit. */
    const draftFields = (item: CanonicalWorkItem) => [item.title, item.assignedProjectId, item.workItemTypeId]
    const base = { item: estimated, revision: estimated.revision }
    const effortSaved = { ...estimated, revision: estimated.revision + 1, remainingEffortMinutes: 60, progressPercent: 50 }
    const titleSaved = { ...estimated, revision: estimated.revision + 1, title: `${estimated.title} (renamed)` }

    // A choice stamped with the draft revision stays selected while only effort changed.
    expect(resolveWorkItemDraftRevision(base, estimated, draftFields)).toBe(estimated.revision)
    expect(resolveWorkItemDraftRevision(base, effortSaved, draftFields)).toBe(estimated.revision)
    expect(resolveWorkItemDraftRevision(base, titleSaved, draftFields)).toBe(titleSaved.revision)
    expect(resolveWorkItemDraftRevision(base, { ...effortSaved, id: 'other' }, draftFields)).toBe(effortSaved.revision)
  })

  test('accepts canonical Work Items with remaining effort and progress and rejects malformed values', () => {
    expect(isCanonicalWorkItem(estimated)).toBe(true)
    expect(isCanonicalWorkItem({ ...estimated, remainingEffortMinutes: -1 })).toBe(false)
    expect(isCanonicalWorkItem({ ...estimated, progressPercent: 101 })).toBe(false)
  })

  test('resolves effort columns from the canonical estimate and the Team progress mode', () => {
    expect(['estimate', 'remainingEffort', 'progress'].every(isWorkItemEffortColumnField)).toBe(true)
    expect(isWorkItemEffortColumnField('priority')).toBe(false)
    expect(resolveWorkItemEffortColumnValue(estimated, 'estimate')).toBe(480)
    expect(resolveWorkItemEffortColumnValue(estimated, 'remainingEffort')).toBe(120)
    expect(resolveWorkItemEffortColumnValue(estimated, 'progress')).toBe(50)
    expect(resolveWorkItemEffortColumnValue(estimated, 'progress', { progressMode: 'remaining-effort' })).toBe(75)
    expect(resolveWorkItemEffortColumnValue(estimated, 'progress', { progressMode: 'manual' })).toBe(30)
    expect(renderToStaticMarkup(
      <WorkItemEffortCell field="estimate" hoursLabel="{hours} h" item={estimated} />,
    )).toContain('8 h')
    expect(renderToStaticMarkup(
      <WorkItemEffortCell field="estimate" hoursLabel="{hours} h" item={{ ...estimated, schedule: baseWorkItem.schedule }} />,
    )).toContain('—')
  })

  test('shows the manual progress input only under the manual mode', () => {
    const render = (progressMode: 'status-category' | 'manual') => renderToStaticMarkup(
      <WorkItemEffortProgressEditor
        editorIdentity="core-team:item:1"
        item={estimated}
        locale="en"
        onSave={async () => undefined}
        progressMode={progressMode}
      />,
    )
    expect(render('status-category')).toContain('name="remainingEffortHours"')
    expect(render('status-category')).not.toContain('name="progressPercent"')
    expect(render('manual')).toContain('name="progressPercent"')
    expect(render('manual')).toContain('30%')
    expect(renderToStaticMarkup(
      <WorkItemEffortProgressEditor editorIdentity="x" item={estimated} locale="en" readOnly />,
    )).not.toContain('name="remainingEffortHours"')
    // While another update is pending the inputs stay mounted, disabled, so typed values survive a failure.
    const pendingHtml = renderToStaticMarkup(
      <WorkItemEffortProgressEditor disabled editorIdentity="x" item={estimated} locale="en" onSave={async () => undefined} />,
    )
    expect(pendingHtml).toMatch(/<input[^>]*disabled=""[^>]*name="remainingEffortHours"/)
    expect(pendingHtml).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/)
  })

  test('undoes remaining effort and progress back to their previous values', () => {
    expect(createTaskInversePatch(estimated, { remainingEffortMinutes: 60, progressPercent: 80 })).toEqual({
      remainingEffortMinutes: 120,
      progressPercent: 30,
    })
    // Values that were not recorded are cleared again.
    const unrecorded = { ...estimated, remainingEffortMinutes: undefined, progressPercent: undefined }
    expect(createTaskInversePatch(unrecorded, { remainingEffortMinutes: 60, progressPercent: 0 })).toEqual({
      remainingEffortMinutes: null,
      progressPercent: null,
    })
    expect(createTaskInversePatch(estimated, { title: 'Renamed' })).toEqual({ title: estimated.title })
  })

  test('names the Gantt bar with its progress, including 0%', () => {
    const base = taskViewStoryTasks[0]
    if (!base) throw new Error('Task view story fixtures must not be empty.')
    const render = (statusCategory: CanonicalWorkItem['statusCategory']) => renderToStaticMarkup(
      <TaskGanttView
        configurationsByTeam={taskViewStoryConfigurationsByTeam}
        onWindowStartMonthChange={() => undefined}
        t={createTranslator('en')}
        tasks={[{
          ...base,
          id: 'bar',
          statusCategory,
          dueDate: '2026-11-20',
          schedule: createDefaultDateRangeTaskSchedule('2026-11-10', '2026-11-20'),
        }]}
        windowStartMonth="2026-11"
      />,
    )
    expect(render('completed')).toMatch(/aria-label="[^"]*, Progress 100%"[^>]*data-testid="task-gantt-bar-bar"/)
    expect(render('backlog')).toMatch(/aria-label="[^"]*, Progress 0%"[^>]*data-testid="task-gantt-bar-bar"/)
  })

  test('writes an estimate change into the same schedule placement and passes other changes through', () => {
    expect(toWorkItemEffortPatch({ remainingEffortMinutes: 60 }, estimated.schedule)).toEqual({ remainingEffortMinutes: 60 })
    expect(toWorkItemEffortPatch({ plannedEffortMinutes: 600, progressPercent: null }, estimated.schedule)).toEqual({
      progressPercent: null,
      schedule: { ...estimated.schedule, plannedEffortMinutes: 600 },
    })
    expect(toWorkItemEffortPatch({ plannedEffortMinutes: null }, estimated.schedule).schedule).toEqual(baseWorkItem.schedule)
    const withEstimate = renderToStaticMarkup(
      <WorkItemEffortProgressEditor canEditEstimate editorIdentity="x" item={estimated} locale="en" onSave={async () => undefined} />,
    )
    expect(withEstimate).toContain('name="estimateHours"')
    expect(withEstimate).toContain('value="8"')
  })
})
