import { useEffect, useMemo, useRef } from 'react'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { createTranslator } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import type { TeamIssueActivityEvent } from '../api'
import type { IssueCollaborationController } from '../mutations/useIssueCollaboration'
import { groupIssueActivity } from '../model/activityGroups'
import {
  advanceDeepLinkTraversal,
  type DeepLinkTraversalState,
} from '../model/deepLinkTraversal'
import { ChevronIcon } from '../../shared/ui/icons'

/**
 * Props for the Work Item activity ledger.
 */
export type IssueActivityTabProps = {
  /** Locale used for messages and timestamps. */
  locale: Locale
  /** Workspace members used to resolve actor names. */
  members: WorkspaceMember[]
  /** Existing collaboration controller that owns activity pagination. */
  controller: IssueCollaborationController
  /** Optional action that promotes an activity event into curated context. */
  onPromoteActivity?: (event: TeamIssueActivityEvent) => void
  /** Activity event targeted by a deep link. */
  focusedActivityEventId?: string
}

const activityLabelKeys: Record<string, MessageKey> = {
  'comment.created': 'collaboration.activity.commentCreated',
  'comment.replied': 'collaboration.activity.replyCreated',
  'comment.updated': 'collaboration.activity.commentEdited',
  'comment.edited': 'collaboration.activity.commentEdited',
  'comment.deleted': 'collaboration.activity.commentDeleted',
  'comment.resolved': 'collaboration.activity.commentResolved',
  'comment.reopened': 'collaboration.activity.commentReopened',
  'comment.reaction.added': 'collaboration.activity.reactionAdded',
  'comment.reaction.removed': 'collaboration.activity.reactionRemoved',
  'watch.subscribed': 'collaboration.activity.watchSubscribed',
  'watch.unsubscribed': 'collaboration.activity.watchUnsubscribed',
  'work-item.created': 'collaboration.activity.workItemCreated',
  'work-item.updated': 'collaboration.activity.workItemUpdated',
  'file.created': 'collaboration.activity.fileCreated',
  'file.version-created': 'collaboration.activity.fileVersionCreated',
  'file.upload-completed': 'collaboration.activity.fileUploadCompleted',
  'file.deleted': 'collaboration.activity.fileDeleted',
  'file.download-accessed': 'collaboration.activity.fileDownloaded',
  'file.preview-accessed': 'collaboration.activity.filePreviewed',
  'annotation.created': 'collaboration.activity.annotationCreated',
  'approval.requested': 'collaboration.activity.approvalRequested',
  'approval.approved': 'collaboration.activity.approvalApproved',
  'approval.completed': 'collaboration.activity.approvalCompleted',
  'approval.cancelled': 'collaboration.activity.approvalCancelled',
  'approval.rejected': 'collaboration.activity.approvalRejected',
  'approval.changes-requested': 'collaboration.activity.approvalChangesRequested',
}

/**
 * Renders append-only activity with consecutive mechanical changes collapsed into disclosures.
 *
 * @param props - Activity data, locale, members, and pagination actions.
 * @returns The activity tab content.
 */
