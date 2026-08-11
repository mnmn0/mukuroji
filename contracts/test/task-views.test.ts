import { describe, expect, test } from 'bun:test'
import {
  TASK_VIEW_SCHEMA_VERSION,
  TASK_VIEW_SURFACES,
  TASK_VIEW_URL_STATE_SCHEMA_VERSION,
  WORK_ITEM_ACTION_IDS,
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type CreateSavedTaskViewInput,
  type DuplicateSavedTaskViewInput,
  type SavedTaskView,
  type SavedTaskViewsResponse,
  type SavedTaskViewListQuery,
  type TaskViewDefaultSelection,
  type TaskViewUrlState,
  type UpdateSavedTaskViewInput,
  type WorkItemActionContext,
  type WorkItemActionResult,
} from '../src/task-views'

describe('task view contracts', () => {
  test('publishes the complete stable surface and action identifiers', () => {
    expect(TASK_VIEW_SURFACES).toEqual([
      'workspace-search',
      'project',
      'team',
      'my-tasks',
      'focus',
      'triage',
    ])
    expect(new Set(TASK_VIEW_SURFACES).size).toBe(TASK_VIEW_SURFACES.length)

    expect(WORK_ITEM_ACTION_IDS).toEqual([
      'create',
      'open',
      'edit',
      'move',
      'assign',
      'schedule',
      'relation',
      'watch',
      'archive',
    ])
    expect(new Set(WORK_ITEM_ACTION_IDS).size).toBe(WORK_ITEM_ACTION_IDS.length)
  })

  test('represents a complete saved Project task view and lifecycle inputs', () => {
    const view = {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      id: 'view-project-review',
      name: 'Project review',
      visibility: 'team',
      ownerUserId: 'owner@example.com',
      teamId: 'core-team',
      definition: {
        surface: 'project',
        scope: {
          kind: 'project',
          projectId: 'refero',
          teamId: 'core-team',
        },
        filters: {
          entityTypes: ['work-item'],
          priorities: ['high'],
          workflowStatuses: [{ teamId: 'core-team', statusId: 'review' }],
          dueDatePreset: 'upcoming',
        },
        layout: {
          mode: 'table',
          group: { field: 'workflowStatusId', direction: 'asc' },
          subgroup: { field: 'assigneeUserId', direction: 'asc' },
          sort: [{ field: 'dueDate', direction: 'asc' }],
          columns: [
            { field: 'title', width: 360, pin: 'start' },
            { field: 'dueDate', width: 140 },
          ],
          density: 'compact',
          displayOptions: {
            showAssigneeAvatars: true,
            showCompleted: false,
            wrapText: false,
          },
        },
      },
      revision: 3,
      canEdit: true,
      preference: {
        favorite: true,
        pinned: true,
        isDefault: true,
        isPersonalDefault: false,
        isTeamDefault: true,
        defaultSource: 'team',
      },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z',
      migrationWarnings: [{
        code: 'deleted-custom-field',
        section: 'column',
        fallback: 'removed',
        referenceId: 'obsolete-field',
      }],
    } satisfies SavedTaskView

    const createInput = {
      name: view.name,
      visibility: view.visibility,
      teamId: view.teamId,
      definition: view.definition,
      favorite: true,
      pinned: true,
      defaultSource: 'team',
    } satisfies CreateSavedTaskViewInput
    const updateInput = {
      expectedRevision: view.revision,
      definition: view.definition,
      clearDefaultSource: 'team',
    } satisfies UpdateSavedTaskViewInput
    const duplicateInput = {
      name: 'Project review copy',
      visibility: 'personal',
      teamId: null,
      favorite: true,
      defaultSource: 'personal',
    } satisfies DuplicateSavedTaskViewInput
    const listQuery = {
      surface: 'project',
      scope: view.definition.scope,
      limit: 50,
      cursor: 'opaque-next-page',
    } satisfies SavedTaskViewListQuery
    const listResponse = {
      capabilities: {
        canManageSharedViews: false,
        canSetTeamDefault: true,
        canWrite: true,
        writableTeamIds: ['core-team'],
        writableProjectScopes: [{ teamId: 'core-team', projectId: 'refero' }],
      },
      views: [view],
    } satisfies SavedTaskViewsResponse
    const defaultSelection = {
      source: 'team',
      viewId: view.id,
    } satisfies TaskViewDefaultSelection

    expect(createInput.definition).toEqual(view.definition)
    expect(updateInput.clearDefaultSource).toBe('team')
    expect(duplicateInput.visibility).toBe('personal')
    expect(listQuery.scope).toEqual(view.definition.scope)
    expect(listResponse.capabilities.writableTeamIds).toEqual(['core-team'])
    expect(listResponse.capabilities.writableProjectScopes).toEqual([
      { teamId: 'core-team', projectId: 'refero' },
    ])
    expect(defaultSelection).toEqual({ source: 'team', viewId: view.id })
  })

  test('represents a permalink with temporary filters and layout overrides', () => {
    const state = {
      schemaVersion: TASK_VIEW_URL_STATE_SCHEMA_VERSION,
      surface: 'focus',
      scope: { kind: 'viewer' },
      viewId: 'view-focus',
      override: {
        filters: {
          priorities: ['high'],
          dueDatePreset: 'overdue',
        },
        layout: {
          mode: 'list',
          group: null,
          density: 'comfortable',
          displayOptions: { showCompleted: false },
        },
      },
    } satisfies TaskViewUrlState

    expect(state.override.layout.group).toBeNull()
    expect(state.override.filters.dueDatePreset).toBe('overdue')
  })
})

describe('Work Item action contracts', () => {
  test('keeps invocation context independent from its click or keyboard entry point', () => {
    const context = {
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      actionId: 'schedule',
      trigger: 'keyboard',
      surface: 'project',
      scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
      selection: {
        mode: 'multiple',
        targets: [
          { teamId: 'core-team', workItemId: 'issue-1', expectedRevision: 4 },
          { teamId: 'core-team', workItemId: 'issue-2', expectedRevision: 2 },
        ],
        focusedTarget: {
          teamId: 'core-team',
          workItemId: 'issue-1',
          expectedRevision: 4,
        },
        anchorTarget: {
          teamId: 'core-team',
          workItemId: 'issue-1',
          expectedRevision: 4,
        },
      },
      viewId: 'view-project-review',
      keyboardShortcut: 'shift+s',
    } satisfies WorkItemActionContext
    const result = {
      schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
      actionId: context.actionId,
      status: 'partial',
      items: [
        {
          target: context.selection.targets[0],
          status: 'succeeded',
          resultingRevision: 5,
        },
        {
          target: context.selection.targets[1],
          status: 'failed',
          failure: {
            code: 'WorkItemRevisionConflict',
            category: 'conflict',
            message: 'Work Item changed. Reload and try again.',
            retryable: false,
          },
        },
      ],
      undoToken: 'opaque-undo-token',
    } satisfies WorkItemActionResult

    expect(context.selection.mode).toBe('multiple')
    expect(result.items.map((item) => item.status)).toEqual(['succeeded', 'failed'])
    expect(result.items[1]?.failure?.category).toBe('conflict')
  })
})
