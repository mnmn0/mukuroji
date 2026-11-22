import type { PlanningEntity } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { PlanningEntityActivityEvent } from '../api/entities'
import {
  createPlanningEntityActivityRows,
  type PlanningEntityActivityKind,
  type PlanningEntityActivityValue,
} from '../model/entityActivity'
import type { PlanningOwnerOption } from '../model/entityEditor'
import { usePlanningEntityActivity } from '../queries/usePlanningEntityActivity'

/** Localized text of the Planning entity activity tab. */
export type PlanningEntityActivityLabels = {
  /** Accessible name of the activity list. */
  title: string
  /** Shown while the first page loads. */
  loading: string
  /** Shown when the activity cannot be loaded. */
  error: string
  /** Shown when the entity has no activity the caller can see. */
  empty: string
  /** Loads the next page. */
  loadMore: string
  /** Retries a failed load. */
  retry: string
  /** Sentence naming each lifecycle change. */
  kinds: Record<PlanningEntityActivityKind, string>
  /** Name shown for changes a system process made. */
  system: string
  /** Formats when a change happened. */
  occurredAt: (occurredAt: string) => string
  /** Names a changed field from its dot-separated path. */
  field: (field: string) => string
  /** Formats a recorded field value. */
  value: (field: string, value: unknown) => string
  /** Shown for a field that had no value. */
  emptyValue: string
  /** Shown for a value the caller may not see. */
  redactedValue: string
}

/** Props of {@link PlanningEntityActivityPanel}. */
export type PlanningEntityActivityPanelProps = {
  /** Loaded activity events, newest first. */
  events: readonly PlanningEntityActivityEvent[]
  /** Whether the first page is loading. */
  isLoading: boolean
  /** Whether the next page is loading. */
  isLoadingMore?: boolean
  /** Whether the server has more events. */
  hasMore: boolean
  /** Whether the last load failed. */
  hasError: boolean
  /** Localized text. */
  labels: PlanningEntityActivityLabels
  /** Names a member from the member key recorded with a change. */
  memberName?: (memberKey: string) => string
  /** Formats a value for display; falls back to the label formatter when it returns `undefined`. */
  referenceValue?: (field: string, value: unknown) => string | undefined
  /** Loads the next page. */
  onLoadMore?: () => void
  /** Retries a failed load. */
  onRetry?: () => void
}

/**
 * Lists who changed a Planning entity, when, and which fields changed, newest first.
 *
 * @param props - Activity events, load state, and localized text.
 * @returns The activity list with loading, error, and empty states.
 */
