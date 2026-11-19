import { useState } from 'react'
import type { TeamIssue } from '../api/workItems'
import { resolveIssueTitle } from '../model/teamIssueDisplay'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'

/** Props of the archived Work Item list. */
export type ArchivedWorkItemsPanelProps = {
  /** Archived Work Items, newest archive first; undefined until the first read finishes. */
  workItems?: TeamIssue[]
  /** Whether the list is being read. */
  isLoading: boolean
  /** Message shown when the list could not be read. */
  errorMessage?: string
  /** Whether the disclosure starts open, for stories. */
  defaultOpen?: boolean
  /** Locale used to format archive times. */
  locale: Locale
  /** Work Item whose restore is running. */
  restoringWorkItemId?: string
  /** Message shown when the last restore failed. */
  restoreErrorMessage?: string
  /** Whether the viewer may restore this Work Item; restore is hidden otherwise. */
  canRestore: (workItem: TeamIssue) => boolean
  /** Reports that the disclosure opened or closed, so the list is read only while shown. */
  onOpenChange: (open: boolean) => void
  /** Reads the list again after an error. */
  onRetry: () => void
  /** Restores one archived Work Item; undefined when the viewer may restore none. */
  onRestore?: (workItem: TeamIssue) => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Lists the archived Work Items of a Team or Project, closed until the viewer opens it.
 *
 * @param props - Archived Work Items, read state, restore state, and callbacks.
 * @returns The disclosure panel.
 */
export function ArchivedWorkItemsPanel({
  workItems,
  isLoading,
  errorMessage,
  defaultOpen = false,
  locale,
  restoringWorkItemId,
  restoreErrorMessage,
  canRestore,
  onOpenChange,
  onRetry,
  onRestore,
  t,
}: ArchivedWorkItemsPanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <details
      className="workbench-panel grid gap-3 px-4 py-3"
      data-testid="archived-work-items"
      open={isOpen}
      onToggle={(event) => {
        const open = event.currentTarget.open
        setIsOpen(open)
        onOpenChange(open)
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-text)]">
        {t('issues.archive.listTitle')}
      </summary>
      <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">
        {t('issues.archive.listDescription')}
      </p>
      {restoreErrorMessage ? (
        <p className="mt-2 text-sm font-semibold text-fg-red-700" role="alert">{restoreErrorMessage}</p>
      ) : null}
      {errorMessage ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
          <p className="text-sm font-semibold text-fg-red-800">{errorMessage}</p>
          <button className="workbench-button-secondary min-h-8 px-3 text-xs" type="button" onClick={onRetry}>
            {t('issues.archive.retry')}
          </button>
        </div>
      ) : isLoading && !workItems ? (
        <p className="mt-2 text-sm font-semibold text-[var(--workbench-muted)]">{t('issues.archive.loading')}</p>
      ) : workItems && workItems.length === 0 ? (
        <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('issues.archive.empty')}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {(workItems ?? []).map((workItem) => {
            const title = resolveIssueTitle(workItem, t)
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-3 py-2"
                data-testid={`archived-work-item-${workItem.id}`}
                key={`${workItem.teamId}:${workItem.id}`}
              >
                <div className="grid min-w-0 gap-0.5">
                  <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">
                    {workItem.key ? `${workItem.key} ` : ''}{title}
                  </p>
                  <p className="text-xs font-medium text-[var(--workbench-muted)]">
                    {t('issues.archive.archivedAt').replace(
                      '{date}',
                      workItem.archivedAt ? dateFormat.format(new Date(workItem.archivedAt)) : '',
                    )}
                  </p>
                </div>
                {onRestore && canRestore(workItem) ? (
                  <button
                    aria-label={`${t('issues.archive.restore')}: ${title}`}
                    className="workbench-button-secondary min-h-8 px-3 text-xs"
                    disabled={restoringWorkItemId !== undefined}
                    type="button"
                    onClick={() => onRestore(workItem)}
                  >
                    {restoringWorkItemId === workItem.id
                      ? t('issues.archive.restoring')
                      : t('issues.archive.restore')}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </details>
  )
}
