/** Props accepted by the shared task action feedback banner. */
export type TaskActionFeedbackProps = {
  /** Whether the banner represents a successful action or an error. */
  kind: 'success' | 'error'
  /** Message shown to the user. */
  message: string
  /** Optional label for an undo action. */
  undoLabel?: string
  /** Accessible label for the dismiss action. */
  dismissLabel?: string
  /** Reverses the last successful optimistic action. */
  onUndo?: () => void
  /** Dismisses the current feedback message. */
  onDismiss?: () => void
  /** Optional stable test identifier. */
  testId?: string
}

/**
 * Renders consistent success, conflict, failure, and undo feedback for task actions.
 *
 * @param props - Feedback state and optional recovery actions.
 * @returns A compact alert/status banner.
 */
export function TaskActionFeedback({
  kind,
  dismissLabel,
  message,
  onDismiss,
  onUndo,
  testId = 'task-action-feedback',
  undoLabel,
}: TaskActionFeedbackProps) {
  return (
    <div
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      className={`mx-[clamp(20px,3vw,34px)] mt-4 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm font-semibold ${
        kind === 'error'
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]'
      }`}
      data-testid={testId}
      role={kind === 'error' ? 'alert' : 'status'}
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
