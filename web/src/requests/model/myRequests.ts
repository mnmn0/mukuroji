import type { MyRequest, WorkflowStatusCategory } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

const statusKeys: Record<MyRequest['status'], MessageKey> = {
  received: 'requests.mine.status.received',
  triaging: 'requests.mine.status.triaging',
  'needs-more-info': 'requests.mine.status.needs-more-info',
  rejected: 'requests.mine.status.rejected',
  duplicate: 'requests.mine.status.duplicate',
  converted: 'requests.mine.status.converted',
}

const categoryKeys: Record<WorkflowStatusCategory, MessageKey> = {
  backlog: 'requests.mine.category.backlog',
  unstarted: 'requests.mine.category.unstarted',
  started: 'requests.mine.category.started',
  completed: 'requests.mine.category.completed',
  canceled: 'requests.mine.category.canceled',
}

/**
 * Chooses the status label of one of the member's requests. A request whose Work Item is
 * completed reads as completed, whether or not the member can open the Work Item.
 *
 * @param request - The member's request.
 * @returns Message key of the status label.
 */
export function resolveMyRequestStatusKey(request: Pick<MyRequest, 'status' | 'workItem'>): MessageKey {
  if (request.status === 'converted' && request.workItem?.completed) return 'requests.mine.status.completed'
  return statusKeys[request.status]
}

/**
 * Returns the label of a Work Item status category for the requester.
 *
 * @param category - Standard status category.
 * @returns Message key of the category label.
 */
export function resolveMyRequestCategoryKey(category: WorkflowStatusCategory): MessageKey {
  return categoryKeys[category]
}

/**
 * Reads the selected request ID from the page query.
 *
 * @param value - Raw `requestId` query value.
 * @returns The trimmed ID, or undefined when it is absent or too long.
 */
export function readMyRequestId(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= 200 ? trimmed : undefined
}
