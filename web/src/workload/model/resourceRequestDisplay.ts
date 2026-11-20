import type { ResourceRequest, ResourceRequestStatus } from '@mukuroji/contracts'

/** Display order of request states: requests still needing capacity come first. */
const statusOrder: Record<ResourceRequestStatus, number> = {
  open: 0,
  'partially-filled': 1,
  filled: 2,
  canceled: 3,
}

/**
 * Orders resource requests for the management list.
 *
 * Active requests come before canceled ones, then requests are ordered by start date and title.
 *
 * @param requests - Visible resource requests from the workload snapshot.
 * @returns A new array in display order.
 */
export function sortResourceRequestsForDisplay(requests: readonly ResourceRequest[]): ResourceRequest[] {
  return [...requests].sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status] ||
    left.fromDate.localeCompare(right.fromDate) ||
    left.title.localeCompare(right.title)
  )
}

/**
 * Returns the i18n key suffix for a resource request state.
 *
 * @param status - Request lifecycle state.
 * @returns The camelCase status key used under `workload.controls.requests.status`.
 */
export function resourceRequestStatusKey(status: ResourceRequestStatus): 'open' | 'partiallyFilled' | 'filled' | 'canceled' {
  return status === 'partially-filled' ? 'partiallyFilled' : status
}
