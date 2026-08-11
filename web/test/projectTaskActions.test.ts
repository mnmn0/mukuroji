import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_IDS,
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
} from '@mukuroji/contracts'
import { executeTaskAction } from '../src/task-views/model/taskActionRegistry'
import {
  createProjectTaskActionRegistry,
  resolveProjectTaskActionTarget,
} from '../src/task-views/mutations/useProjectTaskActions'

const disabledReasons = {
  selectionRequired: 'Select one item.',
  singleSelectionRequired: 'Select only one item.',
  unavailable: 'Unavailable here.',
}

describe('Project task action registry', () => {
  test('registers every canonical action and denies unavailable entrances explicitly', () => {
    const registry = createProjectTaskActionRegistry({
      disabledReasons,
      handlers: {
        create: (context) => ({
          actionId: context.actionId,
          items: [],
          schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
          status: 'succeeded',
        }),
      },
    })
    const context: WorkItemActionContext = {
      actionId: 'move',
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      scope: { kind: 'project', projectId: 'refero' },
      selection: { mode: 'none', targets: [] },
      surface: 'project',
      trigger: 'command-menu',
    }

    expect([...registry.actions.keys()]).toEqual(WORK_ITEM_ACTION_IDS)
    expect(registry.missingActionIds).toEqual([])
    expect(registry.actions.get('move')?.permission(context)).toEqual({
      allowed: false,
      reason: disabledReasons.unavailable,
    })
  })

  test('shares single-target validation and execution across invocation paths', async () => {
    const registry = createProjectTaskActionRegistry({
      disabledReasons,
      handlers: {
        open: (context) => ({
          actionId: context.actionId,
          items: [],
          schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
          status: 'succeeded',
        }),
      },
    })
    const emptyContext: WorkItemActionContext = {
      actionId: 'open',
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      scope: { kind: 'project', projectId: 'refero' },
      selection: { mode: 'none', targets: [] },
      surface: 'project',
      trigger: 'keyboard',
    }
    const focusedContext: WorkItemActionContext = {
      ...emptyContext,
      selection: {
        focusedTarget: {
          expectedRevision: 3,
          teamId: 'core-team',
          workItemId: 'wireframe',
        },
        mode: 'none',
        targets: [],
      },
    }

    expect(await executeTaskAction(registry, emptyContext)).toEqual({
      actionId: 'open',
      issues: [disabledReasons.selectionRequired],
      status: 'invalid',
    })
    expect((await executeTaskAction(registry, focusedContext)).status).toBe('executed')
    expect(resolveProjectTaskActionTarget(focusedContext)).toEqual({
      expectedRevision: 3,
      teamId: 'core-team',
      workItemId: 'wireframe',
    })
  })

  test('reserves selection shortcuts and exposes only unambiguous action chords', () => {
    const registry = createProjectTaskActionRegistry({
      disabledReasons,
      handlers: {},
    })

    expect(registry.shortcuts.get('j')).toBeUndefined()
    expect(registry.shortcuts.get('k')).toBeUndefined()
    expect(registry.shortcuts.get('space')).toBeUndefined()
    expect(registry.shortcuts.get('c')).toBe('create')
    expect(registry.shortcuts.get('primary+shift+c')).toBeUndefined()
    expect(registry.shortcuts.get('enter')).toBe('open')
    expect(registry.shortcuts.get('e')).toBe('edit')
  })

  test('accepts multi-selection only for move, assign, and archive entrances', async () => {
    const executedActionIds: string[] = []
    /** Records one accepted action and succeeds every concrete selected target. */
    const createHandler = (context: WorkItemActionContext) => {
      executedActionIds.push(context.actionId)
      return {
        actionId: context.actionId,
        items: context.selection.targets.map((target) => ({ status: 'succeeded' as const, target })),
        schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
        status: 'succeeded' as const,
      }
    }
    const registry = createProjectTaskActionRegistry({
      disabledReasons,
      handlers: {
        archive: createHandler,
        assign: createHandler,
        move: createHandler,
        open: createHandler,
      },
    })
    const context: WorkItemActionContext = {
      actionId: 'move',
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      scope: { kind: 'project', projectId: 'refero' },
      selection: {
        mode: 'multiple',
        targets: [
          { expectedRevision: 3, teamId: 'core-team', workItemId: 'wireframe' },
          { expectedRevision: 7, teamId: 'design-team', workItemId: 'prototype' },
        ],
      },
      surface: 'project',
      trigger: 'bulk-action',
    }

    for (const actionId of ['move', 'assign', 'archive'] as const) {
      const result = await executeTaskAction(registry, { ...context, actionId })
      expect(result.status).toBe('executed')
    }
    expect(await executeTaskAction(registry, { ...context, actionId: 'open' })).toEqual({
      actionId: 'open',
      issues: [disabledReasons.singleSelectionRequired],
      status: 'invalid',
    })
    expect(executedActionIds).toEqual(['move', 'assign', 'archive'])
  })

  test('evaluates target-aware permission before invoking an available handler', async () => {
    let executionCalls = 0
    const registry = createProjectTaskActionRegistry({
      disabledReasons,
      handlers: {
        edit: (context) => {
          executionCalls += 1
          return {
            actionId: context.actionId,
            items: [],
            schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
            status: 'succeeded',
          }
        },
      },
      permissions: {
        edit: (context) => context.selection.focusedTarget?.teamId === 'core-team'
          ? { allowed: true }
          : { allowed: false, reason: 'Target is not editable.' },
      },
    })
    const context: WorkItemActionContext = {
      actionId: 'edit',
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      scope: { kind: 'project', projectId: 'refero' },
      selection: {
        focusedTarget: {
          expectedRevision: 9,
          teamId: 'restricted-team',
          workItemId: 'private-item',
        },
        mode: 'none',
        targets: [],
      },
      surface: 'project',
      trigger: 'click',
    }

    expect(await executeTaskAction(registry, context)).toEqual({
      actionId: 'edit',
      reason: 'Target is not editable.',
      status: 'denied',
    })
    expect(executionCalls).toBe(0)
  })
})