export function IssueActivityTab({
  controller,
  focusedActivityEventId,
  locale,
  members,
  onPromoteActivity,
}: IssueActivityTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const groups = useMemo(
    () => groupIssueActivity(controller.activity),
    [controller.activity],
  )
  const focusActivity = controller.activity
  const focusHasMoreActivity = controller.hasMoreActivity
  const focusIsActivityLoading = controller.isActivityLoading
  const focusIsLoadingMoreActivity = controller.isLoadingMoreActivity
  const focusLoadMoreActivity = controller.loadMoreActivity
  const handledFocusTargetRef = useRef<string | undefined>(undefined)
  const deepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })

  useEffect(() => {
    if (!focusedActivityEventId) {
      handledFocusTargetRef.current = undefined
      deepLinkTraversalRef.current = { requestedPages: 0 }
      return
    }
    if (
      handledFocusTargetRef.current === focusedActivityEventId ||
      focusIsActivityLoading
    ) {
      return
    }
    const target = document.getElementById(
      createActivityAnchorId(focusedActivityEventId),
    )

    const traversal = advanceDeepLinkTraversal(
      deepLinkTraversalRef.current,
      focusedActivityEventId,
      !target && focusHasMoreActivity && !focusIsLoadingMoreActivity,
    )
    deepLinkTraversalRef.current = traversal.state

    if (traversal.shouldLoad) {
      void focusLoadMoreActivity()
      return
    }

    if (!target) return
    handledFocusTargetRef.current = focusedActivityEventId
    const enclosingDetails = target.closest('details')
    if (enclosingDetails) enclosingDetails.open = true
    const frameId = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ behavior: 'auto', block: 'center' })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [
    focusActivity,
    focusHasMoreActivity,
    focusIsActivityLoading,
    focusIsLoadingMoreActivity,
    focusLoadMoreActivity,
    focusedActivityEventId,
  ])

  return (
    <section
      aria-busy={controller.isActivityLoading || controller.isLoadingMoreActivity}
      aria-label={t('collaboration.tabs.activity')}
      className="px-5 py-4"
      data-testid="issue-activity-tab"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--workbench-muted)]">
          {t('collaboration.activity.description')}
        </p>
        <span className="whitespace-nowrap text-[0.68rem] font-semibold text-[var(--workbench-muted-soft)]">
          {t('collaboration.activity.appendOnly')}
        </span>
      </div>

      {controller.hasActivityLoadError ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2.5" role="alert">
          <p className="text-sm font-semibold text-red-700">
            {t('collaboration.activity.error')}
          </p>
          <button
            className="min-h-[44px] text-xs font-bold text-red-700 underline underline-offset-2"
            onClick={() => void controller.refresh()}
            type="button"
          >
            {t('collaboration.retry')}
          </button>
        </div>
      ) : controller.isActivityLoading ? (
        <div className="mt-4 grid gap-2" aria-hidden="true">
          <div className="h-11 motion-safe:animate-pulse bg-[var(--workbench-surface-muted)]" />
          <div className="h-11 motion-safe:animate-pulse bg-[var(--workbench-surface-muted)]" />
        </div>
      ) : groups.length > 0 ? (
        <ol className="mt-4 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {groups.map((group) =>
            group.kind === 'system-group' && group.events.length > 1 ? (
              <li key={group.id}>
                <details className="group py-1" data-testid="activity-system-group">
                  <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm font-semibold text-[var(--workbench-text)] marker:hidden">
                    <span>
                      {t('collaboration.activity.systemGroup')
                        .replace('{count}', String(group.events.length))}
                    </span>
                    <span className="flex items-center gap-1 whitespace-nowrap text-[0.68rem] font-medium text-[var(--workbench-muted)]">
                      {formatActivityTimeRange(group.events, locale)}
                      <ChevronIcon className="h-4 w-4 fill-none stroke-current stroke-2 motion-safe:transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                    </span>
                  </summary>
                  <ol className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3">
                    {group.events.map((event) => (
                      <ActivityEventRow
                        event={event}
                        key={event.eventId}
                        locale={locale}
                        members={members}
                        nested
                        onPromote={onPromoteActivity}
                        t={t}
                      />
                    ))}
                  </ol>
                </details>
              </li>
            ) : (
              <ActivityEventRow
                event={group.kind === 'event' ? group.event : group.events[0]}
                key={group.kind === 'event' ? group.event.eventId : group.id}
                locale={locale}
                members={members}
                onPromote={onPromoteActivity}
                t={t}
              />
            ),
          )}
        </ol>
      ) : (
        <div className="mt-4 border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-4 py-7 text-center">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.detail.activityEmpty')}
          </p>
        </div>
      )}

      {controller.hasMoreActivity ? (
        <button
          className="mt-4 min-h-[44px] text-sm font-semibold text-[var(--workbench-primary)] underline decoration-[#99d7cf] underline-offset-2 disabled:opacity-60"
          disabled={controller.isLoadingMoreActivity}
          onClick={() => void controller.loadMoreActivity()}
          type="button"
        >
          {t(
            controller.isLoadingMoreActivity
              ? 'collaboration.loadingMore'
              : 'collaboration.activity.loadEarlier',
          )}
        </button>
      ) : null}
    </section>
  )
}

