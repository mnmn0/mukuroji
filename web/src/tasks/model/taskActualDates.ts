import {
  applyWorkItemStatusTransitionToActualDates,
  type CanonicalWorkItem,
  type WorkItemPatch,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Translator accepted by the plan-versus-actual formatters. */
type TaskActualDateTranslator = (key: MessageKey) => string

/** Visual tone of a plan-versus-actual delay. */
export type TaskScheduleVarianceTone = 'late' | 'early' | 'on-time'

/**
 * Formats a signed delay in calendar days as a short localized label.
 *
 * @param days - Positive when late, negative when early, or undefined without both dates.
 * @param t - Translator used for the label.
 * @returns A label such as "3 days late", or an em dash when the delay is unknown.
 */
export function formatTaskScheduleVariance(
  days: number | undefined,
  t: TaskActualDateTranslator,
): string {
  if (days === undefined) return '—'
  if (days === 0) return t('tasks.variance.onTime')
  return t(days > 0 ? 'tasks.variance.late' : 'tasks.variance.early')
    .replace('{days}', String(Math.abs(days)))
}

/**
 * Resolves the visual tone of a signed delay.
 *
 * @param days - Positive when late, negative when early, or undefined without both dates.
 * @returns The tone, or undefined when the delay is unknown.
 */
export function resolveTaskScheduleVarianceTone(
  days: number | undefined,
): TaskScheduleVarianceTone | undefined {
  if (days === undefined) return undefined
  if (days > 0) return 'late'
  return days < 0 ? 'early' : 'on-time'
}

/** Text color classes for each delay tone, shared by the table, detail pane, and Gantt. */
export const taskScheduleVarianceToneClasses: Record<TaskScheduleVarianceTone, string> = {
  late: 'text-fg-red-700',
  early: 'text-fg-505967',
  'on-time': 'text-fg-505967',
}

/** How an undo restores the actual dates that a status change recorded or removed. */
export type TaskActualDateUndo =
  | {
    /** Whether the undo can return the Work Item to its earlier actual dates. */
    reversible: true
    /** Explicit dates to add to the inverse patch, when the reverse transition alone is not enough. */
    patch?: Pick<WorkItemPatch, 'actualStartDate' | 'actualEndDate'>
  }
  | {
    /** Whether the undo can return the Work Item to its earlier actual dates. */
    reversible: false
  }

/**
 * Decides how an undo restores the actual dates around one update.
 *
 * The server records actual dates from status transitions. Reversing a reopen would record today
 * as the completion, and reversing a first start would keep the start, so the reverse transition
 * alone may not restore the earlier dates. A user who may correct actual dates gets an explicit
 * correction in the inverse patch. Anyone else gets no undo when it would lose a recorded
 * completion.
 *
 * @param before - Work Item before the update.
 * @param after - Work Item returned by the update.
 * @param patch - Forward patch; its own actual date corrections are reversed by the inverse patch.
 * @param canCorrectActualDates - Whether the current user may correct actual dates.
 * @param today - Current local date in the Work Item's calendar timezone.
 * @returns Whether the update stays undoable and any dates to restore explicitly.
 */
export function resolveTaskActualDateUndo(
  before: CanonicalWorkItem,
  after: CanonicalWorkItem,
  patch: Pick<WorkItemPatch, 'actualStartDate' | 'actualEndDate'>,
  canCorrectActualDates: boolean,
  today: string,
): TaskActualDateUndo {
  if (patch.actualStartDate !== undefined || patch.actualEndDate !== undefined) {
    return { reversible: true }
  }
  const reversed = applyWorkItemStatusTransitionToActualDates(
    {
      ...(after.actualStartDate ? { actualStartDate: after.actualStartDate } : {}),
      ...(after.actualEndDate ? { actualEndDate: after.actualEndDate } : {}),
    },
    after.statusCategory,
    before.statusCategory,
    today,
  )
  if (
    reversed.actualStartDate === before.actualStartDate &&
    reversed.actualEndDate === before.actualEndDate
  ) {
    return { reversible: true }
  }
  if (!canCorrectActualDates) {
    // Losing a recorded completion changes the completion delay, so that update gets no undo. A
    // start kept after undoing an accidental first start is harmless enough to keep undo for it.
    return { reversible: reversed.actualEndDate === before.actualEndDate }
  }
  return {
    reversible: true,
    patch: {
      actualStartDate: before.actualStartDate ?? null,
      actualEndDate: before.actualEndDate ?? null,
    },
  }
}
