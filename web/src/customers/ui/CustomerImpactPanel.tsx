import type { CustomerImpactSignal } from '@mukuroji/contracts'
import { useId } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for the compact Customer impact summary shown beside a Work Item. */
export type CustomerImpactPanelProps = {
  /** Aggregated Customer Request impact for the current Work Item or Project. */
  signal: CustomerImpactSignal
  /** Translator for the Customer domain labels. */
  t: (key: MessageKey) => string
}

/** Renders an explainable Customer impact signal without mutating Work Item priority. */
export function CustomerImpactPanel({ signal, t }: CustomerImpactPanelProps) {
  const headingId = useId()
  const signalClassName = signal.prioritySignal === 'critical'
    ? 'border-red-200 bg-red-50 text-red-700'
    : signal.prioritySignal === 'high'
      ? 'border-orange-200 bg-orange-50 text-orange-700'
      : signal.prioritySignal === 'watch'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] text-[var(--workbench-muted)]'

  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 border-b border-[var(--workbench-border)] bg-white px-5 py-5"
      data-testid="customer-impact-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-[var(--workbench-text)]" id={headingId}>
            {t('customers.detail.impact')}
          </h2>
          <p className="mt-1 text-sm text-[var(--workbench-muted)]">
            {t('customers.detail.impactSummary')
              .replace('{customers}', String(signal.customerCount))
              .replace('{requests}', String(signal.requestCount))}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${signalClassName}`}>
          {t('customers.detail.impactSignal').replace('{signal}', signal.prioritySignal)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <ImpactMetric
          label={t('customers.openRequests')}
          value={String(signal.openRequestCount)}
        />
        <ImpactMetric
          label={t('customers.businessValue')}
          value={signal.highestBusinessValue === undefined
            ? '—'
            : String(signal.highestBusinessValue)}
        />
      </dl>

      {signal.customers.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('customers.detail.impactCustomers')}
          </h3>
          <ul className="grid gap-2">
            {signal.customers.map((customer) => (
              <li
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--workbench-border)] px-3 py-2"
                key={customer.customerId}
              >
                <span className="min-w-0 truncate text-sm font-semibold text-[var(--workbench-text)]">
                  {customer.name}
                </span>
                <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                  {t('customers.requestCount').replace('{count}', String(customer.requestCount))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {signal.requests.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('customers.detail.impactRequests')}
          </h3>
          <ul className="grid gap-2">
            {signal.requests.map((request) => (
              <li
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--workbench-border)] px-3 py-2 text-xs"
                key={request.requestId}
              >
                <span className="min-w-0 truncate font-semibold text-[var(--workbench-text)]">
                  {request.requestId}
                </span>
                <span className="font-semibold text-[var(--workbench-muted)]">
                  {request.status} · {request.importance}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

/** Renders one compact impact statistic. */
function ImpactMetric({ label, value }: {
  /** Metric label. */
  label: string
  /** Formatted metric value. */
  value: string
}) {
  return (
    <div className="rounded-md bg-[var(--workbench-surface-muted)] px-3 py-2">
      <dt className="text-xs text-[var(--workbench-muted)]">{label}</dt>
      <dd className="mt-1 font-semibold text-[var(--workbench-text)]">{value}</dd>
    </div>
  )
}
