import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createTaskActionContextMenuItems,
  resolveInitialTaskActionMenuItemIndex,
  resolveTaskActionContextMenuLayout,
} from '../src/task-views/model/taskActionContextMenu'
import { createTaskSurfaceActionRegistry } from '../src/task-views/mutations/useTaskSurfaceActions'
import { TaskActionContextMenu } from '../src/task-views/ui/TaskActionContextMenu'

const labels = {
  archive: 'Archive',
  assign: 'Assign',
  create: 'Create',
  edit: 'Edit',
  move: 'Move',
  open: 'Open',
  relation: 'Relations',
  schedule: 'Schedule',
  watch: 'Watch',
}

const disabledReasons = {
  selectionRequired: 'Select one item.',
  singleSelectionRequired: 'Select only one item.',
  unavailable: 'Unavailable on this surface.',
}

const context: Omit<
  WorkItemActionContext,
  'actionId' | 'keyboardShortcut' | 'trigger'
> = {
  schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
  scope: { kind: 'project', projectId: 'refero' },
  selection: {
    focusedTarget: {
      expectedRevision: 4,
      teamId: 'design',
      workItemId: 'context-menu',
    },
    mode: 'single',
    targets: [{
      expectedRevision: 4,
      teamId: 'design',
      workItemId: 'context-menu',
    }],
  },
  surface: 'project',
}

describe('Task action context menu', () => {
  test('uses shared registry policy for ordered labels, shortcuts, and disabled reasons', () => {
    const registry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: {
        edit: (actionContext) => ({
          actionId: actionContext.actionId,
          items: [],
          schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
          status: 'succeeded',
        }),
        open: (actionContext) => ({
          actionId: actionContext.actionId,
          items: [],
          schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
          status: 'succeeded',
        }),
      },
      permissions: {
        edit: () => ({ allowed: false, reason: 'Editing is restricted.' }),
      },
    })
    const items = createTaskActionContextMenuItems(registry, labels, context)

    expect(items.map((item) => item.id)).toEqual([
      'open',
      'edit',
      'move',
      'assign',
      'schedule',
      'relation',
      'watch',
      'archive',
    ])
    const openItem = items.find((item) => item.id === 'open')
    expect(openItem?.shortcut).toBe('Enter')
    expect(openItem?.disabledReason).toBeUndefined()
    expect(items.find((item) => item.id === 'edit')).toMatchObject({
      disabledReason: 'Editing is restricted.',
      shortcut: 'E',
    })
    expect(items.find((item) => item.id === 'move')).toMatchObject({
      disabledReason: disabledReasons.unavailable,
      separatorBefore: true,
    })
    expect(items.find((item) => item.id === 'archive')).toMatchObject({
      destructive: true,
      separatorBefore: true,
    })
    expect(resolveInitialTaskActionMenuItemIndex(items)).toBe(0)
  })

  test('switches to a bottom sheet on mobile and clamps a desktop popover', () => {
    expect(resolveTaskActionContextMenuLayout(
      { x: 350, y: 700 },
      390,
      844,
    )).toEqual({ mode: 'sheet' })
    expect(resolveTaskActionContextMenuLayout(
      { x: 1400, y: 880 },
      1440,
      900,
      224,
      440,
    )).toEqual({ left: 1208, mode: 'popover', top: 432 })
    expect(resolveTaskActionContextMenuLayout(
      { x: 100, y: 100 },
      1440,
      900,
      224,
      440,
    )).toEqual({ left: 100, mode: 'popover', top: 108 })
  })

  test('renders disabled reasons as focusable menu-item descriptions', () => {
    const registry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: {
        open: (actionContext) => ({
          actionId: actionContext.actionId,
          items: [],
          schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
          status: 'succeeded',
        }),
      },
    })
    const html = renderToStaticMarkup(
      <TaskActionContextMenu
        anchorPoint={{ x: 120, y: 160 }}
        context={context}
        labels={labels}
        menuLabel="Task actions"
        onClose={() => undefined}
        onExecute={() => undefined}
        registry={registry}
      />,
    )

    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="Task actions"')
    expect(html).toContain('data-action-id="open"')
    expect(html).toContain('aria-disabled="false"')
    expect(html).toContain('data-action-id="edit"')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain(disabledReasons.unavailable)
    expect(html).toContain('data-action-id="archive"')
  })
})
