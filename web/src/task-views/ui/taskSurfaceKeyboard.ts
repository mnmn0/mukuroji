import {
  createTaskActionShortcutChord,
  type TaskActionKeyboardInput,
  type TaskActionShortcut,
} from '../model/taskActionRegistry'

/**
 * Converts a browser event into the shared guarded task-surface keyboard input.
 *
 * @param event - Browser keydown event.
 * @param ownsModalInteraction - Whether the current surface owns an open modal interaction.
 * @returns Platform-neutral event facts consumed by selection and action registries.
 */
export function createTaskSurfaceKeyboardInput(
  event: KeyboardEvent,
  ownsModalInteraction = false,
): TaskActionKeyboardInput {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    isComposing: event.isComposing,
    isEditableTarget: isTaskSurfaceKeyboardGuardedTarget(event.target),
    isModalOpen: ownsModalInteraction || hasOpenTaskSurfaceKeyboardModal(),
    key: event.key,
    metaKey: event.metaKey,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
  }
}

/**
 * Reports whether native editing or activation must retain ownership of a keyboard event.
 *
 * @param target - Browser event target.
 * @returns Whether task navigation and action shortcuts must ignore the event.
 */
export function isTaskSurfaceKeyboardGuardedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || Boolean(target.closest(
    'input, textarea, select, button, a, [contenteditable="true"], [role="button"]',
  ))
}

/**
 * Detects modal surfaces that own keyboard input outside a task surface's local state.
 *
 * @returns Whether an open dialog, ARIA modal, or registered task modal is mounted.
 */
export function hasOpenTaskSurfaceKeyboardModal(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(
    'dialog[open], [role="dialog"][aria-modal="true"], [data-task-keyboard-modal="true"]',
  ) !== null
}

/**
 * Formats a registry shortcut into the canonical context diagnostic value.
 *
 * @param shortcut - Platform-neutral registered shortcut.
 * @returns Stable modifier and key chord.
 */
export function formatTaskSurfaceKeyboardShortcut(shortcut: TaskActionShortcut): string {
  return createTaskActionShortcutChord(shortcut)
}
