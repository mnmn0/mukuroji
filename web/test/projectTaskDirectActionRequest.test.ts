import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
  type WorkItemActionTarget,
  type WorkItemScheduleChangePreview,
} from '@mukuroji/contracts'
import {
  beginProjectTaskDirectSchedulePreview,
  cancelAwaitingProjectTaskDirectSchedule,
  claimProjectTaskDirectActionTarget,
  classifyProjectTaskDirectPatch,
  clearProjectTaskDirectActionRequest,
  completeProjectTaskDirectScheduleMutation,
  consumeProjectTaskDirectActionRequest,
  createProjectTaskDirectPatchRequest,
  createProjectTaskDirectScheduleHandle,
  createProjectTaskDirectScheduleRequest,
  failProjectTaskDirectSchedule,
  isProjectTaskDirectScheduleCancelled,
  isSupportedProjectTaskDirectPatch,
  publishProjectTaskDirectSchedulePreview,
  readProjectTaskDirectSchedulePhase,
  releaseProjectTaskDirectActionTarget,
  waitForProjectTaskDirectScheduleDecision,
  waitForProjectTaskDirectSchedulePreview,
  type ProjectTaskDirectActionInFlight,
  type ProjectTaskDirectActionRequestSlot,
} from '../src/task-views/model/projectTaskDirectActionRequest'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import {
  createDefaultDueDateTaskSchedule,
  createMoveTaskScheduleOperation,
} from '../src/tasks/model/taskSchedule'

/** Creates one revision-bound Project action target for direct request tests. */
function createTarget(
  workItemId = 'wireframe',
  expectedRevision = 4,
): WorkItemActionTarget {
  return { expectedRevision, teamId: 'core-team', workItemId }
}

/** Creates one exact canonical context accepted by a direct Project action. */
function createContext(
  actionId: 'assign' | 'edit' | 'move' | 'schedule',
  target = createTarget(),
): WorkItemActionContext {
  return {
    actionId,
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    scope: { kind: 'project', projectId: 'refero' },
    selection: { focusedTarget: target, mode: 'single', targets: [target] },
    surface: 'project',
    trigger: 'click',
  }
}

/** Creates a complete authoritative schedule preview for one fixture task. */
function createPreview(): WorkItemScheduleChangePreview {
  const before = createDefaultDueDateTaskSchedule('2026-06-03')
  const after = createDefaultDueDateTaskSchedule('2026-06-05')
  return {
    affectedMilestoneIds: [],
    affectedProjectIds: ['refero'],
    affectedProjects: [{ projectId: 'refero', teamId: 'core-team' }],
    conflicts: [],
    evaluatedRevisions: [createTarget()],
    expectedRevision: 4,
    impacts: [{
      after,
      before,
      dateDeltaDays: 2,
      expectedRevision: 4,
      kind: 'direct',
      teamId: 'core-team',
      workItemId: 'wireframe',
    }],
    planningRevision: 3,
    relationGraphRevision: 2,
    requiresConfirmation: true,
    warnings: [],
  }
}

