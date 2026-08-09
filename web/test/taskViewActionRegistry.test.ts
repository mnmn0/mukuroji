import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  WORK_ITEM_ACTION_IDS,
  type WorkItemActionContext,
  type WorkItemActionId,
  type WorkItemActionTrigger,
} from '@mukuroji/contracts'
import {
  allowTaskAction,
  createTaskActionRegistry,
  createFailedTaskActionResult,
  createSucceededTaskActionResult,
  denyTaskAction,
  executeTaskAction,
  invalidateTaskAction,
  resolveTaskActionShortcut,
  resolveTaskActionExecutionFailureMessage,
  taskActionIds,
  validateTaskAction,
  type TaskActionDefinition,
  type TaskActionKeyboardInput,
} from '../src/task-views/model/taskActionRegistry'

/**
 * Creates a complete contract action context for registry tests.
 *
 * @param actionId - Requested canonical action.
 * @param trigger - Invocation path under test.
 * @returns Contract action context.
 */
function createActionContext(
  actionId: WorkItemActionId,
  trigger: WorkItemActionTrigger = 'click',
): WorkItemActionContext {
  return {
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    actionId,
    trigger,
    surface: 'team',
    scope: { kind: 'team', teamId: 'team-1' },
    selection: {
      mode: 'single',
      targets: [{ teamId: 'team-1', workItemId: 'work-item-1', expectedRevision: 4 }],
      focusedTarget: { teamId: 'team-1', workItemId: 'work-item-1', expectedRevision: 4 },
      anchorTarget: { teamId: 'team-1', workItemId: 'work-item-1', expectedRevision: 4 },
    },
  }
}

/**
 * Creates a canonical action definition with permissive defaults.
 *
 * @param id - Canonical action identifier.
 * @param shortcut - Optional keyboard shortcut.
 * @returns Registry definition.
 */
function createDefinition(
  id: WorkItemActionId,
  shortcut?: TaskActionDefinition['shortcut'],
): TaskActionDefinition {
  return {
    id,
    ...(shortcut ? { shortcut } : {}),
    permission: allowTaskAction,
    validate: validateTaskAction,
    execute: (context) => ({
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      actionId: context.actionId,
      status: 'succeeded',
      items: context.selection.targets.map((target) => ({ target, status: 'succeeded' })),
    }),
  }
}

/**
 * Creates unguarded keyboard input for shortcut lookup.
 *
 * @param key - Browser key value.
 * @returns Keyboard input facts.
 */
function createKeyboardInput(key: string): TaskActionKeyboardInput {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    isEditableTarget: false,
    isModalOpen: false,
  }
}

