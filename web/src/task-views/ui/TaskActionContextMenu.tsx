import type {
  WorkItemActionContext,
  WorkItemActionId,
} from '@mukuroji/contracts'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  createTaskActionContextMenuItems,
  resolveInitialTaskActionMenuItemIndex,
  resolveTaskActionContextMenuLayout,
  taskActionContextMenuActionIds,
  taskActionContextMenuEstimatedHeight,
  type TaskActionContextMenuAnchorPoint,
} from '../model/taskActionContextMenu'
import type { TaskActionRegistry } from '../model/taskActionRegistry'

/** Props accepted by the shared task row and card context menu. */
export type TaskActionContextMenuProps = {
  /** Desktop pointer or overflow-button anchor. */
  anchorPoint: TaskActionContextMenuAnchorPoint
  /** Optional action subset rendered in canonical order. */
  actionIds?: readonly WorkItemActionId[]
  /** Surface, scope, view, and target selection used for display-time policy checks. */
  context: Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'>
  /** Localized action labels indexed by canonical action ID. */
  labels: Readonly<Record<WorkItemActionId, string>>
  /** Accessible name applied to the menu surface. */
  menuLabel: string
  /** Closes the current menu without executing an action. */
  onClose: () => void
  /** Routes one permitted activation to the owning action controller. */
  onExecute: (actionId: WorkItemActionId) => void
  /** Shared action registry used for display-time permission and validation. */
  registry: TaskActionRegistry
  /** Element that receives focus after the menu closes. */
  returnFocusElement?: HTMLElement | null
  /** Optional stable selector used by stories and browser checks. */
  testId?: string
}

/** Preferred desktop menu width derived from compact Refero action menus. */
const taskActionContextMenuWidth = 224

/**
 * Renders a compact desktop popover or touch-oriented mobile bottom sheet.
 *
 * Permission-denied actions stay visible with their reason. Activations are delegated to the
 * owning controller, which re-runs the same policy and validation immediately before execution.
 *
 * @param props - Registry metadata, target context, placement, and action callbacks.
 * @returns A portal-backed accessible action menu.
 */
