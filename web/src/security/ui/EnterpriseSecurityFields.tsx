import type { MessageKey } from '../../shared/i18n/i18n'
import type { EnterpriseSsoPrerequisites } from '../model/enterpriseSecurityReadiness'

/**
 * Renders a boolean security setting with its explanatory copy.
 *
 * @param props - Toggle state, labels, and change handler.
 * @returns The security toggle field.
 */
export function SecurityToggle({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  description: string
  disabled: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-w-0 items-start gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
      <input
        checked={checked}
        className="mt-0.5 h-5 w-5 flex-none accent-[var(--workbench-primary)]"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[var(--workbench-text)]">
          {label}
        </span>
        <span className="mt-1 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {description}
        </span>
      </span>
    </label>
  )
}

/**
 * Renders a bounded numeric security field with an explicit unit.
 *
 * @param props - Numeric constraints, display copy, and change handler.
 * @returns The security number field.
 */
export function SecurityNumberField({
  description,
  disabled,
  label,
  max,
  min,
  unit,
  value,
  onChange,
}: {
  description: string
  disabled: boolean
  label: string
  max: number
  min: number
  unit: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="grid gap-2 rounded-lg border border-[var(--workbench-border)] p-4 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <span className="flex min-w-0 overflow-hidden rounded-md border border-[var(--workbench-border)] bg-white focus-within:border-[var(--workbench-primary)]">
        <input
          className="min-h-10 min-w-0 flex-1 border-0 bg-transparent px-3 outline-none"
          disabled={disabled}
          max={max}
          min={min}
          required
          type="number"
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="grid flex-none place-items-center border-l border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-xs font-semibold text-[var(--workbench-muted)]">
          {unit}
        </span>
      </span>
      <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {description}
      </span>
    </label>
  )
}

/**
 * Renders the shared heading used by enterprise security sections.
 *
 * @param props - Section title, description, and optional badge.
 * @returns The section header.
 */
export function EnterpriseSecuritySectionHeader({
  badge,
  description,
  title,
}: {
  badge?: string
  description: string
  title: string
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 bg-[var(--workbench-surface-muted)] px-4 py-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {title}
        </h3>
        <p className="mt-1 max-w-[760px] text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {description}
        </p>
      </div>
      {badge ? <span className="workbench-badge">{badge}</span> : null}
    </div>
  )
}

/**
 * Renders the standard read-only capability notice.
 *
 * @param props - The i18n resolver used for the notice.
 * @returns The read-only status notice.
 */
export function EnterpriseSecurityReadOnlyNotice({
  t,
}: {
  t: (key: MessageKey) => string
}) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700"
      role="status"
    >
      {t('security.readOnly')}
    </div>
  )
}

/**
 * Renders a compact semantic status badge.
 *
 * @param props - Badge label and visual tone.
 * @returns The status badge.
 */
export function EnterpriseSecurityStatusBadge({
  label,
  tone,
}: {
  label: string
  tone: 'danger' | 'neutral' | 'success' | 'warning'
}) {
  const toneClassNames: Record<
    'danger' | 'neutral' | 'success' | 'warning',
    string
  > = {
    danger: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-slate-200 bg-slate-50 text-slate-600',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
  }

  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClassNames[tone]}`}
    >
      {label}
    </span>
  )
}

/**
 * Renders a definition-list value used by security summary cards.
 *
 * @param props - Definition label, value, and code formatting flag.
 * @returns The definition item.
 */
export function EnterpriseSecurityDefinition({
  code = false,
  label,
  value,
}: {
  code?: boolean
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        {label}
      </dt>
      <dd className="mt-2 break-all text-sm font-semibold leading-6 text-[var(--workbench-text)]">
        {code ? <code>{value}</code> : value}
      </dd>
    </div>
  )
}

/**
 * Renders the shared empty-state copy used by security lists.
 *
 * @param props - Empty-state text.
 * @returns The empty-state paragraph.
 */
export function EnterpriseSecurityEmptyState({ text }: { text: string }) {
  return (
    <p className="px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
      {text}
    </p>
  )
}

/**
 * Renders the SSO enforcement prerequisite checklist.
 *
 * @param props - Resolved prerequisite state and i18n resolver.
 * @returns The prerequisite checklist.
 */
export function EnterpriseSsoPrerequisiteList({
  prerequisites,
  t,
}: {
  prerequisites: EnterpriseSsoPrerequisites
  t: (key: MessageKey) => string
}) {
  const items: readonly [boolean, MessageKey][] = [
    [
      prerequisites.identityProviderVerified,
      'security.prerequisite.identity',
    ],
    [prerequisites.verifiedDomain, 'security.prerequisite.domain'],
    [prerequisites.breakGlassReady, 'security.prerequisite.breakGlass'],
  ]

  return (
    <ul className="mt-4 grid gap-2">
      {items.map(([complete, labelKey]) => (
        <li
          className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-3"
          key={labelKey}
        >
          <span
            aria-hidden="true"
            className={`grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-bold ${
              complete
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {complete ? '✓' : '!'}
          </span>
          <span className="text-sm font-semibold text-[var(--workbench-text)]">
            {t(labelKey)}
          </span>
          <span className="ml-auto text-xs font-semibold text-[var(--workbench-muted)]">
            {t(
              complete
                ? 'security.prerequisite.complete'
                : 'security.prerequisite.incomplete',
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
