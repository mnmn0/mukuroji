import type {
  Customer,
  CustomerDetail,
  CustomerListInput,
  CustomerRequestImportance,
  CustomerRequestSourceKind,
  CustomerRequestStatus,
  CustomerSavedView,
  CustomerWorkItemSummary,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Option rendered by a Customer filter select. */
export type CustomerFilterOption<Value extends string> = {
  /** URL or view value represented by the option. */
  value: Value
  /** Message key for the option label. */
  labelKey: MessageKey
}

/** Customer tier options supported by the directory filter. */
export const customerTierOptions = [
  { value: 'strategic', labelKey: 'customers.values.tier.strategic' },
  { value: 'enterprise', labelKey: 'customers.values.tier.enterprise' },
  { value: 'growth', labelKey: 'customers.values.tier.growth' },
  { value: 'standard', labelKey: 'customers.values.tier.standard' },
  { value: 'trial', labelKey: 'customers.values.tier.trial' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['tier']>>[]

/** Customer size options supported by the directory filter. */
export const customerSizeOptions = [
  { value: 'startup', labelKey: 'customers.values.size.startup' },
  { value: 'small', labelKey: 'customers.values.size.small' },
  { value: 'mid-market', labelKey: 'customers.values.size.midMarket' },
  { value: 'enterprise', labelKey: 'customers.values.size.enterprise' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['size']>>[]

/** Customer lifecycle options supported by the directory filter. */
export const customerStatusOptions = [
  { value: 'prospect', labelKey: 'customers.values.status.prospect' },
  { value: 'active', labelKey: 'customers.values.status.active' },
  { value: 'inactive', labelKey: 'customers.values.status.inactive' },
  { value: 'churned', labelKey: 'customers.values.status.churned' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['status']>>[]

/** Customer health options supported by the directory filter. */
export const customerHealthOptions = [
  { value: 'healthy', labelKey: 'customers.values.health.healthy' },
  { value: 'watch', labelKey: 'customers.values.health.watch' },
  { value: 'at-risk', labelKey: 'customers.values.health.atRisk' },
  { value: 'critical', labelKey: 'customers.values.health.critical' },
  { value: 'unknown', labelKey: 'customers.values.health.unknown' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['health']>>[]

/** Customer sort options supported by the directory filter. */
export const customerSortOptions = [
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
export const customerSafeSortOptions = customerSortOptions.filter((option) => option.value !== 'businessValue')

/** Customer sort-direction options supported by the directory filter. */
export const customerSortDirectionOptions = [
  { value: 'descending', labelKey: 'customers.filters.direction.descending' },
  { value: 'ascending', labelKey: 'customers.filters.direction.ascending' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerListInput['sortDirection']>>[]

/** Customer grouping options supported by saved directory views. */
export const customerGroupOptions = [
  { value: 'tier', labelKey: 'customers.filters.group.tier' },
  { value: 'size', labelKey: 'customers.filters.group.size' },
  { value: 'status', labelKey: 'customers.filters.group.status' },
  { value: 'health', labelKey: 'customers.filters.group.health' },
  { value: 'owner', labelKey: 'customers.filters.group.owner' },
] as const satisfies readonly CustomerFilterOption<NonNullable<CustomerSavedView['groupBy']>>[]

/** Customer grouping options that do not expose redacted owner identifiers. */
export const customerSafeGroupOptions = customerGroupOptions.filter((option) => option.value !== 'owner')

/** Localized labels for Customer commercial tiers. */
export const customerTierLabels: Record<Customer['tier'], MessageKey> = {
  strategic: 'customers.values.tier.strategic',
  enterprise: 'customers.values.tier.enterprise',
  growth: 'customers.values.tier.growth',
  standard: 'customers.values.tier.standard',
  trial: 'customers.values.tier.trial',
}

/** Localized labels for Customer organization sizes. */
export const customerSizeLabels: Record<Customer['size'], MessageKey> = {
  startup: 'customers.values.size.startup',
  small: 'customers.values.size.small',
  'mid-market': 'customers.values.size.midMarket',
  enterprise: 'customers.values.size.enterprise',
}

/** Localized labels for Customer lifecycle statuses. */
export const customerStatusLabels: Record<Customer['status'], MessageKey> = {
  prospect: 'customers.values.status.prospect',
  active: 'customers.values.status.active',
  inactive: 'customers.values.status.inactive',
  churned: 'customers.values.status.churned',
}

/** Localized labels for Customer health values. */
export const customerHealthLabels: Record<Customer['health'], MessageKey> = {
  healthy: 'customers.values.health.healthy',
  watch: 'customers.values.health.watch',
  'at-risk': 'customers.values.health.atRisk',
  critical: 'customers.values.health.critical',
  unknown: 'customers.values.health.unknown',
}

/** Localized labels for Customer Request lifecycle values. */
export const requestStatusLabels: Record<CustomerDetail['requests'][number]['status'], MessageKey> = {
  requested: 'customers.values.requestStatus.requested',
  'in-progress': 'customers.values.requestStatus.inProgress',
  completed: 'customers.values.requestStatus.completed',
  closed: 'customers.values.requestStatus.closed',
  merged: 'customers.values.requestStatus.merged',
}

/** Localized labels for Customer Request importance values. */
export const requestImportanceLabels: Record<CustomerDetail['requests'][number]['importance'], MessageKey> = {
  low: 'customers.values.importance.low',
  normal: 'customers.values.importance.normal',
  high: 'customers.values.importance.high',
  urgent: 'customers.values.importance.urgent',
}

/** Localized labels for Customer Work Item lifecycle projections. */
export const workItemLifecycleLabels: Record<CustomerWorkItemSummary['lifecycle'], MessageKey> = {
  requested: 'customers.values.lifecycle.requested',
  'in-progress': 'customers.values.lifecycle.inProgress',
  completed: 'customers.values.lifecycle.completed',
  unknown: 'customers.values.lifecycle.unknown',
}


/** Customer Request importance options offered by the Request editor. */
export const requestImportanceOptions = [
  { value: 'low', labelKey: 'customers.values.importance.low' },
  { value: 'normal', labelKey: 'customers.values.importance.normal' },
  { value: 'high', labelKey: 'customers.values.importance.high' },
  { value: 'urgent', labelKey: 'customers.values.importance.urgent' },
] as const satisfies readonly CustomerFilterOption<CustomerRequestImportance>[]

/** Customer Request lifecycle options that a member may set by hand. Merged is owned by the merge flow. */
export const requestEditableStatusOptions = [
  { value: 'requested', labelKey: 'customers.values.requestStatus.requested' },
  { value: 'in-progress', labelKey: 'customers.values.requestStatus.inProgress' },
  { value: 'completed', labelKey: 'customers.values.requestStatus.completed' },
  { value: 'closed', labelKey: 'customers.values.requestStatus.closed' },
] as const satisfies readonly CustomerFilterOption<CustomerRequestStatus>[]

/** Customer Request source channels that a member can record for a manual Request. */
export const requestManualSourceOptions = [
  { value: 'manual', labelKey: 'customers.values.source.manual' },
  { value: 'email', labelKey: 'customers.values.source.email' },
  { value: 'phone', labelKey: 'customers.values.source.phone' },
  { value: 'chat', labelKey: 'customers.values.source.chat' },
  { value: 'form', labelKey: 'customers.values.source.form' },
  { value: 'portal', labelKey: 'customers.values.source.portal' },
] as const satisfies readonly CustomerFilterOption<CustomerRequestSourceKind>[]
