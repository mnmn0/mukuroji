import type { FocusUpdateDeadline } from '@mukuroji/contracts'
import { Link } from 'react-router'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { focusUpdateTargetLabelKey, formatFocusTimestamp } from '../model/focusQueue'

/** Props for the health update deadlines owned by the current viewer. */
export type FocusUpdateDeadlinesProps = {
  /** Deadlines in server order: overdue first, then by due time. */
  deadlines: readonly FocusUpdateDeadline[]
  /** Current application locale used for due timestamps. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Lists the health updates the viewer must publish soon or has missed.
 *
 * @param props - Deadlines, locale, and localized copy.
 * @returns A compact panel, or null when nothing is due.
 */
export function FocusUpdateDeadlines({ deadlines, locale, t }: FocusUpdateDeadlinesProps) {
  if (deadlines.length === 0) return null
  return (
    <section
      aria-labelledby="focus-update-deadlines-title"
      className="workbench-panel overflow-hidden"
    >
      <div className="flex items-center justify-between gap-3 bg-[var(--workbench-surface-muted)] px-4 py-2 text-xs font-bold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        <h3 id="focus-update-deadlines-title">{t('workspace.focus.updateDeadlines.title')}</h3>
        <span className="tabular-nums">{deadlines.length}</span>
      </div>
      <ul className="divide-y divide-[var(--workbench-border)]">
        {deadlines.map((deadline) => (
          <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={deadline.id}>
            <span className="grid min-w-0 gap-0.5">
              <Link
                className="break-words text-app-body font-semibold text-[var(--workbench-text)] underline-offset-4 hover:underline"
                to={deadline.deepLink}
              >
                {deadline.title ?? t(focusUpdateTargetLabelKey(deadline.target))}
              </Link>
              <span className="text-app-caption text-[var(--workbench-muted)]">
                {t('workspace.focus.updateDeadlines.dueAt').replace(
                  '{time}',
                  formatFocusTimestamp(deadline.dueAt, locale),
                )}
                {' · '}
                {t('workspace.focus.updateDeadlines.resolves')}
              </span>
            </span>
            <span
              className={`shrink-0 border-l-4 px-2 text-app-meta font-semibold ${
                deadline.state === 'overdue'
                  ? 'border-[var(--workbench-danger)] text-[var(--workbench-danger)]'
                  : 'border-[var(--workbench-primary)] text-[var(--workbench-primary-text)]'
              }`}
            >
              {t(deadline.state === 'overdue'
                ? 'workspace.focus.updateDeadlines.overdue'
                : 'workspace.focus.updateDeadlines.dueSoon')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
