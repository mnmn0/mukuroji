import type {
  DeveloperPlatformLabels,
  SecretDialogKind,
} from './DeveloperPlatformView'
import { trapDialogFocus } from './dialogFocus'

/**
 * One-time secret value retained only while the secret dialog is open.
 */
export type SecretDialogState = {
  /** Credential kind associated with the secret. */
  kind: SecretDialogKind
  /** User-facing name of the credential. */
  name: string
  /** One-time secret value. */
  value: string
}

/**
 * Renders a guarded one-time secret dialog with copy and storage confirmation.
 *
 * @param props - Secret state, confirmation state, labels, and dialog callbacks.
 * @returns The one-time secret dialog.
 */
export function SecretDialog(props: {
  copied: boolean
  copyErrorMessage?: string
  labels: DeveloperPlatformLabels
  state: SecretDialogState
  stored: boolean
  onCopy: () => Promise<void>
  onRequestClose: () => void
  onStoredChange: (stored: boolean) => void
}) {
  const {
    copied,
    copyErrorMessage,
    labels,
    state,
    stored,
    onCopy,
    onRequestClose,
    onStoredChange,
  } = props

  return (
    <div
      aria-describedby="developer-secret-description developer-secret-warning"
      aria-labelledby="developer-secret-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/55 p-4"
      onKeyDown={(event) => {
        trapDialogFocus(event)
        if (event.key === 'Escape' && stored) {
          onRequestClose()
        }
      }}
      role="dialog"
    >
      <div className="workbench-panel w-full max-w-[620px] overflow-hidden shadow-xl">
        <div className="border-b border-[var(--workbench-border)] px-5 py-4">
          <p className="workbench-eyebrow">{state.name}</p>
          <h3
            className="mt-2 text-lg font-semibold text-[var(--workbench-text)]"
            id="developer-secret-title"
          >
            {labels.secretTitles[state.kind]}
          </h3>
          <p
            className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]"
            id="developer-secret-description"
          >
            {labels.secretDescriptions[state.kind]}
          </p>
        </div>
        <div className="grid gap-4 p-5">
          <p
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900"
            id="developer-secret-warning"
          >
            {labels.secretWarning}
          </p>
          <code className="overflow-x-auto rounded-lg border border-[var(--workbench-border-strong)] bg-slate-950 px-4 py-3 text-sm text-emerald-300">
            {state.value}
          </code>
          {copyErrorMessage ? (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
              role="alert"
            >
              {copyErrorMessage}
            </p>
          ) : null}
          <label className="flex items-start gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={stored}
              className="mt-0.5 h-5 w-5 flex-none accent-[var(--workbench-primary)]"
              type="checkbox"
              onChange={(event) => onStoredChange(event.target.checked)}
            />
            <span>{labels.secretStoredConfirmation}</span>
          </label>
        </div>
        <div className="flex justify-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <button
            autoFocus
            className="workbench-button-secondary min-h-10 px-4"
            onClick={() => void onCopy()}
            type="button"
          >
            {copied ? labels.copiedSecret : labels.copySecret}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!stored}
            onClick={onRequestClose}
            type="button"
          >
            {labels.closeDialog}
          </button>
        </div>
      </div>
    </div>
  )
}