describe('Project direct action request', () => {
  test('classifies atomic patch families without splitting compound edits', () => {
    expect(classifyProjectTaskDirectPatch({ title: 'Next' })).toBe('edit')
    expect(classifyProjectTaskDirectPatch({ assigneeUserId: 'member-a' })).toBe('assign')
    expect(classifyProjectTaskDirectPatch({ workflowStatusId: 'done' })).toBe('move')
    expect(classifyProjectTaskDirectPatch({
      assignedProjectId: 'other',
      workflowStatusId: 'todo',
    })).toBe('move')
    expect(classifyProjectTaskDirectPatch({
      assigneeUserId: 'member-a',
      workflowStatusId: 'done',
    })).toBe('edit')
    expect(classifyProjectTaskDirectPatch({
      schedule: createDefaultDueDateTaskSchedule('2026-06-05'),
    })).toBe('schedule')

    const unsupported = createProjectTaskDirectPatchRequest('refero', createTarget(), {
      schedule: createDefaultDueDateTaskSchedule('2026-06-05'),
      title: 'Next',
    })
    expect(unsupported.actionId).toBe('edit')
    expect(isSupportedProjectTaskDirectPatch(unsupported)).toBe(false)
  })

  test('snapshots and consumes only the exact project, action, target, and revision once', () => {
    const target = createTarget()
    const request = createProjectTaskDirectPatchRequest('refero', target, {
      workflowStatusId: 'done',
    })
    const slot: ProjectTaskDirectActionRequestSlot = { current: request }
    target.expectedRevision = 99

    expect(request.target.expectedRevision).toBe(4)
    expect(consumeProjectTaskDirectActionRequest(slot, createContext('move'))).toBe(request)
    expect(slot.current).toBeUndefined()
    expect(consumeProjectTaskDirectActionRequest(slot, createContext('move'))).toBeUndefined()
  })

  test('consumes a mismatched revision as stale and exact cleanup preserves a newer request', () => {
    const first = createProjectTaskDirectPatchRequest('refero', createTarget(), {
      title: 'First',
    })
    const second = createProjectTaskDirectPatchRequest('refero', createTarget(), {
      title: 'Second',
    })
    const slot: ProjectTaskDirectActionRequestSlot = { current: first }

    expect(consumeProjectTaskDirectActionRequest(
      slot,
      createContext('edit', createTarget('wireframe', 5)),
    )).toBeUndefined()
    expect(slot.current).toBeUndefined()
    slot.current = second
    expect(clearProjectTaskDirectActionRequest(slot, first)).toBe(false)
    expect(clearProjectTaskDirectActionRequest(slot, second)).toBe(true)
  })

  test('fails closed for the same target while allowing different targets concurrently', () => {
    const first = createProjectTaskDirectPatchRequest('refero', createTarget(), { title: 'First' })
    const sameTarget = createProjectTaskDirectPatchRequest('refero', createTarget(), {
      title: 'Second',
    })
    const otherTarget = createProjectTaskDirectPatchRequest(
      'refero',
      createTarget('brand-guideline'),
      { title: 'Other' },
    )
    const inFlight: ProjectTaskDirectActionInFlight = new Map()

    expect(claimProjectTaskDirectActionTarget(inFlight, first)).toBe(true)
    expect(claimProjectTaskDirectActionTarget(inFlight, sameTarget)).toBe(false)
    expect(claimProjectTaskDirectActionTarget(inFlight, otherTarget)).toBe(true)
    expect(releaseProjectTaskDirectActionTarget(inFlight, sameTarget)).toBe(false)
    expect(releaseProjectTaskDirectActionTarget(inFlight, first)).toBe(true)
    expect(claimProjectTaskDirectActionTarget(inFlight, sameTarget)).toBe(true)
  })
})

