import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

/** Tab of the selected Planning entity's detail. */
export type PlanningEntityDetailTab = 'details' | 'activity'

/** Localized text of the detail tabs. */
export type PlanningEntityDetailTabsLabels = {
  /** Accessible name of the tab list. */
  tabs: string
  /** Details tab, which holds the editor. */
  details: string
  /** Activity tab, which holds the change history. */
  activity: string
}

/** Props of {@link PlanningEntityDetailTabs}. */
export type PlanningEntityDetailTabsProps = {
  /** Localized text. */
  labels: PlanningEntityDetailTabsLabels
  /** Content of the details tab. */
  details: ReactNode
  /** Renders the activity tab; called only while the tab is open, so its data loads on demand. */
  renderActivity: () => ReactNode
  /** Tab open at first, for stories. */
  defaultTab?: PlanningEntityDetailTab
}

const detailTabs: readonly PlanningEntityDetailTab[] = ['details', 'activity']

/**
 * Switches the selected entity's detail between the editor and its activity.
 *
 * @param props - Tab content and localized text.
 * @returns The tab list and the open tab's panel.
 */
export function PlanningEntityDetailTabs({
  defaultTab = 'details',
  details,
  labels,
  renderActivity,
}: PlanningEntityDetailTabsProps) {
  const [tab, setTab] = useState<PlanningEntityDetailTab>(defaultTab)
  const baseId = useId()
  const tabRefs = useRef<Partial<Record<PlanningEntityDetailTab, HTMLButtonElement | null>>>({})
  /** Moves between tabs with the arrow, Home and End keys. */
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: PlanningEntityDetailTab) => {
    const index = detailTabs.indexOf(current)
    const next = event.key === 'ArrowRight'
      ? detailTabs[(index + 1) % detailTabs.length]
      : event.key === 'ArrowLeft'
        ? detailTabs[(index - 1 + detailTabs.length) % detailTabs.length]
        : event.key === 'Home'
          ? detailTabs[0]
          : event.key === 'End'
            ? detailTabs[detailTabs.length - 1]
            : undefined
    if (!next) return
    event.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }
  return (
    <div className="grid gap-3" data-testid="planning-entity-detail">
      <div aria-label={labels.tabs} className="flex gap-1 border-b border-[var(--workbench-border)]" role="tablist">
        {detailTabs.map((value) => (
          <button
            aria-controls={tab === value ? `${baseId}-${value}-panel` : undefined}
            aria-selected={tab === value}
            className={`-mb-px min-h-9 border-b-2 px-3 text-sm font-semibold ${tab === value
              ? 'border-tone-6fbfb4 text-[var(--workbench-text)]'
              : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'}`}
            data-testid={`planning-entity-detail-tab-${value}`}
            id={`${baseId}-${value}-tab`}
            key={value}
            ref={(element) => {
              tabRefs.current[value] = element
            }}
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            type="button"
            onClick={() => setTab(value)}
            onKeyDown={(event) => handleKeyDown(event, value)}
          >
            {labels[value]}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${baseId}-${tab}-tab`}
        id={`${baseId}-${tab}-panel`}
        role="tabpanel"
      >
        {tab === 'details' ? details : (
          <section className="workbench-panel grid gap-4 p-5">
            {renderActivity()}
          </section>
        )}
      </div>
    </div>
  )
}