export function TaskActionContextMenu({
  actionIds = taskActionContextMenuActionIds,
  anchorPoint,
  context,
  labels,
  menuLabel,
  onClose,
  onExecute,
  registry,
  returnFocusElement,
  testId = 'task-action-context-menu',
}: TaskActionContextMenuProps) {
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const returnFocusRef = useRef(returnFocusElement)
  const anchorX = anchorPoint.x
  const anchorY = anchorPoint.y
  const items = useMemo(
    () => createTaskActionContextMenuItems(registry, labels, context, actionIds),
    [actionIds, context, labels, registry],
  )
  const [layout, setLayout] = useState(() =>
    resolveTaskActionContextMenuLayout(
      { x: anchorX, y: anchorY },
      readViewportWidth(),
      readViewportHeight(),
      taskActionContextMenuWidth,
      taskActionContextMenuEstimatedHeight,
    )
  )
  const [activeIndex, setActiveIndex] = useState(() =>
    resolveInitialTaskActionMenuItemIndex(items)
  )
  const resolvedActiveIndex = activeIndex >= 0 && activeIndex < items.length
    ? activeIndex
    : resolveInitialTaskActionMenuItemIndex(items)

  useEffect(() => {
    returnFocusRef.current = returnFocusElement
  }, [returnFocusElement])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => () => {
    const focusTarget = returnFocusRef.current
    if (focusTarget?.isConnected) focusTarget.focus()
  }, [])

  useEffect(() => {
    itemRefs.current[resolvedActiveIndex]?.focus()
  }, [resolvedActiveIndex])

  useEffect(() => {
    /** Recomputes responsive placement after viewport or rendered menu size changes. */
    const updateLayout = () => {
      const menu = menuRef.current
      setLayout(resolveTaskActionContextMenuLayout(
        { x: anchorX, y: anchorY },
        readViewportWidth(),
        readViewportHeight(),
        menu?.offsetWidth ?? taskActionContextMenuWidth,
        menu?.offsetHeight ?? taskActionContextMenuEstimatedHeight,
      ))
    }

    updateLayout()
    if (typeof window === 'undefined') return
    window.addEventListener('resize', updateLayout)
    return () => window.removeEventListener('resize', updateLayout)
  }, [anchorX, anchorY, items.length])

  /** Moves focus through every visible item, including disabled reasons. */
  const moveActiveItem = (offset: number) => {
    if (items.length === 0) return
    setActiveIndex((currentIndex) => {
      const normalizedIndex = currentIndex < 0 || currentIndex >= items.length
        ? resolvedActiveIndex
        : currentIndex
      return (normalizedIndex + offset + items.length) % items.length
    })
  }

  /** Implements menu navigation and dismissal keyboard semantics. */
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveActiveItem(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveActiveItem(-1)
        return
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        return
      case 'End':
        event.preventDefault()
        setActiveIndex(Math.max(0, items.length - 1))
        return
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        onClose()
        return
    }
  }

  const menu = (
    <div
      className={`fixed inset-0 z-[80] ${
        layout.mode === 'sheet' ? 'bg-slate-950/35 backdrop-blur-[1px]' : 'bg-transparent'
      }`}
      data-layout={layout.mode}
      data-task-keyboard-modal="true"
      data-testid={`${testId}-backdrop`}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        aria-label={menuLabel}
        aria-orientation="vertical"
        className={`fixed z-[81] grid overflow-y-auto border border-[var(--workbench-border-strong)] bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)] outline-none ${
          layout.mode === 'sheet'
            ? 'bottom-2 left-2 right-2 max-h-[calc(100vh-1rem)] rounded-xl px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2'
            : 'max-h-[min(520px,calc(100vh-1rem))] w-56 max-w-[calc(100vw-1rem)] rounded-lg p-1.5'
        }`}
        data-testid={testId}
        onKeyDown={handleMenuKeyDown}
        ref={menuRef}
        role="menu"
        style={layout.mode === 'popover'
          ? { left: layout.left, top: layout.top }
          : undefined}
      >
        {layout.mode === 'sheet' ? (
          <div
            aria-hidden="true"
            className="mx-auto mb-1.5 h-1 w-10 rounded-full bg-slate-300"
          />
        ) : null}
        {items.map((item, index) => {
          const disabled = item.disabledReason !== undefined
          const descriptionId = `${menuId}-${item.id}-reason`
          const active = resolvedActiveIndex === index
          return (
            <div
              className={item.separatorBefore
                ? 'mt-1 border-t border-slate-100 pt-1'
                : undefined}
              key={item.id}
            >
              <button
                aria-describedby={disabled ? descriptionId : undefined}
                aria-disabled={disabled}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2.5 text-left outline-none ${
                  layout.mode === 'sheet' ? 'min-h-[52px] py-2' : 'min-h-9 py-1.5'
                } ${
                  disabled
                    ? 'cursor-not-allowed text-slate-400'
                    : item.destructive
                      ? 'text-red-600'
                      : 'text-[var(--workbench-text)]'
                } ${
                  active ? 'bg-[var(--workbench-surface-muted)] ring-2 ring-[#2563eb]/10' : ''
                }`}
                data-action-id={item.id}
                data-disabled-reason={item.disabledReason}
                onClick={() => {
                  if (disabled) return
                  onClose()
                  onExecute(item.id)
                }}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
                ref={(element) => {
                  itemRefs.current[index] = element
                }}
                role="menuitem"
                tabIndex={active ? 0 : -1}
                type="button"
              >
                <span className="min-w-0 text-sm font-semibold">{item.label}</span>
                {item.shortcut ? (
                  <kbd className="text-[10px] font-semibold text-[var(--workbench-muted-soft)]">
                    {item.shortcut}
                  </kbd>
                ) : null}
                {disabled ? (
                  <span
                    className="col-span-2 mt-0.5 text-[11px] leading-4 text-[var(--workbench-muted)]"
                    id={descriptionId}
                  >
                    {item.disabledReason}
                  </span>
                ) : null}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}

/** Reads the current viewport width or a deterministic server-rendering fallback. */
function readViewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

/** Reads the current viewport height or a deterministic server-rendering fallback. */
function readViewportHeight(): number {
  return typeof window === 'undefined' ? 900 : window.innerHeight
}
