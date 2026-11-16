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
