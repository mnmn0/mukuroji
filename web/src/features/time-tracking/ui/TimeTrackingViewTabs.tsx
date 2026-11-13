import type { TimeTrackingTranslator } from './timeTrackingText'

/** View of the Team time tracking page. */
export type TimeTrackingView = 'timesheet' | 'approvals'

/** Props of the time tracking view switcher. */
export type TimeTrackingViewTabsProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Selected view. */
  view: TimeTrackingView
  /** Builds the link of a view, so each view has its own URL. */
  getHref: (view: TimeTrackingView) => string
  /** Opens a view without a full page load. */
  onSelect: (view: TimeTrackingView) => void
}

/**
 * Switches between the member's timesheet and the manager's approval queue.
 *
 * @param props - Selected view and navigation.
 * @returns View links.
 */
export function TimeTrackingViewTabs({ getHref, onSelect, t, view }: TimeTrackingViewTabsProps) {
  const views: { id: TimeTrackingView; label: string }[] = [
    { id: 'timesheet', label: t('timeTracking.view.timesheet') },
    { id: 'approvals', label: t('timeTracking.view.approvals') },
  ]
  return (
    <nav aria-label={t('timeTracking.view.navigation')} className="flex min-w-0 gap-1 border-b border-[var(--workbench-border)]">
      {views.map((candidate) => (
        <a
          aria-current={candidate.id === view ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${candidate.id === view ? 'border-[var(--workbench-primary)] text-[var(--workbench-text)]' : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'}`}
          href={getHref(candidate.id)}
          key={candidate.id}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
            event.preventDefault()
            onSelect(candidate.id)
          }}
        >
          {candidate.label}
        </a>
      ))}
    </nav>
  )
}
