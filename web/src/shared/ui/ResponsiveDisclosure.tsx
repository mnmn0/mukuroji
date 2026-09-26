import { useId, useState, type ReactNode } from 'react'
import { ChevronIcon, SlidersIcon } from './icons'

/** Props for secondary controls that remain expanded on desktop. */
type ResponsiveDisclosureProps = {
  /** Controls retained in the same DOM subtree when the panel is collapsed. */
  children: ReactNode
  /** Localized name of the controls, including active-filter context when relevant. */
  label: string
  /** Optional short summary that stays visible while the controls are collapsed. */
  summary?: string
}

/**
 * Keeps secondary controls available without displacing primary content on phones.
 *
 * @param props - Localized disclosure copy and the controls to reveal.
 * @returns A keyboard-operable phone disclosure with always-visible desktop content.
 */
export function ResponsiveDisclosure({ children, label, summary }: ResponsiveDisclosureProps) {
  const contentId = useId()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="min-w-0">
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="flex min-h-[44px] w-full items-center gap-2 text-left text-sm font-semibold text-[var(--workbench-text)] min-[761px]:hidden"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <SlidersIcon className="h-4 w-4 shrink-0 fill-none stroke-current stroke-2 text-[var(--workbench-primary)]" />
        <span className="min-w-0 flex-1">
          <span className="block">{label}</span>
          {summary ? <span className="mt-0.5 block text-xs font-normal text-[var(--workbench-muted)]">{summary}</span> : null}
        </span>
        <ChevronIcon className={`h-4 w-4 shrink-0 fill-none stroke-current stroke-2 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <div className={expanded ? 'min-w-0 pt-3 min-[761px]:pt-0' : 'hidden min-w-0 min-[761px]:block'} id={contentId}>
        {children}
      </div>
    </div>
  )
}