describe('canonical task action registry', () => {
  test('creates shared success and failure results with safe execution feedback', () => {
    const target = { expectedRevision: 4, teamId: 'team-1', workItemId: 'work-item-1' }
    expect(createSucceededTaskActionResult('open', target)).toMatchObject({
      actionId: 'open',
      items: [{ status: 'succeeded', target }],
      status: 'succeeded',
    })
    const failedResult = createFailedTaskActionResult(
      'open',
      target,
      'TaskNotFound',
      'not-found',
      'The Work Item is unavailable.',
    )
    expect(resolveTaskActionExecutionFailureMessage({
      actionId: 'open',
      result: failedResult,
      status: 'executed',
    }, 'Fallback')).toBe('The Work Item is unavailable.')
    expect(resolveTaskActionExecutionFailureMessage({
      actionId: 'open',
      reason: 'Access denied.',
      status: 'denied',
    }, 'Fallback')).toBe('Access denied.')
  })

  test('uses the exact contract action set and returns missing definitions in canonical order', () => {
    const registry = createTaskActionRegistry({ definitions: [createDefinition('edit')] })

    expect(taskActionIds).toEqual(WORK_ITEM_ACTION_IDS)
    expect(registry.missingActionIds).toEqual([
      'create',
      'open',
      'move',
      'assign',
      'schedule',
      'relation',
      'watch',
      'archive',
    ])
    expect(() => createTaskActionRegistry({
      definitions: [createDefinition('edit'), createDefinition('edit')],
    })).toThrow('Duplicate task action definition: edit')
  })

  test('runs one permission, validation, and executor pipeline for every invocation path', async () => {
    const receivedTriggers: WorkItemActionTrigger[] = []
    const definition = createDefinition('edit')
    const registry = createTaskActionRegistry({
      definitions: [{
        ...definition,
        execute: (context) => {
          receivedTriggers.push(context.trigger)
          return definition.execute(context)
        },
      }],
    })
    const triggers: readonly WorkItemActionTrigger[] = [
      'click',
      'context-menu',
      'command-menu',
      'keyboard',
      'bulk-action',
    ]

    for (const trigger of triggers) {
      const result = await executeTaskAction(registry, createActionContext('edit', trigger))
      expect(result.status).toBe('executed')
      if (result.status === 'executed') {
        expect(result.result.actionId).toBe('edit')
        expect(result.result.items[0]?.target).toMatchObject({
          teamId: 'team-1',
          workItemId: 'work-item-1',
          expectedRevision: 4,
        })
      }
    }
    expect(receivedTriggers).toEqual(triggers)
  })

  test('stops before validation or execution when permission is denied', async () => {
    let validationCalls = 0
    let executionCalls = 0
    const registry = createTaskActionRegistry({
      definitions: [{
        ...createDefinition('archive'),
        permission: () => denyTaskAction('Archive permission required.'),
        validate: () => {
          validationCalls += 1
          return validateTaskAction()
        },
        execute: (context) => {
          executionCalls += 1
          return createDefinition('archive').execute(context)
        },
      }],
    })

    expect(await executeTaskAction(registry, createActionContext('archive'))).toEqual({
      actionId: 'archive',
      reason: 'Archive permission required.',
      status: 'denied',
    })
    expect(validationCalls).toBe(0)
    expect(executionCalls).toBe(0)
  })

  test('stops before execution when shared validation fails', async () => {
    let executionCalls = 0
    const registry = createTaskActionRegistry({
      definitions: [{
        ...createDefinition('move'),
        validate: () => invalidateTaskAction(['A destination Team is required.']),
        execute: (context) => {
          executionCalls += 1
          return createDefinition('move').execute(context)
        },
      }],
    })

    expect(await executeTaskAction(registry, createActionContext('move'))).toEqual({
      actionId: 'move',
      issues: ['A destination Team is required.'],
      status: 'invalid',
    })
    expect(executionCalls).toBe(0)
  })

  test('disables action-action and reserved shortcut collisions', () => {
    const registry = createTaskActionRegistry({
      definitions: [
        createDefinition('open', { key: 'e' }),
        createDefinition('edit', { key: 'E' }),
        createDefinition('assign', { key: 'k', primary: true }),
        createDefinition('archive', { key: 'x' }),
      ],
      reservedShortcuts: [{ key: 'K', primary: true }],
    })

    expect(registry.shortcutCollisions).toEqual([
      { actionIds: ['open', 'edit'], chord: 'e', reserved: false },
      { actionIds: ['assign'], chord: 'primary+k', reserved: true },
    ])
    expect(resolveTaskActionShortcut(registry, createKeyboardInput('e'))).toBeUndefined()
    expect(resolveTaskActionShortcut(registry, {
      ...createKeyboardInput('k'),
      metaKey: true,
    })).toBeUndefined()
    expect(resolveTaskActionShortcut(registry, createKeyboardInput('X'))?.id).toBe('archive')
  })

  test('guards editable, IME, modal, and repeating keyboard input', () => {
    const registry = createTaskActionRegistry({
      definitions: [createDefinition('open', { key: 'o' })],
    })
    const guardedInputs: TaskActionKeyboardInput[] = [
      { ...createKeyboardInput('o'), isEditableTarget: true },
      { ...createKeyboardInput('o'), isComposing: true },
      { ...createKeyboardInput('o'), isModalOpen: true },
      { ...createKeyboardInput('o'), repeat: true },
    ]

    expect(guardedInputs.map((input) => resolveTaskActionShortcut(registry, input)))
      .toEqual([undefined, undefined, undefined, undefined])
  })
})
