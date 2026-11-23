import type { PlanningEntityWatchState } from '../api/entities'
import { usePlanningEntityWatch } from '../queries/usePlanningEntityWatch'

/** Localized text of the Milestone watch control. */
export type PlanningMilestoneWatchLabels = {
  /** Button text while the viewer does not watch the Milestone. */
  watch: string
  /** Button text while the viewer watches the Milestone. */
  watching: string
  /** Formats the number of watchers. */
  watcherCount: (count: number) => string
  /** Explains what watching does. */
  description: string
  /** Shown when the watch state cannot be read or changed. */
  error: string
  /** Button text that reads the watch state again after a failure. */
  retry: string
}

/** Props of {@link PlanningMilestoneWatchButton}. */
export type PlanningMilestoneWatchButtonProps = {
  /** Current watch state; absent while it loads. */
  watch?: PlanningEntityWatchState
  /** Whether a change is being saved. */
  isPending?: boolean
  /** Whether the last read or change failed. */
  hasError?: boolean
  /** Changes the watch state; absent when the viewer cannot watch. */
  onToggle?: () => void
  /** Reads the watch state again after a failure. */
  onRetry?: () => void
  /** Localized text. */
  labels: PlanningMilestoneWatchLabels
}

/**
 * Shows whether the viewer watches a Milestone and lets them change it.
 *
 * @param props - Watch state, toggle callback, and localized text.
 * @returns The watch button with its explanation.
 */
export function PlanningMilestoneWatchButton({
  hasError = false,
  isPending = false,
  labels,
  onRetry,
  onToggle,
  watch,
}: PlanningMilestoneWatchButtonProps) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="planning-milestone-watch">
      <button
        aria-pressed={watch?.subscribed ?? false}
        className={watch?.subscribed
          ? 'workbench-button-primary min-h-10 px-3'
          : 'workbench-button-secondary min-h-10 px-3'}
        disabled={!watch || !onToggle || isPending}
        type="button"
        onClick={onToggle}
      >
        {watch?.subscribed ? labels.watching : labels.watch}
        {watch ? (
          <span className="ml-2 opacity-75">{labels.watcherCount(watch.watcherCount)}</span>
        ) : null}
      </button>
      <p className="text-xs text-[var(--workbench-muted)]">{labels.description}</p>
      {hasError ? (
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-fg-red-700" role="alert">
          {labels.error}
          {onRetry ? (
            <button className="workbench-button-secondary min-h-10 px-3" type="button" onClick={onRetry}>
              {labels.retry}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

/** Props of {@link PlanningMilestoneWatchContainer}. */
export type PlanningMilestoneWatchContainerProps = {
  /** Planning API access token. */
  accessToken: string
  /** Milestone ID. */
  entityId: string
  /** Whether the viewer may change the watch state. */
  canWatch: boolean
  /** Localized text. */
  labels: PlanningMilestoneWatchLabels
}

/**
 * Loads and changes the viewer's watch state of one Milestone through the Planning API.
 *
 * @param props - Access token, Milestone, permission, and localized text.
 * @returns The watch control bound to the API.
 */
export function PlanningMilestoneWatchContainer({
  accessToken,
  canWatch,
  entityId,
  labels,
}: PlanningMilestoneWatchContainerProps) {
  const { hasError, isPending, retry, toggle, watch } = usePlanningEntityWatch(accessToken, entityId)
  return (
    <PlanningMilestoneWatchButton
      hasError={hasError}
      isPending={isPending}
      labels={labels}
      watch={watch}
      onRetry={() => void retry()}
      onToggle={canWatch ? () => void toggle() : undefined}
    />
  )
}
