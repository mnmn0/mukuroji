import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { isCanonicalWorkItem } from '../src/work-items/api/contractValidation'
import {
  isWorkItemEffortColumnField,
  resolveWorkItemEffortColumnValue,
  toWorkItemEffortPatch,
} from '../src/work-items/model/workItemEffort'
import { WorkItemEffortCell } from '../src/work-items/ui/WorkItemEffortCells'
import { WorkItemEffortProgressEditor } from '../src/work-items/ui/WorkItemEffortProgressEditor'
import { teamIssueFixtures } from '../src/issues/fixtures'

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
