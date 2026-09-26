import type { MessageKey } from '../i18n/i18n'

/**
 * Visual tones supported by a Workbench metric card.
 */
export type MetricCardTone = 'amber' | 'teal' | 'emerald' | 'red'

/**
 * Props for a Workbench metric card.
 */
export type MetricCardProps = {
  /** Textual value exposed to assistive technology when the visual value is symbolic. */
  srValue?: string
  /** Label that describes the displayed metric. */
  label: string
  /** Optional test identifier for the metric card. */
  testId?: string
  /** Visual tone used for the metric value. */
  tone: MetricCardTone
  /** Metric value rendered in the card. */
  value: number | string
}

/**
 * Renders a compact summary metric used by Workbench views.
 *
 * @param props - Metric label, value, tone, and optional test identifier.
 * @returns A styled metric card.
 */
export function MetricCard({
  label,
  srValue,
  testId,
  tone,
  value,
}: MetricCardProps) {
  const toneClassNames: Record<MetricCardTone, string> = {
    amber: 'bg-amber-600',
    teal: 'bg-[var(--workbench-primary)]',
    emerald: 'bg-emerald-600',
    red: 'bg-red-600',
  }

  return (
    <section
      className="min-w-0 rounded-lg border border-[var(--workbench-border)] bg-white p-4 sm:p-5"
      data-testid={testId}
    >
      <p className="flex items-center gap-2 text-xs font-medium text-[var(--workbench-muted)]">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneClassNames[tone]}`} />
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold leading-none tracking-tight text-[var(--workbench-text)] tabular-nums">
        {srValue ? <span aria-hidden="true">{value}</span> : value}
        {srValue ? <span className="sr-only">{srValue}</span> : null}
      </p>
    </section>
  )
}

/**
 * Props for a Workbench section header.
 */
export type SectionHeaderProps = {
  /** Optional contextual metadata shown beside the title. */
  meta?: string
  /** Section title. */
  title: string
}

/**
 * Renders a consistent title row for Workbench panels and tables.
 *
 * @param props - Section title and optional metadata.
 * @returns A Workbench section header.
 */
export function SectionHeader({ meta, title }: SectionHeaderProps) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{title}</h2>
      {meta ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{meta}</p> : null}
    </div>
  )
}

/**
 * Props for a Workbench progress bar.
 */
export type ProgressBarProps = {
  /** Accessible name describing the value represented by the progress bar. */
  label: string
  /** Progress value normalized to the inclusive range from zero to one hundred. */
  value: number
}

/**
 * Renders an accessible percentage progress bar.
 *
 * @param props - Accessible label and progress value.
 * @returns A normalized progress bar.
 */
export function ProgressBar({ label, value }: ProgressBarProps) {
  const normalizedValue = Math.max(0, Math.min(100, value))

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={normalizedValue}
      aria-valuetext={`${normalizedValue}%`}
      className="h-2 overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
    >
      <div
        aria-hidden="true"
        className="h-full rounded-full bg-[var(--workbench-primary)]"
        style={{ width: `${normalizedValue}%` }}
      />
    </div>
  )
}

/**
 * A translated title and description pair displayed by an information grid.
 */
export type InfoGridItem = readonly [
  /** Translation key rendered as the information card title. */
  titleKey: MessageKey,
  /** Translation key rendered as the information card description. */
  descriptionKey: MessageKey,
]

/**
 * Props for a translated Workbench information grid.
 */
export type InfoGridProps = {
  /** Translation key pairs rendered as information cards. */
  items: readonly InfoGridItem[]
  /** Translator used for card titles and descriptions. */
  t: (key: MessageKey) => string
}

/**
 * Renders translated title and description pairs as responsive information cards.
 *
 * @param props - Translation key pairs and translator.
 * @returns A responsive grid of information cards.
 */
export function InfoGrid({ items, t }: InfoGridProps) {
  return (
    <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
      {items.map(([titleKey, descriptionKey]) => (
        <section
          className="border-t border-[var(--workbench-border)] py-5"
          key={titleKey}
        >
          <h2 className="text-base font-semibold text-[var(--workbench-text)]">{t(titleKey)}</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--workbench-muted)]">
            {t(descriptionKey)}
          </p>
        </section>
      ))}
    </div>
  )
}
