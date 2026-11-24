import type { FocusProjectLogEntry, ProjectRaidEntryKind, ProjectRaidSeverity } from '@mukuroji/contracts'
import { Link } from 'react-router'
import type { MessageKey } from '../../../shared/i18n/i18n'

/** Props for the Project log entries the current viewer owns. */
export type FocusProjectLogEntriesProps = {
  /** Entries in server order: most severe first. */
  entries: readonly FocusProjectLogEntry[]
  /** Whether the log of at least one Project could not be read, so entries may be missing. */
  incomplete?: boolean
  /** Reloads the Focus queue after a failed Project log read. */
  onRetry?: () => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Message keys of each entry kind. */
const kindMessageKeys: Record<ProjectRaidEntryKind, MessageKey> = {
  risk: 'projects.raidLog.kind.risk',
  issue: 'projects.raidLog.kind.issue',
  'change-request': 'projects.raidLog.kind.changeRequest',
}

/** Message keys of each severity. */
const severityMessageKeys: Record<ProjectRaidSeverity, MessageKey> = {
  low: 'projects.raidLog.severity.low',
  medium: 'projects.raidLog.severity.medium',
  high: 'projects.raidLog.severity.high',
  critical: 'projects.raidLog.severity.critical',
}

/**
 * Lists the risks and issues the viewer owns whose review is overdue and the change requests
 * waiting for the viewer's decision, each with what makes it disappear.
 *
 * When some Project logs could not be read, the panel says so with a retry, even with no entries,
 * so missing obligations are not mistaken for none.
 *
 * @param props - Entries, read state, retry, and localized copy.
 * @returns A compact panel, or null when nothing needs attention and every log was read.
 */
export function FocusProjectLogEntries({ entries, incomplete = false, onRetry, t }: FocusProjectLogEntriesProps) {
  if (entries.length === 0 && !incomplete) return null
  return (
    <section
      aria-labelledby="focus-project-log-title"
      className="workbench-panel overflow-hidden"
      data-testid="focus-project-log"
    >
      <div className="flex items-center justify-between gap-3 bg-[var(--workbench-surface-muted)] px-4 py-2 text-xs font-bold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        <h3 id="focus-project-log-title">{t('workspace.focus.projectLog.title')}</h3>
        <span className="tabular-nums">{entries.length}</span>
      </div>
      {incomplete ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4 py-3"
          data-testid="focus-project-log-incomplete"
          role="alert"
        >
          <p className="text-app-body font-semibold text-[var(--workbench-danger)]">
            {t('workspace.focus.projectLog.incomplete')}
          </p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
              {t('workspace.focus.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      <ul className="divide-y divide-[var(--workbench-border)]">
        {entries.map((entry) => (
          <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid="focus-project-log-entry" key={entry.id}>
            <span className="grid min-w-0 gap-0.5">
              <Link
                className="break-words text-app-body font-semibold text-[var(--workbench-text)] underline-offset-4 hover:underline"
                to={entry.deepLink}
              >
                {entry.title}
              </Link>
              <span className="text-app-caption text-[var(--workbench-muted)]">
                {[
                  t(kindMessageKeys[entry.kind]),
                  `${t('projects.raidLog.field.severity')}: ${t(severityMessageKeys[entry.severity])}`,
                  entry.projectTitle,
                  entry.reason === 'review-overdue' && entry.reviewDueDate
                    ? t('projects.raidLog.reviewDue').replace('{date}', entry.reviewDueDate)
                    : undefined,
                ].filter((part) => part !== undefined && part !== '').join(' · ')}
              </span>
              <span className="text-app-caption text-[var(--workbench-muted)]">
                {t(entry.reason === 'review-overdue'
                  ? 'workspace.focus.projectLog.resolvesReview'
                  : 'workspace.focus.projectLog.resolvesDecision')}
              </span>
            </span>
            <span
              className={`shrink-0 border-l-4 px-2 text-app-meta font-semibold ${
                entry.reason === 'review-overdue'
                  ? 'border-[var(--workbench-danger)] text-[var(--workbench-danger)]'
                  : 'border-[var(--workbench-primary)] text-[var(--workbench-primary-text)]'
              }`}
            >
              {t(entry.reason === 'review-overdue'
                ? 'workspace.focus.projectLog.reviewOverdue'
                : 'workspace.focus.projectLog.decisionPending')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
