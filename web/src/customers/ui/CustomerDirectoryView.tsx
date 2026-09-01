import { useState } from 'react'
import type {
  Customer,
  CustomerDetail,
  CustomerListInput,
  CustomerProjectSummary,
  CustomerSavedView,
  CustomerWorkItemSummary,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for the Customer directory and selected Customer detail view. */
export type CustomerDirectoryViewProps = {
  /** Customers returned by the current directory query. */
  customers: readonly Customer[]
  /** Whether sensitive Customer search and business-value controls are allowed. */
  canViewSensitiveData: boolean
  /** Whether Customer saved-view mutations are allowed. */
  canManageCustomerViews: boolean
  /** Selected Customer detail graph, when a route Customer is selected. */
  detail?: CustomerDetail
  /** Current URL-backed search value. */
  search: string
  /** Current URL-backed Customer filters and sort. */
  filters: CustomerListInput
  /** Current Customer grouping dimension. */
  groupBy?: CustomerSavedView['groupBy']
  /** Saved directory views available to this member. */
  savedViews: readonly CustomerSavedView[]
  /** Whether the directory or detail request is loading. */
  isLoading: boolean
  /** Whether another Customer page is available. */
  hasMoreCustomers: boolean
  /** Whether the next Customer page is loading. */
  isLoadingMoreCustomers: boolean
  /** User-facing load failure, when present. */
  errorMessage?: string
  /** Translator for all visible Customer copy. */
  t: (key: MessageKey) => string
  /** Locale used for received-date formatting. */
  locale: string
  /** Updates the URL-backed directory search. */
  onSearchChange: (value: string) => void
  /** Updates URL-backed Customer filters and sort. */
  onFiltersChange: (filters: CustomerListInput) => void
  /** Updates the URL-backed Customer grouping dimension. */
  onGroupByChange: (groupBy: CustomerSavedView['groupBy']) => void
  /** Applies one saved directory view to the current URL state. */
  onApplySavedView: (view: CustomerSavedView) => void
  /** Persists a new saved directory view from the current URL state. */
  onSaveView: (name: string) => void
  /** Whether a saved view mutation is in progress. */
  isSavingView: boolean
  /** User-facing saved-view mutation failure, when present. */
  saveViewError?: string
  /** Opens one Customer detail route. */
  onSelectCustomer: (customerId: string) => void
  /** Retries the failed query. */
  onRetry: () => void
  /** Loads exactly one additional Customer page. */
  onLoadMoreCustomers: () => void
  /** Opens one related Work Item. */
  onOpenWorkItem: (workItem: CustomerWorkItemSummary) => void
  /** Opens one related Project in searchable Project context. */
  onOpenProject: (project: CustomerProjectSummary) => void
}

/** Renders Customer discovery, account attributes, and source-to-work traceability.
 *
 * @param props Directory filters, data, permissions, and interaction callbacks.
 * @returns The Customer directory and selected detail view.
 */
export function CustomerDirectoryView({
  canManageCustomerViews,
  canViewSensitiveData,
  customers,
  detail,
  search,
  filters,
  groupBy,
  savedViews,
  isLoading,
  hasMoreCustomers,
  isLoadingMoreCustomers,
  errorMessage,
  t,
  locale,
  onSearchChange,
  onFiltersChange,
  onGroupByChange,
  onApplySavedView,
  onSaveView,
  isSavingView,
  saveViewError,
  onSelectCustomer,
  onRetry,
  onLoadMoreCustomers,
  onOpenWorkItem,
  onOpenProject,
}: CustomerDirectoryViewProps) {
  return (
    <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
      <div className="workbench-panel grid gap-4 p-4">
        {canViewSensitiveData ? (
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t('customers.searchLabel')}</span>
            <input
              aria-label={t('customers.searchLabel')}
              className="workbench-input min-h-11 w-full"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('customers.search')}
              type="search"
              value={search}
            />
          </label>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label={t('customers.filters.tier')}
            options={customerTierOptions}
            value={filters.tier}
            onChange={(value) => onFiltersChange({ ...filters, tier: value })}
            t={t}
          />
          <FilterSelect
            label={t('customers.filters.size')}
            options={customerSizeOptions}
            value={filters.size}
            onChange={(value) => onFiltersChange({ ...filters, size: value })}
            t={t}
          />
          <FilterSelect
            label={t('customers.filters.status')}
            options={customerStatusOptions}
            value={filters.status}
            onChange={(value) => onFiltersChange({ ...filters, status: value })}
            t={t}
          />
          <FilterSelect
            label={t('customers.filters.health')}
            options={customerHealthOptions}
            value={filters.health}
            onChange={(value) => onFiltersChange({ ...filters, health: value })}
            t={t}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {canViewSensitiveData ? (
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              <span>{t('customers.filters.minBusinessValue')}</span>
              <input
                className="workbench-input min-h-10 w-full"
                inputMode="numeric"
                min="0"
                max="100"
                onChange={(event) => onFiltersChange({
                  ...filters,
                  minBusinessValue: event.target.value ? Number(event.target.value) : undefined,
                })}
                type="number"
                value={filters.minBusinessValue ?? ''}
              />
            </label>
          ) : null}
          <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            <span>{t('customers.filters.minRequestCount')}</span>
            <input
              className="workbench-input min-h-10 w-full"
              inputMode="numeric"
              min="0"
              onChange={(event) => onFiltersChange({
                ...filters,
                minRequestCount: event.target.value && Number.isSafeInteger(Number(event.target.value))
                  ? Number(event.target.value)
                  : undefined,
              })}
              step="1"
              type="number"
              value={filters.minRequestCount ?? ''}
            />
          </label>
          <FilterSelect
            label={t('customers.filters.sortBy')}
            options={canViewSensitiveData ? customerSortOptions : customerSafeSortOptions}
            value={filters.sortBy ?? 'updatedAt'}
            onChange={(value) => onFiltersChange({ ...filters, sortBy: value })}
            t={t}
            includeEmpty={false}
          />
          <FilterSelect
            label={t('customers.filters.direction')}
            options={customerSortDirectionOptions}
            value={filters.sortDirection ?? 'descending'}
            onChange={(value) => onFiltersChange({ ...filters, sortDirection: value })}
            t={t}
            includeEmpty={false}
          />
          <FilterSelect
            label={t('customers.filters.groupBy')}
            options={customerGroupOptions}
            value={groupBy}
            onChange={onGroupByChange}
            t={t}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-[var(--workbench-border)] pt-3">
          <label className="grid min-w-[220px] flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            <span>{t('customers.filters.savedView')}</span>
            <select
              className="workbench-input min-h-10 w-full"
              value={savedViews.find((view) => matchesSavedView(view, filters, groupBy))?.id ?? ''}
              onChange={(event) => {
                const view = savedViews.find((candidate) => candidate.id === event.target.value)
                if (view) onApplySavedView(view)
              }}
            >
              <option value="">{t('customers.filters.chooseSavedView')}</option>
              {savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
          </label>
          {canManageCustomerViews ? (
            <SaveViewControl isSaving={isSavingView} onSave={onSaveView} t={t} />
          ) : null}
          {saveViewError ? <span className="text-sm font-semibold text-red-700" role="alert">{saveViewError}</span> : null}
          <span className="ml-auto text-sm font-semibold text-[var(--workbench-muted)]">
            {t('customers.requestCount').replace('{count}', String(customers.reduce((sum, customer) => sum + customer.requestCount, 0)))}
          </span>
        </div>
      </div>

      {errorMessage ? (
        <div className="grid justify-items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
          <p>{errorMessage}</p>
          <button className="workbench-button-secondary min-h-10 px-4" onClick={onRetry} type="button">
            {t('customers.retry')}
          </button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="workbench-panel p-8 text-sm font-semibold text-[var(--workbench-muted)]" role="status">
          {t('customers.loading')}
        </div>
      ) : (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.95fr)]">
          <section aria-labelledby="customer-directory-list-title" className="workbench-panel overflow-hidden">
            <div className="border-b border-[var(--workbench-border)] px-5 py-4">
              <h2 className="text-base font-bold text-[var(--workbench-text)]" id="customer-directory-list-title">
                {t('customers.title')}
              </h2>
            </div>
            {customers.length === 0 ? (
              <p className="p-8 text-sm font-semibold text-[var(--workbench-muted)]">
                {t('customers.empty')}
              </p>
            ) : (
              <div className="divide-y divide-[var(--workbench-border)]">
                {groupCustomers(customers, groupBy, t).map((group) => (
                  <div key={group.key}>
                    {groupBy ? <h3 className="bg-[var(--workbench-surface-muted)] px-5 py-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{group.label}</h3> : null}
                    {group.customers.map((customer) => (
                      <button
                        className={`grid w-full gap-3 px-5 py-4 text-left transition hover:bg-teal-50/60 ${detail?.customer.id === customer.id ? 'bg-teal-50' : ''}`}
                        key={customer.id}
                        onClick={() => onSelectCustomer(customer.id)}
                        type="button"
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold text-[var(--workbench-text)]">{customer.name}</span>
                            <span className="mt-1 block truncate text-xs text-[var(--workbench-muted)]">
                              {customer.domain ?? t('customers.noDomain')}
                            </span>
                          </span>
                          <CustomerBadge t={t} value={customer.health} />
                        </span>
                        <span className="flex flex-wrap gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                          <span>{t('customers.tier')}: {t(customerTierLabels[customer.tier])}</span>
                          <span>{t('customers.size')}: {t(customerSizeLabels[customer.size])}</span>
                          <span>{t('customers.requestCount').replace('{count}', String(customer.requestCount))}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {hasMoreCustomers ? (
              <div className="flex justify-center border-t border-[var(--workbench-border)] px-5 py-4">
                <button
                  className="workbench-button-secondary min-h-10 px-4"
                  disabled={isLoadingMoreCustomers}
                  onClick={onLoadMoreCustomers}
                  type="button"
                >
                  {isLoadingMoreCustomers ? t('customers.loadingMore') : t('customers.loadMore')}
                </button>
              </div>
            ) : null}
          </section>

          <CustomerDetailPanel
            detail={detail}
            locale={locale}
            onOpenProject={onOpenProject}
            onOpenWorkItem={onOpenWorkItem}
            t={t}
          />
        </div>
      )}
    </div>
  )
}

/** Renders the selected Customer graph without coupling it to HTTP state. */
function CustomerDetailPanel({
  detail,
  locale,
  onOpenProject,
  onOpenWorkItem,
  t,
}: {
  /** Selected Customer graph. */
  detail?: CustomerDetail
  /** Locale used to format dates. */
  locale: string
  /** Opens a related Project. */
  onOpenProject: (project: CustomerProjectSummary) => void
  /** Opens a related Work Item. */
  onOpenWorkItem: (workItem: CustomerWorkItemSummary) => void
  /** Translator for Customer copy. */
  t: (key: MessageKey) => string
}) {
  if (!detail) {
    return <aside className="workbench-panel p-8 text-sm font-semibold text-[var(--workbench-muted)]">{t('customers.select')}</aside>
  }

  const { customer, contacts, requests, workItems } = detail
  return (
    <aside className="grid content-start gap-5">
      <section className="workbench-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{t('customers.eyebrow')}</p>
            <h2 className="mt-2 text-xl font-bold text-[var(--workbench-text)]">{customer.name}</h2>
            <p className="mt-1 text-sm text-[var(--workbench-muted)]">{customer.domain ?? t('customers.noDomain')}</p>
          </div>
          <CustomerBadge t={t} value={customer.health} />
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <Metric label={t('customers.tier')} value={t(customerTierLabels[customer.tier])} />
          <Metric label={t('customers.size')} value={t(customerSizeLabels[customer.size])} />
          <Metric label={t('customers.status')} value={t(customerStatusLabels[customer.status])} />
          <Metric label={t('customers.businessValue')} value={customer.businessValue === undefined ? '—' : String(customer.businessValue)} />
          <Metric label={t('customers.contacts')} value={String(customer.contactCount)} />
          <Metric label={t('customers.openRequests')} value={String(customer.openRequestCount)} />
        </dl>
      </section>

      <section className="workbench-panel p-5">
        <h3 className="text-sm font-bold text-[var(--workbench-text)]">{t('customers.detail.contacts')}</h3>
        {contacts.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--workbench-muted)]">{t('customers.detail.noContacts')}</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {contacts.map((contact) => (
              <li className="rounded-lg border border-[var(--workbench-border)] px-3 py-2 text-sm" key={contact.id}>
                <span className="font-semibold text-[var(--workbench-text)]">{contact.name}</span>
                {contact.primary ? <span className="ml-2 text-xs font-semibold text-[var(--workbench-primary)]">{t('customers.detail.contactPrimary')}</span> : null}
                {contact.email ? <span className="mt-1 block text-xs text-[var(--workbench-muted)]">{contact.email}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workbench-panel p-5">
        <h3 className="text-sm font-bold text-[var(--workbench-text)]">{t('customers.detail.requests')}</h3>
        {requests.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--workbench-muted)]">{t('customers.detail.noRequests')}</p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {requests.map((request) => (
              <li className="rounded-lg border border-[var(--workbench-border)] p-3" key={request.id}>
                <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  <span>{t('customers.detail.requestReceived').replace('{date}', formatDate(request.receivedAt, locale))}</span>
                  <span>{t('customers.detail.status').replace('{status}', t(requestStatusLabels[request.status]))}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-sm text-[var(--workbench-text)]">
                  {request.originalMessage || t('customers.detail.messageUnavailable')}
                </p>
                <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t('customers.detail.importance').replace('{importance}', t(requestImportanceLabels[request.importance]))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workbench-panel p-5">
        <h3 className="text-sm font-bold text-[var(--workbench-text)]">{t('customers.detail.workItems')}</h3>
        {workItems.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--workbench-muted)]">{t('customers.detail.noWorkItems')}</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {workItems.map((workItem) => (
              <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-3 py-2" key={`${workItem.teamId}:${workItem.workItemId}`}>
                <span className="text-sm text-[var(--workbench-text)]">
                  <span className="font-semibold">{workItem.workItemId}</span>
                  <span className="ml-2 text-xs text-[var(--workbench-muted)]">{t(workItemLifecycleLabels[workItem.lifecycle])}</span>
                </span>
                <button className="workbench-button-secondary min-h-8 px-3 text-xs" onClick={() => onOpenWorkItem(workItem)} type="button">
                  {t('customers.detail.openWorkItem')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workbench-panel p-5">
        <h3 className="text-sm font-bold text-[var(--workbench-text)]">{t('customers.detail.projects')}</h3>
        {detail.projects.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--workbench-muted)]">{t('customers.detail.noProjects')}</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {detail.projects.map((project) => (
              <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-3 py-2" key={project.projectId}>
                <span className="text-sm text-[var(--workbench-text)]">
                  <span className="font-semibold">{project.projectId}</span>
                  <span className="ml-2 text-xs text-[var(--workbench-muted)]">{t('customers.requestCount').replace('{count}', String(project.requestCount))}</span>
                </span>
                <button className="workbench-button-secondary min-h-8 px-3 text-xs" onClick={() => onOpenProject(project)} type="button">
                  {t('customers.detail.openProject')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

/** Renders a compact Customer health badge. */
function CustomerBadge({ t, value }: { /** Translator for Customer labels. */ t: (key: MessageKey) => string; /** Customer health value. */ value: Customer['health'] }) {
  const className = value === 'critical' || value === 'at-risk'
    ? 'border-red-200 bg-red-50 text-red-700'
    : value === 'watch'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${className}`}>{t(customerHealthLabels[value])}</span>
}

/** Renders one detail metric without knowing the Customer transport shape. */
function Metric({ label, value }: { /** Metric label. */ label: string; /** Metric value. */ value: string }) {
  return <div className="rounded-lg bg-[var(--workbench-surface-muted)] px-3 py-2"><dt className="text-xs text-[var(--workbench-muted)]">{label}</dt><dd className="mt-1 font-semibold text-[var(--workbench-text)]">{value}</dd></div>
}

/** Formats one API ISO instant for a compact detail label. */
function formatDate(value: string, locale: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale)
}

/** Option rendered by a Customer filter select. */
type CustomerFilterOption<Value extends string> = {
  /** URL or view value represented by the option. */
  value: Value
  /** Message key for the option label. */
  labelKey: MessageKey
}

/** Customer tier options supported by the directory filter. */
const customerTierOptions = [
  { value: 'strategic', labelKey: 'customers.values.tier.strategic' },
  { value: 'enterprise', labelKey: 'customers.values.tier.enterprise' },
  { value: 'growth', labelKey: 'customers.values.tier.growth' },
  { value: 'standard', labelKey: 'customers.values.tier.standard' },
  { value: 'trial', labelKey: 'customers.values.tier.trial' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['tier']>>[]

/** Customer size options supported by the directory filter. */
const customerSizeOptions = [
  { value: 'startup', labelKey: 'customers.values.size.startup' },
  { value: 'small', labelKey: 'customers.values.size.small' },
  { value: 'mid-market', labelKey: 'customers.values.size.midMarket' },
  { value: 'enterprise', labelKey: 'customers.values.size.enterprise' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['size']>>[]

/** Customer lifecycle options supported by the directory filter. */
const customerStatusOptions = [
  { value: 'prospect', labelKey: 'customers.values.status.prospect' },
  { value: 'active', labelKey: 'customers.values.status.active' },
  { value: 'inactive', labelKey: 'customers.values.status.inactive' },
  { value: 'churned', labelKey: 'customers.values.status.churned' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['status']>>[]

/** Customer health options supported by the directory filter. */
const customerHealthOptions = [
  { value: 'healthy', labelKey: 'customers.values.health.healthy' },
  { value: 'watch', labelKey: 'customers.values.health.watch' },
  { value: 'at-risk', labelKey: 'customers.values.health.atRisk' },
  { value: 'critical', labelKey: 'customers.values.health.critical' },
  { value: 'unknown', labelKey: 'customers.values.health.unknown' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['health']>>[]

/** Customer sort options supported by the directory filter. */
const customerSortOptions = [
  { value: 'updatedAt', labelKey: 'customers.filters.sort.updatedAt' },
  { value: 'name', labelKey: 'customers.filters.sort.name' },
  { value: 'tier', labelKey: 'customers.filters.sort.tier' },
  { value: 'size', labelKey: 'customers.filters.sort.size' },
  { value: 'status', labelKey: 'customers.filters.sort.status' },
  { value: 'health', labelKey: 'customers.filters.sort.health' },
  { value: 'businessValue', labelKey: 'customers.filters.sort.businessValue' },
  { value: 'requestCount', labelKey: 'customers.filters.sort.requestCount' },
  { value: 'openRequestCount', labelKey: 'customers.filters.sort.openRequestCount' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['sortBy']>>[]

/** Customer sort options that do not require sensitive business-value access. */
const customerSafeSortOptions = customerSortOptions.filter((option) => option.value !== 'businessValue')

/** Customer sort-direction options supported by the directory filter. */
const customerSortDirectionOptions = [
  { value: 'descending', labelKey: 'customers.filters.direction.descending' },
  { value: 'ascending', labelKey: 'customers.filters.direction.ascending' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['sortDirection']>>[]

/** Customer grouping options supported by saved directory views. */
const customerGroupOptions = [
  { value: 'tier', labelKey: 'customers.filters.group.tier' },
  { value: 'size', labelKey: 'customers.filters.group.size' },
  { value: 'status', labelKey: 'customers.filters.group.status' },
  { value: 'health', labelKey: 'customers.filters.group.health' },
  { value: 'owner', labelKey: 'customers.filters.group.owner' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerSavedView['groupBy']>>[]

/** Localized labels for Customer commercial tiers. */
const customerTierLabels: Record<Customer['tier'], MessageKey> = {
  strategic: 'customers.values.tier.strategic',
  enterprise: 'customers.values.tier.enterprise',
  growth: 'customers.values.tier.growth',
  standard: 'customers.values.tier.standard',
  trial: 'customers.values.tier.trial',
}

/** Localized labels for Customer organization sizes. */
const customerSizeLabels: Record<Customer['size'], MessageKey> = {
  startup: 'customers.values.size.startup',
  small: 'customers.values.size.small',
  'mid-market': 'customers.values.size.midMarket',
  enterprise: 'customers.values.size.enterprise',
}

/** Localized labels for Customer lifecycle statuses. */
const customerStatusLabels: Record<Customer['status'], MessageKey> = {
  prospect: 'customers.values.status.prospect',
  active: 'customers.values.status.active',
  inactive: 'customers.values.status.inactive',
  churned: 'customers.values.status.churned',
}

/** Localized labels for Customer health values. */
const customerHealthLabels: Record<Customer['health'], MessageKey> = {
  healthy: 'customers.values.health.healthy',
  watch: 'customers.values.health.watch',
  'at-risk': 'customers.values.health.atRisk',
  critical: 'customers.values.health.critical',
  unknown: 'customers.values.health.unknown',
}

/** Localized labels for Customer Request lifecycle values. */
const requestStatusLabels: Record<CustomerDetail['requests'][number]['status'], MessageKey> = {
  requested: 'customers.values.requestStatus.requested',
  'in-progress': 'customers.values.requestStatus.inProgress',
  completed: 'customers.values.requestStatus.completed',
  closed: 'customers.values.requestStatus.closed',
  merged: 'customers.values.requestStatus.merged',
}

/** Localized labels for Customer Request importance values. */
const requestImportanceLabels: Record<CustomerDetail['requests'][number]['importance'], MessageKey> = {
  low: 'customers.values.importance.low',
  normal: 'customers.values.importance.normal',
  high: 'customers.values.importance.high',
  urgent: 'customers.values.importance.urgent',
}

/** Localized labels for Customer Work Item lifecycle projections. */
const workItemLifecycleLabels: Record<CustomerWorkItemSummary['lifecycle'], MessageKey> = {
  requested: 'customers.values.lifecycle.requested',
  'in-progress': 'customers.values.lifecycle.inProgress',
  completed: 'customers.values.lifecycle.completed',
  unknown: 'customers.values.lifecycle.unknown',
}

/** Renders one typed Customer select with an optional all-values option. */
function FilterSelect<Value extends string>({
  label,
  options,
  value,
  onChange,
  t,
  includeEmpty = true,
}: {
  /** Visible filter label. */
  label: string
  /** Supported filter options. */
  options: readonly CustomerFilterOption<Value>[]
  /** Currently selected option. */
  value?: Value
  /** Receives the selected option or undefined for all values. */
  onChange: (value: Value | undefined) => void
  /** Translator for the all-values label. */
  t: (key: MessageKey) => string
  /** Whether to show the all-values option. */
  includeEmpty?: boolean
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      <span>{label}</span>
      <select
        className="workbench-input min-h-10 w-full"
        onChange={(event) => onChange(options.find((option) => option.value === event.target.value)?.value)}
        value={value ?? ''}
      >
        {includeEmpty ? <option value="">{t('customers.filters.all')}</option> : null}
        {options.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
      </select>
    </label>
  )
}

/** Renders the name field and action used to save the current directory filters. */
function SaveViewControl({
  isSaving,
  onSave,
  t,
}: {
  /** Whether the create request is in progress. */
  isSaving: boolean
  /** Persists the trimmed view name. */
  onSave: (name: string) => void
  /** Translator for control copy. */
  t: (key: MessageKey) => string
}) {
  const [name, setName] = useState('')
  return (
    <form
      className="flex min-w-[260px] flex-1 items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmedName = name.trim()
        if (!trimmedName || isSaving) return
        onSave(trimmedName)
        setName('')
      }}
    >
      <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        <span>{t('customers.filters.saveViewName')}</span>
        <input
          aria-label={t('customers.filters.saveViewName')}
          className="workbench-input min-h-10 w-full"
          onChange={(event) => setName(event.target.value)}
          placeholder={t('customers.filters.saveViewPlaceholder')}
          value={name}
        />
      </label>
      <button className="workbench-button-primary min-h-10 px-3 text-xs" disabled={!name.trim() || isSaving} type="submit">
        {isSaving ? t('customers.filters.saving') : t('customers.filters.save')}
      </button>
    </form>
  )
}

/** One group of Customer rows in the directory list. */
type CustomerGroup = {
  /** Stable group key. */
  key: string
  /** Human-readable group label. */
  label: string
  /** Customers in this group. */
  customers: Customer[]
}

/** Groups Customer rows by the selected saved-view dimension. */
function groupCustomers(
  customers: readonly Customer[],
  groupBy: CustomerSavedView['groupBy'],
  t: (key: MessageKey) => string,
): CustomerGroup[] {
  if (!groupBy) return [{ key: 'all', label: '', customers: [...customers] }]
  const groups = new Map<string, Customer[]>()
  for (const customer of customers) {
    const value = readCustomerGroupValue(customer, groupBy, t)
    const group = groups.get(value.key) ?? []
    group.push(customer)
    groups.set(value.key, group)
  }
  return [...groups.entries()].map(([key, groupedCustomers]) => ({
    key,
    label: readCustomerGroupValue(groupedCustomers[0] ?? customers[0]!, groupBy, t).label,
    customers: groupedCustomers,
  }))
}

/** Resolves one localized Customer grouping value. */
function readCustomerGroupValue(
  customer: Customer,
  groupBy: NonNullable<CustomerSavedView['groupBy']>,
  t: (key: MessageKey) => string,
): { key: string; label: string } {
  switch (groupBy) {
    case 'tier':
      return { key: customer.tier, label: t(customerTierLabels[customer.tier]) }
    case 'size':
      return { key: customer.size, label: t(customerSizeLabels[customer.size]) }
    case 'status':
      return { key: customer.status, label: t(customerStatusLabels[customer.status]) }
    case 'health':
      return { key: customer.health, label: t(customerHealthLabels[customer.health]) }
    case 'owner':
      return customer.ownerUserId
        ? { key: customer.ownerUserId, label: customer.ownerUserId }
        : { key: 'unassigned', label: t('customers.values.unassigned') }
  }
}

/** Compares the URL-backed directory state with one saved view definition. */
function matchesSavedView(
  view: CustomerSavedView,
  filters: CustomerListInput,
  groupBy: CustomerSavedView['groupBy'],
): boolean {
  return view.groupBy === groupBy &&
    view.filters.search === filters.search &&
    view.filters.tier === filters.tier &&
    view.filters.size === filters.size &&
    view.filters.status === filters.status &&
    view.filters.health === filters.health &&
    view.filters.minBusinessValue === filters.minBusinessValue &&
    view.filters.minRequestCount === filters.minRequestCount &&
    view.filters.sortBy === filters.sortBy &&
    view.filters.sortDirection === filters.sortDirection
}