export function PlanningEntityActivityPanel({
  events,
  hasError,
  hasMore,
  isLoading,
  isLoadingMore = false,
  labels,
  memberName,
  referenceValue,
  onLoadMore,
  onRetry,
}: PlanningEntityActivityPanelProps) {
  const rows = useMemo(() => createPlanningEntityActivityRows(events), [events])
  /** Formats one side of a field change. */
  const formatValue = (field: string, value: PlanningEntityActivityValue) => {
    if (value.kind === 'empty') return labels.emptyValue
    if (value.kind === 'redacted') return labels.redactedValue
    return referenceValue?.(field, value.value) ?? labels.value(field, value.value)
  }

  if (isLoading) {
    return (
      <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
        {labels.loading}
      </p>
    )
  }

  return (
    <div className="grid gap-3" data-testid="planning-entity-activity">
      {hasError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
          <p className="text-sm font-semibold text-fg-red-800">{labels.error}</p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={onRetry}>
              {labels.retry}
            </button>
          ) : null}
        </div>
      ) : null}
      {!hasError && rows.length === 0 && !hasMore ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.empty}</p>
      ) : null}
      {rows.length > 0 ? (
        <ol aria-label={labels.title} className="grid gap-2">
          {rows.map((row) => (
            <li
              className="grid gap-2 rounded-lg border border-[var(--workbench-border)] px-4 py-3"
              data-event-id={row.eventId}
              data-testid="planning-entity-activity-row"
              key={row.eventId}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-semibold text-[var(--workbench-text)]">
                  <span>
                    {row.actor.kind === 'member'
                      ? memberName?.(row.actor.memberKey) ?? row.actor.memberKey
                      : labels.system}
                  </span>
                  <span className="font-medium text-[var(--workbench-muted)]">
                    {' '}
                    {row.kind === 'other' && row.summary ? row.summary : labels.kinds[row.kind]}
                  </span>
                </p>
                <time className="text-xs font-medium text-[var(--workbench-muted)]" dateTime={row.occurredAt}>
                  {labels.occurredAt(row.occurredAt)}
                </time>
              </div>
              {row.changes.length > 0 ? (
                <dl className="grid gap-1 text-xs">
                  {row.changes.map((change) => (
                    <div
                      className="grid grid-cols-[minmax(96px,160px)_minmax(0,1fr)] gap-2 max-[480px]:grid-cols-1 max-[480px]:gap-0"
                      key={change.field}
                    >
                      <dt className="font-semibold text-[var(--workbench-muted)]">{labels.field(change.field)}</dt>
                      <dd className="min-w-0 break-words font-medium text-[var(--workbench-text)]">
                        <span className="text-[var(--workbench-muted)] line-through decoration-1">
                          {formatValue(change.field, change.before)}
                        </span>
                        <span aria-hidden="true"> → </span>
                        <span>{formatValue(change.field, change.after)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {hasMore && !hasError ? (
        <div>
          <button
            className="workbench-button-secondary min-h-9 px-3"
            disabled={isLoadingMore}
            type="button"
            onClick={onLoadMore}
          >
            {isLoadingMore ? labels.loading : labels.loadMore}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Props of {@link PlanningEntityActivityContainer}. */
export type PlanningEntityActivityContainerProps = {
  /** Planning API access token. */
  accessToken: string
  /** Entity whose activity is shown. */
  entityId: string
  /** Planning snapshot revision; a new revision reloads the activity. */
  revision?: number
  /** Entities of the snapshot, used to name referenced plans. */
  entities: readonly PlanningEntity[]
  /** Workspace members, used to name who made each change. */
  ownerOptions?: readonly PlanningOwnerOption[]
  /** Localized text. */
  labels: PlanningEntityActivityLabels
}

/** Fields whose value is the ID of another Planning entity. */
const entityReferenceFields = new Set(['parentId', 'nextCycleId'])

/**
 * Loads the activity of one Planning entity and shows it.
 *
 * @param props - Access token, entity, snapshot context, and localized text.
 * @returns The activity panel bound to the Planning API.
 */
export function PlanningEntityActivityContainer({
  accessToken,
  entities,
  entityId,
  labels,
  ownerOptions = [],
  revision,
}: PlanningEntityActivityContainerProps) {
  const activity = usePlanningEntityActivity(accessToken, entityId, revision)
  const memberLabels = useMemo(
    () => new Map(ownerOptions.map((option) => [option.memberKey.toLowerCase(), option.label])),
    [ownerOptions],
  )
  const entityTitles = useMemo(
    () => new Map(entities.map((entity) => [entity.id, entity.title])),
    [entities],
  )
  /** Names a member, falling back to the recorded key. */
  const memberName = (memberKey: string) => memberLabels.get(memberKey.toLowerCase()) ?? memberKey
  return (
    <PlanningEntityActivityPanel
      events={activity.events}
      hasError={Boolean(activity.error)}
      hasMore={activity.hasMore}
      isLoading={activity.isLoading}
      isLoadingMore={activity.isLoadingMore}
      labels={labels}
      memberName={memberName}
      referenceValue={(field, value) => {
        if (typeof value !== 'string') return undefined
        if (entityReferenceFields.has(field)) return entityTitles.get(value)
        if (field === 'ownerMemberKey') return memberName(value)
        return undefined
      }}
      onLoadMore={() => void activity.loadMore()}
      onRetry={() => void activity.retry()}
    />
  )
}
