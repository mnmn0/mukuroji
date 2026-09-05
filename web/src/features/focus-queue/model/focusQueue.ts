import {
  createDefaultDueDateWorkItemSchedule,
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type FocusActionabilityReason,
  type FocusEffectivePolicy,
  type FocusItem,
  type FocusQueueResponse,
  type FocusQueueSection,
  type FocusSignalResolutionCondition,
  type FocusSignalType,
  type WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'

/** Focus queue sections in their stable product order. */
export const focusQueueSectionOrder: readonly FocusQueueSection[] = Object.freeze([
  'now',
  'next',
  'waiting',
  'snoozed',
  'done',
])

/** Snooze choices exposed by the compact inline action. */
export type FocusSnoozePreset = 'later-today' | 'tomorrow' | 'next-week'

/** Query parameters used to correlate an Inbox event with one Focus item. */
export type FocusDeepLinkSelection = {
  /** Owning Team identifier from the Inbox notification. */
  teamId?: string
  /** Canonical Work Item identifier from the Inbox notification. */
  workItemId?: string
  /** Immutable source event identifier when the Inbox has one. */
  sourceEventId?: string
}

/** Directional keys supported by the Focus queue's roving focus model. */
export type FocusQueueNavigationKey =
  | 'next'
  | 'previous'
  | 'first'
  | 'last'

/**
 * Returns one section's items without reordering the server result.
 *
 * @param response - Server-ranked Focus queue snapshot.
 * @param section - Section currently selected by the user.
 * @param workItemTypeKey - Optional Team-qualified Work Item Type filter key.
 * @returns The original rank-ordered item array, or an empty array.
 */
export function getFocusQueueItems(
  response: FocusQueueResponse | undefined,
  section: FocusQueueSection,
  workItemTypeKey?: string,
): readonly FocusItem[] {
  const items = response?.sections.find((group) => group.section === section)?.items ?? []
  return workItemTypeKey
    ? items.filter((item) =>
        createSearchWorkItemTypeKey(
          item.workItem.teamId,
          item.workItem.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
        ) === workItemTypeKey)
    : items
}

/**
 * Counts items in every queue section while preserving absent groups as zero.
 *
 * @param response - Current Focus queue snapshot.
 * @param workItemTypeKey - Optional Team-qualified Work Item Type filter key.
 * @returns Item counts keyed by stable section name.
 */
export function getFocusQueueSectionCounts(
  response: FocusQueueResponse | undefined,
  workItemTypeKey?: string,
): Readonly<Record<FocusQueueSection, number>> {
  return {
    now: getFocusQueueItems(response, 'now', workItemTypeKey).length,
    next: getFocusQueueItems(response, 'next', workItemTypeKey).length,
    waiting: getFocusQueueItems(response, 'waiting', workItemTypeKey).length,
    snoozed: getFocusQueueItems(response, 'snoozed', workItemTypeKey).length,
    done: getFocusQueueItems(response, 'done', workItemTypeKey).length,
  }
}

/**
 * Resolves queue selection with an authorized URL request taking precedence over local state.
 *
 * @param items - Server-ordered items in the active section.
 * @param requestedItemId - Item selected by the current URL when still visible.
 * @param selectedItemId - Item selected locally before the URL changed.
 * @returns The requested item, local selection, or first server-ranked item.
 */
export function resolveSelectedFocusItem(
  items: readonly FocusItem[],
  requestedItemId?: string,
  selectedItemId?: string,
): FocusItem | undefined {
  return items.find((item) => item.id === requestedItemId) ??
    items.find((item) => item.id === selectedItemId) ??
    items[0]
}

/**
 * Resolves an Inbox correlation only when both the Work Item and optional source event remain visible.
 *
 * @param response - Permission-filtered Focus queue snapshot.
 * @param selection - Team, Work Item, and optional event requested by the URL.
 * @returns The matching item or undefined when permission or current signals removed it.
 */
export function findDeepLinkedFocusItem(
  response: FocusQueueResponse | undefined,
  selection: FocusDeepLinkSelection,
): FocusItem | undefined {
  if (!response || !selection.teamId || !selection.workItemId) return undefined

  const item = response.sections
    .flatMap((group) => group.items)
    .find((candidate) =>
      candidate.workItem.teamId === selection.teamId &&
      candidate.workItem.id === selection.workItemId)

  if (!item || !selection.sourceEventId) return item
  return item.signals.some((signal) => signal.source.eventId === selection.sourceEventId)
    ? item
    : undefined
}

/**
 * Selects a safe application path for the open-source action.
 *
 * @param item - Focus item whose visible signal evidence is inspected.
 * @param sourceEventId - Optional event to prefer for an Inbox correlation.
 * @returns An authorized application-relative path or undefined.
 */
export function getFocusSourcePath(
  item: FocusItem,
  sourceEventId?: string,
): string | undefined {
  if (!item.capabilities.openSource) return undefined
  const preferredSignal = sourceEventId
    ? item.signals.find((signal) =>
      signal.permission.canOpenSource && signal.source.eventId === sourceEventId)
    : undefined
  const path = preferredSignal?.source.deepLink ??
    item.signals.find((signal) =>
      signal.permission.canOpenSource && signal.source.deepLink)?.source.deepLink
  return isSafeApplicationPath(path) ? path : undefined
}

/**
 * Finds the effective policy referenced by one Focus item.
 *
 * @param response - Focus queue snapshot that owns the policies.
 * @param item - Item whose effective policy should be explained.
 * @returns The matching effective policy or undefined.
 */
export function getFocusItemPolicy(
  response: FocusQueueResponse | undefined,
  item: FocusItem | undefined,
): FocusEffectivePolicy | undefined {
  if (!response || !item) return undefined
  return response.effectivePolicies.find((policy) => policy.id === item.effectivePolicyId)
}

/**
 * Selects a stable effective policy for the personal editor.
 *
 * @param response - Current queue snapshot.
 * @param item - Selected item whose Team context is preferred.
 * @param preferredTeamId - Explicit Team selected in the policy editor.
 * @returns Selected Team policy, or the first visible Team policy for an empty section.
 */
export function getFocusPolicyForEditor(
  response: FocusQueueResponse | undefined,
  item: FocusItem | undefined,
  preferredTeamId?: string,
): FocusEffectivePolicy | undefined {
  const preferredPolicy = preferredTeamId === undefined
    ? undefined
    : response?.effectivePolicies.find((policy) => policy.teamId === preferredTeamId)
  return preferredPolicy ?? getFocusItemPolicy(response, item) ?? response?.effectivePolicies[0]
}

/**
 * Converts one queue section into its localized message key.
 *
 * @param section - Focus section to label.
 * @returns Localized section label key.
 */
export function getFocusSectionMessageKey(section: FocusQueueSection): MessageKey {
  switch (section) {
    case 'now': return 'workspace.focus.section.now'
    case 'next': return 'workspace.focus.section.next'
    case 'waiting': return 'workspace.focus.section.waiting'
    case 'snoozed': return 'workspace.focus.section.snoozed'
    case 'done': return 'workspace.focus.section.done'
  }
}

/**
 * Converts one empty queue section into its localized message key.
 *
 * @param section - Empty Focus section.
 * @returns Localized empty-state key.
 */
export function getFocusEmptyMessageKey(section: FocusQueueSection): MessageKey {
  switch (section) {
    case 'now': return 'workspace.focus.empty.now'
    case 'next': return 'workspace.focus.empty.next'
    case 'waiting': return 'workspace.focus.empty.waiting'
    case 'snoozed': return 'workspace.focus.empty.snoozed'
    case 'done': return 'workspace.focus.empty.done'
  }
}

/**
 * Converts one Focus signal into its localized reason-chip key.
 *
 * @param type - Focus attention category.
 * @returns Localized signal label key.
 */
export function getFocusSignalMessageKey(type: FocusSignalType): MessageKey {
  switch (type) {
    case 'blocker': return 'workspace.focus.signal.blocker'
    case 'urgent': return 'workspace.focus.signal.urgent'
    case 'overdue': return 'workspace.focus.signal.overdue'
    case 'due-soon': return 'workspace.focus.signal.dueSoon'
    case 'approval': return 'workspace.focus.signal.approval'
    case 'review-request': return 'workspace.focus.signal.reviewRequest'
    case 'mention': return 'workspace.focus.signal.mention'
    case 'sla': return 'workspace.focus.signal.sla'
    case 'cycle': return 'workspace.focus.signal.cycle'
  }
}

/**
 * Converts a resolution condition into its localized explanation key.
 *
 * @param condition - Machine-readable signal resolution condition.
 * @returns Localized resolution label key.
 */
export function getFocusResolutionMessageKey(
  condition: FocusSignalResolutionCondition,
): MessageKey {
  switch (condition) {
    case 'work-item-completed': return 'workspace.focus.resolution.workItemCompleted'
    case 'priority-lowered': return 'workspace.focus.resolution.priorityLowered'
    case 'deadline-changed': return 'workspace.focus.resolution.deadlineChanged'
    case 'dependency-removed': return 'workspace.focus.resolution.dependencyRemoved'
    case 'blocker-completed': return 'workspace.focus.resolution.blockerCompleted'
    case 'approval-decided': return 'workspace.focus.resolution.approvalDecided'
    case 'review-completed': return 'workspace.focus.resolution.reviewCompleted'
    case 'mention-acknowledged': return 'workspace.focus.resolution.mentionAcknowledged'
    case 'sla-restored': return 'workspace.focus.resolution.slaRestored'
    case 'cycle-changed': return 'workspace.focus.resolution.cycleChanged'
    case 'source-removed': return 'workspace.focus.resolution.sourceRemoved'
  }
}

/**
 * Converts an actionability reason into its localized message key.
 *
 * @param reason - Stable reason an item cannot currently progress.
 * @returns Localized actionability reason key.
 */
export function getFocusActionabilityMessageKey(
  reason: FocusActionabilityReason,
): MessageKey {
  switch (reason) {
    case 'blocked': return 'workspace.focus.actionability.blocked'
    case 'awaiting-external-action':
      return 'workspace.focus.actionability.awaitingExternalAction'
    case 'no-permitted-primary-action':
      return 'workspace.focus.actionability.noPermittedPrimaryAction'
    case 'work-item-completed':
      return 'workspace.focus.actionability.workItemCompleted'
  }
}

/**
 * Resolves one deterministic snooze preset from an injected clock.
 *
 * @param preset - Compact snooze option selected by the user.
 * @param now - Current time used to make the result deterministic in tests.
 * @returns ISO 8601 wake timestamp.
 */
export function resolveFocusSnoozeUntil(
  preset: FocusSnoozePreset,
  now: Date,
): string {
  const wakeTime = new Date(now)
  switch (preset) {
    case 'later-today': {
      const endOfToday = new Date(now)
      endOfToday.setHours(23, 59, 59, 999)
      wakeTime.setTime(Math.min(
        wakeTime.getTime() + (4 * 60 * 60 * 1_000),
        endOfToday.getTime(),
      ))
      break
    }
    case 'tomorrow':
      wakeTime.setDate(wakeTime.getDate() + 1)
      wakeTime.setHours(9, 0, 0, 0)
      break
    case 'next-week':
      wakeTime.setDate(wakeTime.getDate() + 7)
      wakeTime.setHours(9, 0, 0, 0)
      break
  }
  return wakeTime.toISOString()
}

/**
 * Builds the smallest schedule operation for one due-date selection.
 *
 * @param item - Focus item whose canonical schedule will change.
 * @param date - Local ISO calendar date selected by the user.
 * @returns A server-previewable replacement or move operation.
 */
export function createFocusScheduleOperation(
  item: FocusItem,
  date: string,
): WorkItemScheduleOperation {
  return item.workItem.schedule.mode === 'unscheduled'
    ? { schedule: createDefaultDueDateWorkItemSchedule(date), type: 'replace' }
    : { targetDate: date, type: 'move' }
}

/**
 * Resolves the next roving-focus index without changing server item order.
 *
 * @param currentIndex - Currently selected row index.
 * @param itemCount - Number of rows in the active section.
 * @param key - Normalized navigation direction.
 * @returns A clamped next row index, or -1 for an empty section.
 */
export function resolveFocusQueueNavigationIndex(
  currentIndex: number,
  itemCount: number,
  key: FocusQueueNavigationKey,
): number {
  if (itemCount <= 0) return -1
  const safeIndex = Math.min(Math.max(currentIndex, 0), itemCount - 1)
  switch (key) {
    case 'first': return 0
    case 'last': return itemCount - 1
    case 'next': return Math.min(safeIndex + 1, itemCount - 1)
    case 'previous': return Math.max(safeIndex - 1, 0)
  }
}

/**
 * Formats an API timestamp for compact queue metadata.
 *
 * @param value - ISO 8601 timestamp from Focus evidence.
 * @param locale - Current application locale.
 * @returns Locale-aware short date and time.
 */
export function formatFocusTimestamp(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
