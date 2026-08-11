import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
} from '@mukuroji/contracts'
import {
  createWorkspaceCommandMenuWorkItemActionRegistry,
  executeWorkspaceCommandMenuWorkItemAction,
  resolveWorkspaceCommandMenuWorkItemActions,
  type WorkspaceCommandMenuWorkItemActionRegistration,
} from '../src/commands/ui/WorkspaceCommandMenuContext'

describe('Workspace command-menu Work Item registrations', () => {
  test('executes the registered adapter with a canonical command-menu context', () => {
    let receivedContext: WorkItemActionContext | undefined
    const registry = createWorkspaceCommandMenuWorkItemActionRegistry()
    const unregister = registry.register({
      registrationId: 'project-surface',
      context: {
        schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
        surface: 'project',
        scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
        selection: {
          mode: 'single',
          targets: [{ teamId: 'core-team', workItemId: 'wireframe' }],
          focusedTarget: { teamId: 'core-team', workItemId: 'wireframe' },
        },
        viewId: 'delivery-review',
      },
      actions: [{
        id: 'edit',
        label: 'Edit selected Work Item',
        shortcut: 'E',
        execute: (context) => {
          receivedContext = context
        },
      }],
    })
    const action = registry.getSnapshot()[0]

    expect(action).toBeDefined()
    if (!action) throw new Error('Expected the registered edit action.')

    executeWorkspaceCommandMenuWorkItemAction(action)

    expect(receivedContext).toEqual({
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      actionId: 'edit',
      trigger: 'command-menu',
      surface: 'project',
      scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
      selection: {
        mode: 'single',
        targets: [{ teamId: 'core-team', workItemId: 'wireframe' }],
        focusedTarget: { teamId: 'core-team', workItemId: 'wireframe' },
      },
      viewId: 'delivery-review',
    })

    unregister()
    expect(registry.getSnapshot()).toEqual([])
  })

  test('resolves duplicate actions by precedence and stable registration ID', () => {
    const context: WorkspaceCommandMenuWorkItemActionRegistration['context'] = {
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      surface: 'team',
      scope: { kind: 'team', teamId: 'core-team' },
      selection: { mode: 'none', targets: [] },
    }
    const actions = resolveWorkspaceCommandMenuWorkItemActions([
      {
        registrationId: 'zeta-surface',
        precedence: 10,
        context,
        actions: [{ id: 'open', label: 'Zeta open', execute: () => undefined }],
      },
      {
        registrationId: 'alpha-surface',
        precedence: 10,
        context,
        actions: [{ id: 'open', label: 'Alpha open', execute: () => undefined }],
      },
      {
        registrationId: 'higher-surface',
        precedence: 20,
        context,
        actions: [{ id: 'archive', label: 'Higher archive', execute: () => undefined }],
      },
      {
        registrationId: 'lower-surface',
        precedence: 0,
        context,
        actions: [
          { id: 'archive', label: 'Lower archive', execute: () => undefined },
          { id: 'create', label: 'Create', execute: () => undefined },
        ],
      },
    ])

    expect(actions.map((action) => action.id)).toEqual(['create', 'open', 'archive'])
    expect(actions.find((action) => action.id === 'open')?.label).toBe('Alpha open')
    expect(actions.find((action) => action.id === 'archive')?.label).toBe('Higher archive')
  })

  test('keeps a replacement registered when stale cleanup runs', () => {
    const registry = createWorkspaceCommandMenuWorkItemActionRegistry()
    const context: WorkspaceCommandMenuWorkItemActionRegistration['context'] = {
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      surface: 'my-tasks',
      scope: { kind: 'viewer' },
      selection: { mode: 'none', targets: [] },
    }
    const unregisterOld = registry.register({
      registrationId: 'viewer-surface',
      context,
      actions: [{ id: 'create', label: 'Old create', execute: () => undefined }],
    })
    const unregisterReplacement = registry.register({
      registrationId: 'viewer-surface',
      context,
      actions: [{ id: 'create', label: 'Current create', execute: () => undefined }],
    })

    unregisterOld()
    expect(registry.getSnapshot()[0]?.label).toBe('Current create')

    unregisterReplacement()
    expect(registry.getSnapshot()).toEqual([])
  })
})
