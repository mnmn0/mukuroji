import type {
  WorkItemActionContext,
  WorkItemActionId,
} from '@mukuroji/contracts'
import {
  formatTaskActionShortcut,
  resolveTaskActionDisabledReason,
  type TaskActionRegistry,
} from './taskActionRegistry'

/** Canonical target-specific actions shown by a task row or card context menu. */
export const taskActionContextMenuActionIds: readonly WorkItemActionId[] = [
  'open',
  'edit',
  'move',
  'assign',
  'schedule',
  'relation',
  'watch',
  'archive',
]

/** Pointer or overflow-button anchor used to position a desktop context menu. */
export type TaskActionContextMenuAnchorPoint = {
  /** Horizontal viewport coordinate in CSS pixels. */
  x: number
  /** Vertical viewport coordinate in CSS pixels. */
  y: number
}

/** Responsive placement resolved for the context menu. */
export type TaskActionContextMenuLayout = {
  /** Popover on desktop or bottom sheet on compact viewports. */
  mode: 'popover' | 'sheet'
  /** Clamped horizontal coordinate for a desktop popover. */
  left?: number
  /** Clamped vertical coordinate for a desktop popover. */
  top?: number
}

/** Read-only action metadata displayed by the context menu. */
export type TaskActionContextMenuItem = {
  /** Canonical action identifier executed by the shared registry pipeline. */
  id: WorkItemActionId
  /** Localized visible action label. */
  label: string
  /** Optional compact keyboard shortcut label. */
  shortcut?: string
  /** Permission or validation reason that prevents activation. */
  disabledReason?: string
  /** Whether a visual separator starts this semantic action group. */
  separatorBefore: boolean
  /** Whether the action is destructive and receives danger styling. */
  destructive: boolean
}

/** Maximum viewport width that uses the touch-oriented bottom sheet. */
const taskActionContextMenuCompactWidth = 640

/** Preferred desktop menu width derived from compact Refero action menus. */
const taskActionContextMenuWidth = 224

/** Safe viewport inset retained around a desktop menu. */
const taskActionContextMenuViewportInset = 8

/** Estimated pre-measurement menu height used to avoid initial viewport overflow. */
export const taskActionContextMenuEstimatedHeight = 440

/** Action IDs that begin a new related-action section. */
const taskActionContextMenuSectionStarts = new Set<WorkItemActionId>([
  'move',
  'relation',
  'archive',
])

/**
 * Builds read-only menu rows by evaluating the same registry policy used during execution.
 *
 * @param registry - Shared action registry for the active task surface.
 * @param labels - Localized labels indexed by canonical action ID.
 * @param context - Surface, scope, view, and target selection for this menu.
 * @param actionIds - Ordered action subset to display.
 * @returns Visible action rows with shortcuts and blocking reasons.
 */
export function createTaskActionContextMenuItems(
  registry: TaskActionRegistry,
  labels: Readonly<Record<WorkItemActionId, string>>,
  context: Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'>,
  actionIds: readonly WorkItemActionId[] = taskActionContextMenuActionIds,
): readonly TaskActionContextMenuItem[] {
  return actionIds.flatMap((actionId) => {
    const definition = registry.actions.get(actionId)
    if (!definition) return []
    const actionContext: WorkItemActionContext = {
      ...context,
      actionId,
      trigger: 'context-menu',
    }
    const disabledReason = resolveTaskActionDisabledReason(definition, actionContext)
    const shortcut = definition.shortcut
      ? formatTaskActionShortcut(definition.shortcut)
      : undefined
    return [{
      destructive: actionId === 'archive',
      ...(disabledReason !== undefined ? { disabledReason } : {}),
      id: actionId,
      label: labels[actionId],
      separatorBefore: taskActionContextMenuSectionStarts.has(actionId),
      ...(shortcut !== undefined ? { shortcut } : {}),
    }]
  })
}

/**
 * Resolves responsive menu placement and clamps desktop coordinates to the viewport.
 *
 * @param anchorPoint - Pointer or overflow-button viewport coordinate.
 * @param viewportWidth - Current viewport width in CSS pixels.
 * @param viewportHeight - Current viewport height in CSS pixels.
 * @param menuWidth - Current or estimated menu width.
 * @param menuHeight - Current or estimated menu height.
 * @returns Bottom-sheet mode or safe desktop popover coordinates.
 */
export function resolveTaskActionContextMenuLayout(
  anchorPoint: TaskActionContextMenuAnchorPoint,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = taskActionContextMenuWidth,
  menuHeight = taskActionContextMenuEstimatedHeight,
): TaskActionContextMenuLayout {
  if (viewportWidth <= taskActionContextMenuCompactWidth) {
    return { mode: 'sheet' }
  }

  const maximumLeft = Math.max(
    taskActionContextMenuViewportInset,
    viewportWidth - menuWidth - taskActionContextMenuViewportInset,
  )
  const left = clamp(
    anchorPoint.x,
    taskActionContextMenuViewportInset,
    maximumLeft,
  )
  const preferredTop = anchorPoint.y + taskActionContextMenuViewportInset
  const maximumTop = Math.max(
    taskActionContextMenuViewportInset,
    viewportHeight - menuHeight - taskActionContextMenuViewportInset,
  )
  const top = preferredTop <= maximumTop
    ? preferredTop
    : clamp(
        anchorPoint.y - menuHeight - taskActionContextMenuViewportInset,
        taskActionContextMenuViewportInset,
        maximumTop,
      )

  return { left, mode: 'popover', top }
}

/**
 * Selects the first permitted action while retaining a fallback for all-disabled menus.
 *
 * @param items - Current ordered menu rows.
 * @returns Zero-based focus index, or -1 when no actions are rendered.
 */
export function resolveInitialTaskActionMenuItemIndex(
  items: readonly TaskActionContextMenuItem[],
): number {
  const firstEnabledIndex = items.findIndex((item) => item.disabledReason === undefined)
  return firstEnabledIndex >= 0 ? firstEnabledIndex : items.length > 0 ? 0 : -1
}

/** Clamps one numeric value to an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