describe('Project direct Schedule lifecycle', () => {
  test('keeps permission denial and preview failure from publishing a modal controller', async () => {
    const denied = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-05'),
    )
    const deniedPreview = waitForProjectTaskDirectSchedulePreview(denied)
    const deniedError = new Error('Permission denied.')
    expect(failProjectTaskDirectSchedule(denied, deniedError)).toBe(true)
    await expect(deniedPreview).rejects.toBe(deniedError)

    const failed = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-06'),
    )
    expect(beginProjectTaskDirectSchedulePreview(failed)).toBe(true)
    const failedPreview = waitForProjectTaskDirectSchedulePreview(failed)
    const previewError = new Error('Preview failed.')
    expect(failProjectTaskDirectSchedule(failed, previewError)).toBe(true)
    await expect(failedPreview).rejects.toBe(previewError)
    expect(readProjectTaskDirectSchedulePhase(failed)).toBe('failed')
  })

  test('binds old and new dialog controllers to distinct invocation tokens', async () => {
    const first = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-05'),
    )
    const second = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget('brand-guideline'),
      createMoveTaskScheduleOperation('2026-06-06'),
    )
    expect(beginProjectTaskDirectSchedulePreview(first)).toBe(true)
    expect(beginProjectTaskDirectSchedulePreview(second)).toBe(true)
    const firstController = publishProjectTaskDirectSchedulePreview(first, createPreview())
    const secondController = publishProjectTaskDirectSchedulePreview(second, createPreview())
    if (!firstController || !secondController) throw new Error('Expected preview controllers.')

    expect(firstController.token).toBe(first)
    expect(secondController.token).toBe(second)
    expect(firstController.cancel()).toBe(true)
    expect(readProjectTaskDirectSchedulePhase(first)).toBe('cancelled')
    expect(readProjectTaskDirectSchedulePhase(second)).toBe('awaiting-confirmation')
    expect(await waitForProjectTaskDirectScheduleDecision(first)).toBe('cancelled')
  })

  test('cancels only awaiting work during unmount and waits for in-flight mutation terminal result', async () => {
    const previewing = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-04'),
    )
    const previewingHandle = createProjectTaskDirectScheduleHandle(previewing)
    const previewingInFlight: ProjectTaskDirectActionInFlight = new Map()
    expect(claimProjectTaskDirectActionTarget(previewingInFlight, previewing)).toBe(true)
    expect(beginProjectTaskDirectSchedulePreview(previewing)).toBe(true)
    expect(previewingHandle.cancel()).toBe(true)
    expect(releaseProjectTaskDirectActionTarget(previewingInFlight, previewing)).toBe(true)
    const replacement = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-05'),
    )
    expect(claimProjectTaskDirectActionTarget(previewingInFlight, replacement)).toBe(true)
    expect(publishProjectTaskDirectSchedulePreview(previewing, createPreview())).toBeUndefined()
    expect(failProjectTaskDirectSchedule(previewing, new Error('Late preview failure.'))).toBe(false)
    expect(readProjectTaskDirectSchedulePhase(previewing)).toBe('cancelled')
    const previewingError = await previewingHandle.preview.catch((error: unknown) => error)
    expect(isProjectTaskDirectScheduleCancelled(previewingError)).toBe(true)

    const awaiting = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-05'),
    )
    expect(beginProjectTaskDirectSchedulePreview(awaiting)).toBe(true)
    expect(publishProjectTaskDirectSchedulePreview(awaiting, createPreview())).toBeDefined()
    expect(cancelAwaitingProjectTaskDirectSchedule(awaiting)).toBe(true)
    expect(readProjectTaskDirectSchedulePhase(awaiting)).toBe('cancelled')

    const inFlight = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-06'),
    )
    expect(beginProjectTaskDirectSchedulePreview(inFlight)).toBe(true)
    const controller = publishProjectTaskDirectSchedulePreview(inFlight, createPreview())
    if (!controller) throw new Error('Expected a preview controller.')
    const confirmedTaskPromise = controller.confirm()
    expect(await waitForProjectTaskDirectScheduleDecision(inFlight)).toBe('confirmed')
    expect(cancelAwaitingProjectTaskDirectSchedule(inFlight)).toBe(false)
    expect(readProjectTaskDirectSchedulePhase(inFlight)).toBe('mutation-in-flight')

    const fixture = referoTaskFixtures[0]
    if (!fixture) throw new Error('Expected a Project task fixture.')
    const updatedTask = { ...fixture, revision: 5 }
    expect(completeProjectTaskDirectScheduleMutation(inFlight, updatedTask)).toBe(true)
    expect(await confirmedTaskPromise).toEqual(updatedTask)
    expect(readProjectTaskDirectSchedulePhase(inFlight)).toBe('completed')
  })

  test('rejects the exact confirm controller when persistence fails', async () => {
    const request = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-05'),
    )
    expect(beginProjectTaskDirectSchedulePreview(request)).toBe(true)
    const controller = publishProjectTaskDirectSchedulePreview(request, createPreview())
    if (!controller) throw new Error('Expected a preview controller.')
    const mutation = controller.confirm()
    const failure = new Error('Mutation failed.')
    expect(failProjectTaskDirectSchedule(request, failure)).toBe(true)
    await expect(mutation).rejects.toBe(failure)
  })

  test('marks pre-confirm cancellation with a distinguishable expected error', async () => {
    const request = createProjectTaskDirectScheduleRequest(
      'refero',
      createTarget(),
      createMoveTaskScheduleOperation('2026-06-05'),
    )
    const preview = waitForProjectTaskDirectSchedulePreview(request)
    expect(cancelAwaitingProjectTaskDirectSchedule(request)).toBe(true)
    const error = await preview.catch((caught: unknown) => caught)
    expect(isProjectTaskDirectScheduleCancelled(error)).toBe(true)
  })
})
