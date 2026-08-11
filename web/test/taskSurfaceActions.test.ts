import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type TaskViewScope,
  type TaskViewSurface,
  type WorkItemActionContext,
  type WorkItemActionSelection,
} from '@mukuroji/contracts'
import { executeTaskAction } from '../src/task-views/model/taskActionRegistry'
import {
  createTaskSurfaceActionBaseContext,
  createTaskSurfaceActionContext,
  createTaskSurfaceActionRegistry,
  resolveTaskSurfaceActionTarget,
  type TaskSurfaceActionHandler,
} from '../src/task-views/mutations/useTaskSurfaceActions'

const disabledReasons = {
  selectionRequired: 'Select one item.',
  singleSelectionRequired: 'Select only one item.',
  unavailable: 'Unavailable here.',
}

describe('task-surface action adapter', () => {
  test('preserves each task surface and scope in the canonical base context', () => {
    const selection: WorkItemActionSelection = { mode: 'none', targets: [] }
    const surfaces: readonly {
      surface: TaskViewSurface
      scope: TaskViewScope
      viewId: string
    }[] = [
      {
        scope: { kind: 'workspace' },
        surface: 'workspace-search',
        viewId: 'workspace-results',
      },
      {
        scope: { kind: 'project', projectId: 'roadmap', teamId: 'platform' },
        surface: 'project',
        viewId: 'project-delivery',
      },
      {
        scope: { kind: 'team', teamId: 'platform' },
        surface: 'team',
        viewId: 'team-triage',
      },
      {
        scope: { kind: 'viewer' },
        surface: 'my-tasks',
        viewId: 'my-current-work',
      },
      {
        scope: { kind: 'viewer' },
        surface: 'focus',
        viewId: 'my-focus',
      },
    ]

    for (const candidate of surfaces) {
      expect(createTaskSurfaceActionBaseContext(
        candidate.surface,
        candidate.scope,
        selection,
        candidate.viewId,
      )).toEqual({
        schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
        scope: candidate.scope,
        selection,
        surface: candidate.surface,
        viewId: candidate.viewId,
      })
    }
  })

  test('uses an entrance-specific selection without changing the active surface context', () => {
    const baseSelection: WorkItemActionSelection = { mode: 'none', targets: [] }
    const rowSelection: WorkItemActionSelection = {
      focusedTarget: {
        expectedRevision: 12,
        teamId: 'platform',
        workItemId: 'keyboard-navigation',
      },
      mode: 'single',
      targets: [{
        expectedRevision: 12,
        teamId: 'platform',
        workItemId: 'keyboard-navigation',
      }],
    }
    const context = createTaskSurfaceActionContext(
      createTaskSurfaceActionBaseContext(
        'team',
        { kind: 'team', teamId: 'platform' },
        baseSelection,
      ),
      'open',
      'context-menu',
      undefined,
      rowSelection,
    )

    expect(context).toEqual({
      actionId: 'open',
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      scope: { kind: 'team', teamId: 'platform' },
      selection: rowSelection,
      surface: 'team',
      trigger: 'context-menu',
    })
    expect(resolveTaskSurfaceActionTarget(context)).toEqual(rowSelection.targets[0])
  })

  test('routes click, context-menu, command, and keyboard through one registry handler', async () => {
    const receivedContexts: WorkItemActionContext[] = []
    const registry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: {
        open: (context) => {
          receivedContexts.push(context)
          return {
            actionId: context.actionId,
            items: context.selection.targets.map((target) => ({ status: 'succeeded', target })),
            schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
            status: 'succeeded',
          }
        },
      },
    })
    const selection: WorkItemActionSelection = {
      focusedTarget: { teamId: 'platform', workItemId: 'shared-pipeline' },
      mode: 'single',
      targets: [{ teamId: 'platform', workItemId: 'shared-pipeline' }],
    }
    const baseContext = createTaskSurfaceActionBaseContext(
      'my-tasks',
      { kind: 'viewer' },
      selection,
      'my-current-work',
    )
    const contexts: WorkItemActionContext[] = [
      createTaskSurfaceActionContext(baseContext, 'open', 'click'),
      createTaskSurfaceActionContext(baseContext, 'open', 'context-menu'),
      createTaskSurfaceActionContext(baseContext, 'open', 'command-menu'),
      createTaskSurfaceActionContext(baseContext, 'open', 'keyboard', 'Enter'),
    ]

    for (const context of contexts) {
      expect((await executeTaskAction(registry, context)).status).toBe('executed')
    }
    expect(receivedContexts).toEqual(contexts)
  })

  test('rejects multi-target actions unless the mounted surface opts into bulk execution', async () => {
    const handler: TaskSurfaceActionHandler = (context) => ({
      actionId: context.actionId,
      items: [],
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      status: 'succeeded',
    })
    const context: WorkItemActionContext = {
      actionId: 'move',
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      scope: { kind: 'viewer' },
      selection: {
        mode: 'multiple',
        targets: [
          { teamId: 'platform', workItemId: 'first' },
          { teamId: 'platform', workItemId: 'second' },
        ],
      },
      surface: 'my-tasks',
      trigger: 'command-menu',
    }

    const singleTargetRegistry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: { move: handler },
    })
    const bulkRegistry = createTaskSurfaceActionRegistry({
      bulkActionIds: ['move'],
      disabledReasons,
      handlers: { move: handler },
    })

    expect(await executeTaskAction(singleTargetRegistry, context)).toEqual({
      actionId: 'move',
      issues: [disabledReasons.singleSelectionRequired],
      status: 'invalid',
    })
    expect((await executeTaskAction(bulkRegistry, context)).status).toBe('executed')
  })
})
