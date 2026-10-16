import { useEffect } from 'react'
import { announce } from '../../shared/lib/liveAnnouncements'

/** Props accepted by the shared task action feedback banner. */
export type TaskActionFeedbackProps = {
  /** Whether the banner represents a successful action or an error. */
  kind: 'success' | 'error'
  /** Message shown to the user. */
  message: string
  /** Optional label for an undo action. */
  undoLabel?: string
  /** Accessible label for the dismiss action. */
  dismissLabel: string
  /** Reverses the last successful optimistic action. */
  onUndo?: () => void
  /** Dismisses the current feedback message. */
  onDismiss?: () => void
  /** Optional stable test identifier. */
  testId?: string
  /**
   * Identity of the action that produced the message. A new value re-announces a
   * success message even when its text is unchanged and the banner stays mounted.
   */
  announcementKey?: unknown
}

/**
 * Renders consistent success, conflict, failure, and undo feedback for task actions.
 *
 * Errors use `role="alert"`, which screen readers announce when the banner mounts.
 * Success messages are announced through the persistent application live region,
 * because a `role="status"` region that mounts together with its text is often
 * not announced.
 *
 * @param props - Feedback state and optional recovery actions.
 * @returns A compact alert banner or a visual confirmation banner.
 */
export function TaskActionFeedback({
  announcementKey,
  kind,
  dismissLabel,
  message,
  onDismiss,
  onUndo,
  testId = 'task-action-feedback',
  undoLabel,
}: TaskActionFeedbackProps) {
  // Synchronizes the confirmation with the external live region; React state is not involved.
  useEffect(() => {
    if (kind === 'success') announce(message, 'polite', Date.now(), announcementKey)
  }, [announcementKey, kind, message])

  return (
    <div
      className={`mx-[clamp(20px,3vw,34px)] mt-4 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm font-semibold ${
        kind === 'error'
          ? 'border-red-200 bg-red-50 text-fg-red-700'
          : 'border-tone-99d7cf bg-tone-e5f7f4 text-[var(--workbench-primary-text)]'
      }`}
      data-testid={testId}
      role={kind === 'error' ? 'alert' : undefined}
    >
      <span className="min-w-0 flex-1">{message}</span>
      {onUndo && undoLabel ? (
        <button className="underline underline-offset-2" onClick={onUndo} type="button">
          {undoLabel}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          aria-label={dismissLabel}
          className="rounded px-1 text-base leading-none"
          onClick={onDismiss}
          type="button"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