/**
 * Props for one activity event row.
 */
type ActivityEventRowProps = {
  /** Event rendered by the row. */
  event?: TeamIssueActivityEvent
  /** Locale used for timestamps. */
  locale: Locale
  /** Workspace members used to resolve the actor. */
  members: WorkspaceMember[]
  /** Whether the row is nested within a system disclosure. */
  nested?: boolean
  /** Optional context promotion action. */
  onPromote?: (event: TeamIssueActivityEvent) => void
  /** Collaboration translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders one audit event without duplicating conversation content.
 *
 * @param props - Event presentation inputs.
 * @returns One activity list row, or null when no event exists.
 */
function ActivityEventRow({
  event,
  locale,
  members,
  nested = false,
  onPromote,
  t,
}: ActivityEventRowProps) {
  if (!event) return null

  return (
    <li
      className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--workbench-primary)] focus-visible:ring-offset-2 ${nested ? 'text-xs' : 'text-sm'}`}
      data-event-type={event.eventType}
      id={createActivityAnchorId(event.eventId)}
      tabIndex={-1}
    >
      <div className="min-w-0">
        <p className="font-medium leading-5 text-[var(--workbench-text)]">
          {formatActivityLabel(event, members, t)}
        </p>
        <time
          className="mt-1 block text-[0.68rem] text-[var(--workbench-muted-soft)]"
          dateTime={event.occurredAt}
          title={formatActivityDate(event.occurredAt, locale, true)}
        >
          {formatActivityDate(event.occurredAt, locale, false)}
        </time>
      </div>
      {onPromote ? (
        <button
          aria-label={t('collaboration.activity.promoteLabel').replace(
            '{event}',
            formatActivityLabel(event, members, t),
          )}
          className="min-h-[44px] whitespace-nowrap px-1 text-xs font-semibold text-[var(--workbench-primary)]"
          onClick={() => onPromote(event)}
          type="button"
        >
          {t('collaboration.activity.promote')}
        </button>
      ) : null}
    </li>
  )
}

/**
 * Formats one activity label using exact and fallback event mappings.
 *
 * @param event - Activity event to format.
 * @param members - Workspace members available for actor lookup.
 * @param t - Collaboration translator.
 * @returns Human-readable activity label.
 */
function formatActivityLabel(
  event: TeamIssueActivityEvent,
  members: WorkspaceMember[],
  t: (key: MessageKey) => string,
): string {
  const labelKey = activityLabelKeys[event.eventType] ?? inferActivityLabelKey(event.eventType)

  if (!labelKey) return event.summary ?? event.eventType

  const actor = formatMemberName(
    members.find(
      (member) =>
        member.memberKey === event.actorUserId ||
        member.id === event.actorUserId ||
        member.email === event.actorUserId,
    ),
    event.actorUserId,
  )

  return t(labelKey).replace('{actor}', actor)
}

/**
 * Infers a known activity label from a forward-compatible event name.
 *
 * @param eventType - Append-only audit event type.
 * @returns A message key when the event belongs to a known family.
 */
function inferActivityLabelKey(eventType: string): MessageKey | undefined {
  const normalizedType = eventType.toLowerCase()

  if (
    normalizedType.includes('comment') &&
    (normalizedType.includes('edit') || normalizedType.includes('update'))
  ) {
    return 'collaboration.activity.commentEdited'
  }
  if (normalizedType.includes('comment') && normalizedType.includes('delete')) {
    return 'collaboration.activity.commentDeleted'
  }
  if (normalizedType.includes('comment') && normalizedType.includes('reopen')) {
    return 'collaboration.activity.commentReopened'
  }
  if (normalizedType.includes('comment') && normalizedType.includes('resolve')) {
    return 'collaboration.activity.commentResolved'
  }
  if (normalizedType.includes('reaction')) {
    return normalizedType.includes('remove')
      ? 'collaboration.activity.reactionRemoved'
      : 'collaboration.activity.reactionAdded'
  }
  if (normalizedType.includes('watch')) {
    return normalizedType.includes('unsubscribe') || normalizedType.includes('remove')
      ? 'collaboration.activity.watchUnsubscribed'
      : 'collaboration.activity.watchSubscribed'
  }
  if (normalizedType.includes('file')) {
    if (normalizedType.includes('download')) return 'collaboration.activity.fileDownloaded'
    if (normalizedType.includes('preview')) return 'collaboration.activity.filePreviewed'
    if (normalizedType.includes('delete')) return 'collaboration.activity.fileDeleted'
    if (normalizedType.includes('upload') && normalizedType.includes('complete')) {
      return 'collaboration.activity.fileUploadCompleted'
    }
    return normalizedType.includes('version')
      ? 'collaboration.activity.fileVersionCreated'
      : 'collaboration.activity.fileCreated'
  }
  if (normalizedType.includes('annotation')) {
    return 'collaboration.activity.annotationCreated'
  }
  if (normalizedType.includes('approval')) {
    if (normalizedType.includes('reject')) return 'collaboration.activity.approvalRejected'
    if (normalizedType.includes('change')) {
      return 'collaboration.activity.approvalChangesRequested'
    }
    return normalizedType.includes('request')
      ? 'collaboration.activity.approvalRequested'
      : 'collaboration.activity.approvalApproved'
  }

  return undefined
}

/**
 * Formats one activity timestamp for visible and tooltip variants.
 *
 * @param value - ISO timestamp.
 * @param locale - Application locale.
 * @param includeYear - Whether the output includes a year.
 * @returns Localized timestamp.
 */
function formatActivityDate(
  value: string,
  locale: Locale,
  includeYear: boolean,
): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }

  if (includeYear) options.year = 'numeric'

  return new Intl.DateTimeFormat(
    locale === 'ja' ? 'ja-JP' : 'en-US',
    options,
  ).format(date)
}

/**
 * Formats the time boundary of one consecutive system group.
 *
 * @param events - Consecutive system events.
 * @param locale - Application locale.
 * @returns Compact start-to-end time range.
 */
function formatActivityTimeRange(
  events: readonly TeamIssueActivityEvent[],
  locale: Locale,
): string {
  const first = events[0]
  const last = events.at(-1)
  if (!first || !last) return ''

  const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const firstDate = new Date(first.occurredAt)
  const lastDate = new Date(last.occurredAt)

  if (Number.isNaN(firstDate.getTime()) || Number.isNaN(lastDate.getTime())) {
    return `${first.occurredAt}–${last.occurredAt}`
  }

  return `${formatter.format(firstDate)}–${formatter.format(lastDate)}`
}

/**
 * Resolves a member display name with a stable fallback.
 *
 * @param member - Matching Workspace member, when available.
 * @param fallback - Stable actor identifier.
 * @returns Human-readable actor name.
 */
function formatMemberName(
  member: WorkspaceMember | undefined,
  fallback: string,
): string {
  return member?.name?.trim() || member?.email || fallback
}

/**
 * Creates a stable focus anchor for one activity event.
 *
 * @param eventId - Stable audit event identifier.
 * @returns DOM-safe activity anchor ID.
 */
function createActivityAnchorId(eventId: string): string {
  return `activity-${encodeURIComponent(eventId)}`
}
