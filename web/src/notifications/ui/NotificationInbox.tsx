import { useEffect, useMemo, useRef, useState } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { createFocusPath } from '../../shared/routing/paths'
import type { InboxNotification, NotificationFilter } from '../api'
import {
  createSnoozedUntil,
  groupNotificationsByDate,
  type NotificationSnoozeOption,
} from '../model/presentation'
import {
  resolveSelectedNotifications,
  updateNotificationSelection,
} from '../model/selection'
import type {
  BulkNotificationAction,
  NotificationInboxController,
} from '../mutations/useNotifications'

/** Event type of a scheduled Analytics report delivery to one recipient. */
const analyticsReportDeliveredEventType = 'analytics.report.delivered'

const notificationFilters = ['all', 'unread', 'read', 'archived', 'snoozed'] as const satisfies readonly NotificationFilter[]
const snoozeOptions = ['one-hour', 'tomorrow', 'next-week'] as const satisfies readonly NotificationSnoozeOption[]

/**
 * NotificationInbox の props です。
 */
export type NotificationInboxProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * cursor data と通知 action をまとめた controller です。
   */
  controller: NotificationInboxController
  /**
   * 通知対象をアプリ内で開く callback です。
   */
  onOpenNotification?: (notification: InboxNotification) => void
  /** Opens a notification's continuing Focus item through application navigation. */
  onOpenFocus?: (notification: InboxNotification) => void
  /** Immutable event selected by a cross-link from Focus. */
  selectedEventId?: string
}

/**
 * 未読・archive・snooze を扱う notification-backed Inbox です。
 */
export function NotificationInbox({
  controller,
  locale,
  onOpenFocus,
  onOpenNotification,
  selectedEventId,
}: NotificationInboxProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const groups = useMemo(
    () => groupNotificationsByDate(controller.notifications),
    [controller.notifications],
  )
  const eventTypes = Array.from(new Set([
    ...(controller.eventType ? [controller.eventType] : []),
    ...controller.availableEventTypes,
  ]))
  // Selection belongs to one filter view; switching filter or type starts a fresh selection.
  const selectionScope = `${controller.filter}\0${controller.eventType ?? ''}`
  const [selection, setSelection] = useState<{ scope: string, ids: ReadonlySet<string> }>(
    () => ({ scope: selectionScope, ids: new Set() }),
  )
  if (selection.scope !== selectionScope) {
    // Drop the stored IDs so returning to the previous filter does not restore its selection.
    setSelection({ scope: selectionScope, ids: new Set() })
  }
  const selectedNotifications = resolveSelectedNotifications(
    selection.scope === selectionScope ? selection.ids : new Set(),
    controller.notifications,
  )
  const selectedIds = new Set(selectedNotifications.map((notification) => notification.id))

  /** Replaces the selection of the current filter view. */
  const setSelectedIds = (ids: ReadonlySet<string>) => {
    setSelection({ scope: selectionScope, ids })
  }

  /** Runs a bulk action and keeps only the notifications that failed selected. */
  const runBulkAction = async (action: BulkNotificationAction) => {
    if (selectedNotifications.length === 0) {
      return
    }
    const result = await controller.bulkUpdate(selectedNotifications, action)
    setSelectedIds(new Set(result.failedIds))
  }

  return (
    <div className="grid gap-5" data-testid="notification-inbox">
      <section className="workbench-toolbar grid gap-4 p-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div
            aria-label={t('workspace.inbox.filterLabel')}
            className="inline-flex min-w-0 flex-wrap gap-1 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-1"
            role="group"
          >
            {notificationFilters.map((filter) => (
              <button
                aria-pressed={controller.filter === filter}
                className={`min-h-9 rounded-md px-3 text-sm font-semibold tracking-[0.01em] transition ${
                  controller.filter === filter
                    ? 'bg-surface text-[var(--workbench-text)] shadow-[0_1px_2px_rgba(23,32,29,0.08)]'
                    : 'text-[var(--workbench-muted)] hover:bg-surface/70 hover:text-[var(--workbench-text)]'
                }`}
                data-testid={`notification-filter-${filter}`}
                key={filter}
                onClick={() => controller.setFilter(filter)}
                type="button"
              >
                {t(`workspace.inbox.filter.${filter}`)}
                {filter === 'unread' && controller.unreadCount > 0 ? (
                  <span className="ml-2 rounded-full bg-[var(--workbench-primary)] px-2 py-0.5 text-xs font-bold text-white">
                    {controller.unreadCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label className="grid gap-1 text-xs font-semibold tracking-[0.02em] text-[var(--workbench-muted)]">
              <span className="sr-only">{t('workspace.inbox.typeFilter')}</span>
              <select
                aria-label={t('workspace.inbox.typeFilter')}
                className="workbench-input min-h-10 min-w-[180px] px-3 text-sm"
                data-testid="notification-type-filter"
                value={controller.eventType ?? ''}
                onChange={(event) => controller.setEventType(event.target.value || undefined)}
              >
                <option value="">{t('workspace.inbox.type.all')}</option>
                {eventTypes.map((eventType) => (
                  <option key={eventType} value={eventType}>
                    {formatNotificationEventType(eventType, t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="workbench-button-secondary min-h-10 px-3 disabled:cursor-not-allowed disabled:opacity-55"
              data-testid="notification-mark-all-read"
              disabled={
                controller.unreadCount === 0 ||
                controller.pendingNotificationId === 'mark-all' ||
                controller.isBulkPending
              }
              onClick={() => void controller.markAllRead()}
              type="button"
            >
              {controller.pendingNotificationId === 'mark-all'
                ? t('workspace.inbox.markingAllRead')
                : t('workspace.inbox.markAllRead')}
            </button>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--workbench-border)] pt-3">
          <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
            {t('workspace.inbox.summary')
              .replace('{count}', String(controller.notifications.length))
              .replace('{unread}', String(controller.unreadCount))}
          </p>
          <p className="text-xs font-semibold tracking-[0.02em] text-[var(--workbench-muted-soft)]">
            {t('workspace.inbox.persistedState')}
          </p>
        </div>
      </section>

      {controller.hasMutationError ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-700"
          role="alert"
        >
          {controller.bulkFailedCount > 0
            ? t('workspace.inbox.bulk.partialFailure')
                .replace('{count}', String(controller.bulkFailedCount))
            : t('workspace.inbox.mutationError')}
        </p>
      ) : null}

      <section className="workbench-panel overflow-hidden">
        {controller.isLoading ? (
          <NotificationInboxSkeleton t={t} />
        ) : controller.hasLoadError ? (
          <div className="grid justify-items-center gap-3 px-5 py-14 text-center">
            <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-full bg-red-50 text-lg font-bold text-fg-red-600">!</span>
            <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.inbox.loadError')}</p>
            <button
              className="workbench-button-secondary min-h-10 px-4"
              onClick={() => void controller.refresh()}
              type="button"
            >
              {t('workspace.inbox.retry')}
            </button>
          </div>
        ) : groups.length > 0 ? (
          <div data-testid="notification-list">
            <NotificationBulkBar
              controller={controller}
              loadedCount={controller.notifications.length}
              onClear={() => setSelectedIds(new Set())}
              onRun={(action) => void runBulkAction(action)}
              onSelectAll={(selected) => setSelectedIds(selected
                ? new Set(controller.notifications.map((notification) => notification.id))
                : new Set())}
              selectedNotifications={selectedNotifications}
              t={t}
            />
            {groups.map((group) => (
              <section key={group.key}>
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-y border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-2.5 first:border-t-0">
                  <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {t(`workspace.inbox.group.${group.key}`)}
                  </h2>
                  <span className="text-xs font-semibold tabular-nums text-[var(--workbench-muted-soft)]">
                    {group.notifications.length}
                  </span>
                </div>
                <div className="divide-y divide-[var(--workbench-border)]">
                  {group.notifications.map((notification) => (
                    <NotificationRow
                      controller={controller}
                      key={notification.id}
                      locale={locale}
                      notification={notification}
                      onOpenFocus={onOpenFocus}
                      onOpenNotification={onOpenNotification}
                      checked={selectedIds.has(notification.id)}
                      onCheckedChange={(checked) => setSelectedIds(
                        updateNotificationSelection(selectedIds, notification.id, checked),
                      )}
                      selected={selectedEventId !== undefined && notification.eventId === selectedEventId}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            ))}
            {controller.hasMore ? (
              <div className="border-t border-[var(--workbench-border)] p-4 text-center">
                <button
                  className="workbench-button-secondary min-h-10 min-w-[160px] px-4 disabled:opacity-55"
                  data-testid="notification-load-more"
                  disabled={controller.isLoadingMore}
                  onClick={() => void controller.loadMore()}
                  type="button"
                >
                  {t(controller.isLoadingMore
                    ? 'workspace.inbox.loadingMore'
                    : 'workspace.inbox.loadMore')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid min-h-[320px] place-items-center px-5 py-14 text-center">
            <div className="max-w-[420px]">
              <span
                aria-hidden="true"
                className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-tone-99d7cf bg-tone-e5f7f4 text-xl font-bold text-[var(--workbench-primary-text)]"
              >
                ✓
              </span>
              <h2 className="mt-5 text-lg font-semibold text-[var(--workbench-text)]">
                {t('workspace.inbox.emptyTitle')}
              </h2>
              <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t(`workspace.inbox.empty.${controller.filter}`)}
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Toolbar for selecting loaded notifications and applying one action to all selected rows.
 *
 * @param props - Controller, current selection, and selection callbacks.
 * @returns The bulk action bar shown above the notification list.
 */
function NotificationBulkBar({
  controller,
  loadedCount,
  onClear,
  onRun,
  onSelectAll,
  selectedNotifications,
  t,
}: {
  /** Inbox controller providing the current filter and pending state. */
  controller: NotificationInboxController
  /** Number of notifications currently loaded in the list. */
  loadedCount: number
  /** Clears the selection. */
  onClear: () => void
  /** Runs one bulk action over the selection. */
  onRun: (action: BulkNotificationAction) => void
  /** Selects every loaded notification, or clears the selection. */
  onSelectAll: (selected: boolean) => void
  /** Selected notifications that are still in the list. */
  selectedNotifications: readonly InboxNotification[]
  /** Translator for the current locale. */
  t: (key: MessageKey) => string
}) {
  const selectAllRef = useRef<HTMLInputElement>(null)
  const selectedCount = selectedNotifications.length
  const allSelected = selectedCount > 0 && selectedCount === loadedCount
  // Any running mutation may touch the selected rows, so bulk actions wait for it.
  const isBusy = controller.isBulkPending || controller.pendingNotificationId !== undefined
  const canMarkRead = selectedNotifications.some((notification) => !notification.readAt)
  const archiveAction: BulkNotificationAction = controller.filter === 'archived' ? 'restore' : 'archive'

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected
    }
  }, [allSelected, selectedCount])

  return (
    <div
      aria-label={t('workspace.inbox.bulk.label')}
      className="flex min-w-0 flex-wrap items-center gap-3 border-b border-[var(--workbench-border)] bg-surface px-5 py-2.5"
      data-testid="notification-bulk-bar"
      role="group"
    >
      <label className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-[var(--workbench-muted)] max-[760px]:min-h-[44px]">
        <input
          aria-label={t('workspace.inbox.bulk.selectAll')}
          checked={allSelected}
          className="h-4 w-4 accent-[var(--workbench-primary)]"
          data-testid="notification-select-all"
          disabled={controller.isBulkPending}
          onChange={(event) => onSelectAll(event.target.checked)}
          ref={selectAllRef}
          type="checkbox"
        />
        <span role="status">
          {selectedCount > 0
            ? t('workspace.inbox.bulk.selected').replace('{count}', String(selectedCount))
            : t('workspace.inbox.bulk.none')}
        </span>
      </label>
      {selectedCount > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            className="workbench-button-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-55 max-[760px]:min-h-[44px]"
            data-testid="notification-bulk-mark-read"
            disabled={isBusy || !canMarkRead}
            onClick={() => onRun('mark-read')}
            type="button"
          >
            {t('workspace.inbox.bulk.markRead')}
          </button>
          <button
            className="workbench-button-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-55 max-[760px]:min-h-[44px]"
            data-testid={`notification-bulk-${archiveAction}`}
            disabled={isBusy}
            onClick={() => onRun(archiveAction)}
            type="button"
          >
            {t(archiveAction === 'restore'
              ? 'workspace.inbox.bulk.restore'
              : 'workspace.inbox.bulk.archive')}
          </button>
          <button
            className="min-h-9 rounded-md px-2.5 text-xs font-semibold text-[var(--workbench-muted)] transition hover:text-[var(--workbench-primary-text)] disabled:opacity-50 max-[760px]:min-h-[44px]"
            data-testid="notification-bulk-clear"
            disabled={controller.isBulkPending}
            onClick={onClear}
            type="button"
          >
            {t('workspace.inbox.bulk.clear')}
          </button>
          {controller.isBulkPending ? (
            <span className="text-xs font-semibold text-[var(--workbench-muted-soft)]" role="status">
              {t('workspace.inbox.bulk.running')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function NotificationRow({
  checked,
  controller,
  locale,
  notification,
  onCheckedChange,
  onOpenFocus,
  onOpenNotification,
  selected,
  t,
}: {
  checked: boolean
  controller: NotificationInboxController
  locale: Locale
  notification: InboxNotification
  onCheckedChange: (checked: boolean) => void
  onOpenFocus?: (notification: InboxNotification) => void
  onOpenNotification?: (notification: InboxNotification) => void
  selected: boolean
  t: (key: MessageKey) => string
}) {
  const rowRef = useRef<HTMLElement>(null)
  const isUnread = notification.state === 'unread'
  const isRead = notification.state === 'read' || Boolean(notification.readAt)
  // Rows wait while a bulk action runs because it may be updating them.
  const isPending = controller.pendingNotificationId === notification.id || controller.isBulkPending
  const eventLabel = formatNotificationEventType(notification.eventType, t)
  const title = notification.title?.trim() || eventLabel
  const summary = resolveNotificationSummary(notification, eventLabel, t)

  useEffect(() => {
    if (!selected) return
    rowRef.current?.scrollIntoView({ block: 'center' })
    rowRef.current?.focus({ preventScroll: true })
  }, [selected])

  return (
    <article
      aria-current={selected ? 'true' : undefined}
      className={`relative grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-4 transition max-[760px]:grid-cols-1 ${
        isUnread ? 'bg-tone-f4fbfa' : 'bg-surface'
      } ${isPending ? 'opacity-60' : 'hover:bg-[var(--workbench-surface-muted)]'} ${
        selected ? 'z-[1] outline outline-2 outline-offset-[-2px] outline-[var(--workbench-primary)]' : ''
      }`}
      data-testid={`notification-row-${createNotificationTestToken(notification.id)}`}
      ref={rowRef}
      tabIndex={selected ? -1 : undefined}
    >
      {isUnread ? (
        <span
          aria-label={t('workspace.inbox.unread')}
          className="absolute left-1.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-[var(--workbench-primary)]"
          role="status"
        />
      ) : null}
      <div className="flex min-w-0 items-start gap-3">
        <label className="-ml-2 flex h-10 w-8 shrink-0 cursor-pointer items-center justify-center max-[760px]:-ml-3 max-[760px]:h-11 max-[760px]:w-11">
          <input
            aria-label={t('workspace.inbox.bulk.selectOne').replace('{title}', title)}
            checked={checked}
            className="h-4 w-4 accent-[var(--workbench-primary)]"
            data-testid={`notification-select-${createNotificationTestToken(notification.id)}`}
            disabled={controller.isBulkPending}
            onChange={(event) => onCheckedChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        <button
          className="group grid min-w-0 flex-1 grid-cols-[40px_minmax(0,1fr)] gap-3 text-left disabled:cursor-default"
          disabled={!onOpenNotification || isPending}
          onClick={() => {
            void controller.markRead(notification).then(() => onOpenNotification?.(notification))
          }}
          type="button"
        >
          <span
            aria-hidden="true"
            className={`grid h-10 w-10 place-items-center rounded-full border text-sm font-bold ${resolveEventToneClassName(notification.eventType)}`}
          >
            {resolveEventGlyph(notification.eventType)}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-bold uppercase tracking-[0.07em] text-[var(--workbench-primary-text)]">
                {eventLabel}
              </span>
              <time
                className="text-xs font-semibold text-[var(--workbench-muted-soft)]"
                dateTime={notification.occurredAt}
                title={formatNotificationDate(notification.occurredAt, locale, true)}
              >
                {formatNotificationDate(notification.occurredAt, locale, false)}
              </time>
            </span>
            <span className={`mt-1 block truncate text-sm text-[var(--workbench-text)] ${isUnread ? 'font-bold' : 'font-semibold'}`}>
              {title}
            </span>
            <span className="mt-1 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {summary}
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              {notification.actorLabel ? (
                <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                  {notification.actorLabel}
                </span>
              ) : null}
              {notification.reasons.slice(0, 3).map((reason) => (
                <span className="workbench-badge" key={reason}>
                  {formatNotificationReason(reason, t)}
                </span>
              ))}
            </span>
          </span>
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 self-center max-[760px]:justify-start max-[760px]:pl-[96px]">
        {notification.reasons.includes('mention') && notification.teamId && notification.issueId ? (
          <a
            className="inline-flex min-h-9 items-center rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 text-xs font-semibold text-[var(--workbench-primary-text)] transition hover:border-tone-99d7cf focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workbench-primary)] max-[760px]:min-h-[44px]"
            data-testid={`notification-focus-${createNotificationTestToken(notification.id)}`}
            href={createFocusPath(notification.teamId, notification.issueId, notification.eventId)}
            onClick={onOpenFocus
              ? (event) => {
                  if (
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    event.button !== 0
                  ) {
                    return
                  }
                  event.preventDefault()
                  onOpenFocus(notification)
                }
              : undefined}
          >
            {t('workspace.inbox.action.openFocus')}
          </a>
        ) : null}
        <button
          className="min-h-9 rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 text-xs font-semibold text-[var(--workbench-muted)] transition hover:border-tone-99d7cf hover:text-[var(--workbench-primary-text)] disabled:opacity-50 max-[760px]:min-h-[44px]"
          disabled={isPending}
          onClick={() => void (isRead ? controller.markUnread(notification) : controller.markRead(notification))}
          type="button"
        >
          {t(isRead ? 'workspace.inbox.action.markUnread' : 'workspace.inbox.action.markRead')}
        </button>
        {controller.filter !== 'archived' ? (
          <label className="grid">
            <span className="sr-only">{t('workspace.inbox.action.snooze')}</span>
            <select
              aria-label={t('workspace.inbox.action.snooze')}
              className="workbench-input min-h-9 max-w-[130px] px-2.5 text-xs font-semibold text-[var(--workbench-muted)] max-[760px]:min-h-[44px]"
              data-testid={`notification-snooze-${createNotificationTestToken(notification.id)}`}
              disabled={isPending}
              value=""
              onChange={(event) => {
                const option = readSnoozeOption(event.target.value)

                if (option) {
                  void controller.snooze(notification, createSnoozedUntil(option))
                }
              }}
            >
              <option value="">{t('workspace.inbox.action.snooze')}</option>
              {snoozeOptions.map((option) => (
                <option key={option} value={option}>
                  {t(`workspace.inbox.snooze.${option}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="min-h-9 rounded-md border border-[var(--workbench-border)] bg-surface px-2.5 text-xs font-semibold text-[var(--workbench-muted)] transition hover:border-tone-99d7cf hover:text-[var(--workbench-primary-text)] disabled:opacity-50 max-[760px]:min-h-[44px]"
          disabled={isPending}
          onClick={() => void (controller.filter === 'archived'
            ? controller.restore(notification)
            : controller.archive(notification))}
          type="button"
        >
          {t(controller.filter === 'archived'
            ? 'workspace.inbox.action.restore'
            : 'workspace.inbox.action.archive')}
        </button>
      </div>
    </article>
  )
}

function NotificationInboxSkeleton({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div aria-label={t('workspace.inbox.loading')} className="grid" role="status">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-3 border-b border-[var(--workbench-border)] px-5 py-5 last:border-b-0" key={index}>
          <span className="h-10 w-10 animate-pulse rounded-full bg-slate-200" />
          <span className="grid gap-2">
            <span className="h-3 w-24 animate-pulse rounded bg-slate-200" />
            <span className="h-4 w-2/3 animate-pulse rounded bg-slate-200" />
            <span className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
          </span>
        </div>
      ))}
    </div>
  )
}

function readSnoozeOption(value: string) {
  return snoozeOptions.find((option) => option === value)
}

function formatNotificationDate(value: string, locale: Locale, includeYear: boolean) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    ...(includeYear ? { year: 'numeric' } : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatNotificationEventType(eventType: string, t: (key: MessageKey) => string) {
  return t(resolveNotificationEventKey(eventType))
}

function resolveNotificationEventKey(eventType: string): MessageKey {
  const normalizedEventType = eventType.toLowerCase()

  if (normalizedEventType === analyticsReportDeliveredEventType) {
    return 'workspace.inbox.event.reportDelivered'
  }
  if (normalizedEventType.startsWith('timesheet.')) {
    return 'workspace.inbox.event.timesheet'
  }
  if (normalizedEventType.includes('mention')) {
    return 'workspace.inbox.event.mention'
  }
  if (normalizedEventType.includes('reply')) {
    return 'workspace.inbox.event.reply'
  }
  if (normalizedEventType.includes('comment')) {
    return 'workspace.inbox.event.comment'
  }
  if (normalizedEventType.includes('assign')) {
    return 'workspace.inbox.event.assignment'
  }
  if (normalizedEventType.includes('health-degraded')) {
    return 'workspace.inbox.event.healthDegraded'
  }
  if (normalizedEventType === 'planning-update.published') {
    return 'workspace.inbox.event.healthUpdate'
  }
  if (normalizedEventType.includes('escalation')) {
    return 'workspace.inbox.event.escalation'
  }
  if (normalizedEventType.includes('overdue-reminder')) {
    return 'workspace.inbox.event.overdueReminder'
  }
  if (normalizedEventType.includes('overdue')) {
    return 'workspace.inbox.event.overdue'
  }
  if (normalizedEventType.includes('due-soon')) {
    return 'workspace.inbox.event.dueSoon'
  }
  if (normalizedEventType.includes('due')) {
    return 'workspace.inbox.event.due'
  }
  if (normalizedEventType.includes('approval')) {
    return 'workspace.inbox.event.approval'
  }
  if (normalizedEventType.includes('automation')) {
    return 'workspace.inbox.event.automation'
  }
  if (normalizedEventType.includes('stale')) {
    return 'workspace.inbox.event.stale'
  }
  if (normalizedEventType === 'work-item.blocker-removed') {
    return 'workspace.inbox.event.blockerCleared'
  }
  if (normalizedEventType.includes('status') || normalizedEventType.includes('work-item')) {
    return 'workspace.inbox.event.status'
  }

  return 'workspace.inbox.event.update'
}

function formatNotificationReason(reason: string, t: (key: MessageKey) => string) {
  const normalizedReason = reason.toLowerCase()

  if (normalizedReason.includes('mention')) {
    return t('workspace.inbox.reason.mention')
  }
  if (normalizedReason.includes('reply')) {
    return t('workspace.inbox.reason.reply')
  }
  if (normalizedReason.includes('assign')) {
    return t('workspace.inbox.reason.assignment')
  }
  if (normalizedReason.includes('watch')) {
    return t('workspace.inbox.reason.watcher')
  }
  if (normalizedReason === 'project-member') {
    return t('workspace.inbox.reason.projectMember')
  }
  if (normalizedReason === 'update-author') {
    return t('workspace.inbox.reason.updateAuthor')
  }
  if (normalizedReason === 'update-owner') {
    return t('workspace.inbox.reason.updateOwner')
  }
  if (normalizedReason === 'creator') {
    return t('workspace.inbox.reason.creator')
  }
  if (normalizedReason === 'escalation') {
    return t('workspace.inbox.reason.escalation')
  }
  if (normalizedReason === 'due-soon') {
    return t('workspace.inbox.reason.dueSoon')
  }
  if (normalizedReason === 'overdue') {
    return t('workspace.inbox.reason.overdue')
  }
  if (normalizedReason === 'stale') {
    return t('workspace.inbox.reason.stale')
  }
  if (normalizedReason === 'report-recipient') {
    return t('workspace.inbox.reason.reportRecipient')
  }
  if (normalizedReason === 'timesheet') {
    return t('workspace.inbox.reason.timesheet')
  }

  return t('workspace.inbox.reason.watch')
}

/**
 * Resolves the row summary, localizing the fixed text of scheduled report deliveries and cleared blockers.
 *
 * @param notification - Notification shown in the row.
 * @param eventLabel - Localized event label used by the fallback summary.
 * @param t - Message translator for the current locale.
 * @returns The summary text shown under the title.
 */
function resolveNotificationSummary(
  notification: InboxNotification,
  eventLabel: string,
  t: (key: MessageKey) => string,
) {
  if (notification.eventType === analyticsReportDeliveredEventType) {
    return t('workspace.inbox.summary.reportDelivered')
  }
  if (notification.eventType === 'work-item.blocker-removed') {
    return t('workspace.inbox.summary.blockerCleared')
  }
  return notification.summary?.trim() || createNotificationFallbackSummary(notification, eventLabel, t)
}

function createNotificationFallbackSummary(
  notification: InboxNotification,
  eventLabel: string,
  t: (key: MessageKey) => string,
) {
  return notification.actorLabel
    ? t('workspace.inbox.fallbackSummary')
        .replace('{actor}', notification.actorLabel)
        .replace('{event}', eventLabel)
    : eventLabel
}

function resolveEventGlyph(eventType: string) {
  const eventKey = resolveNotificationEventKey(eventType)

  if (eventKey === 'workspace.inbox.event.mention') {
    return '@'
  }
  if (eventKey === 'workspace.inbox.event.reply' || eventKey === 'workspace.inbox.event.comment') {
    return '↩'
  }
  if (eventKey === 'workspace.inbox.event.assignment') {
    return '→'
  }
  if (eventKey === 'workspace.inbox.event.automation') {
    return '!'
  }
  if (eventKey === 'workspace.inbox.event.approval') {
    return '✓'
  }

  return '•'
}

function resolveEventToneClassName(eventType: string) {
  const eventKey = resolveNotificationEventKey(eventType)

  if (
    eventKey === 'workspace.inbox.event.automation' ||
    eventKey === 'workspace.inbox.event.overdue' ||
    eventKey === 'workspace.inbox.event.overdueReminder' ||
    eventKey === 'workspace.inbox.event.escalation' ||
    eventKey === 'workspace.inbox.event.healthDegraded'
  ) {
    return 'border-red-200 bg-red-50 text-fg-red-700'
  }
  if (
    eventKey === 'workspace.inbox.event.due' ||
    eventKey === 'workspace.inbox.event.dueSoon' ||
    eventKey === 'workspace.inbox.event.stale' ||
    eventKey === 'workspace.inbox.event.timesheet' ||
    eventKey === 'workspace.inbox.event.approval'
  ) {
    return 'border-amber-200 bg-amber-50 text-fg-amber-700'
  }

  return 'border-tone-99d7cf bg-tone-e5f7f4 text-[var(--workbench-primary-text)]'
}

function createNotificationTestToken(value: string) {
  return value.replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
}
