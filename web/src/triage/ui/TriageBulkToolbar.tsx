import { useState, type FormEvent } from 'react'
import { TRIAGE_BULK_ACTION_LIMIT } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  TriageBulkActionInput,
  TriageBulkItemResult,
  TriageBulkOperation,
} from '../api'
import { createTriageBulkInput, type TriageBulkActionMode } from '../model/triageBulk'
import type { TriageEntryView } from '../model/triageView'

/** Props accepted by the explicit Team triage bulk operation toolbar. */
export type TriageBulkToolbarProps = {
  /** Bulk operation kinds enabled by the current Team configuration. */
  readonly allowedActions: readonly TriageBulkOperation['action'][]
  /** Selected revision-fenced entry views. */
  readonly entries: readonly TriageEntryView[]
  /** Whether a bulk operation is running. */
  readonly isPending?: boolean
  /** Safe mutation error message. */
  readonly errorMessage?: string
  /** Latest per-entry bulk results. */
  readonly results?: readonly TriageBulkItemResult[]
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Clears every selected entry. */
  readonly onClear: () => void
  /** Applies one explicit bounded bulk operation. */
  readonly onApply: (
    input: TriageBulkActionInput,
  ) => Promise<readonly TriageBulkItemResult[]>
}

/**
 * Renders selection feedback and confirmation forms for bounded bulk actions.
 *
 * @param props - Selected entries, results, and mutation callbacks.
 * @returns Bulk action toolbar, confirmation form, and partial-failure feedback.
 */
export function TriageBulkToolbar({
  allowedActions,
  entries,
  errorMessage,
  isPending = false,
  onApply,
  onClear,
  results = [],
  t,
}: TriageBulkToolbarProps) {
  const [mode, setMode] = useState<TriageBulkActionMode>()
  const [localError, setLocalError] = useState(false)
  const exceedsBulkLimit = entries.length > TRIAGE_BULK_ACTION_LIMIT

  if (entries.length === 0) return null

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!mode || isPending) return
    if (exceedsBulkLimit) {
      setLocalError(true)
      return
    }
    const input = createTriageBulkInput(entries, mode, new FormData(event.currentTarget))
    if (!input) {
      setLocalError(true)
      return
    }
    setLocalError(false)
    try {
      await onApply(input)
      setMode(undefined)
    } catch {
      setLocalError(true)
    }
  }

  return (
    <section
      aria-label={t('triage.bulk.aria')}
      className="border-b border-[var(--workbench-border)] bg-[#effaf8] px-4 py-3"
      data-testid="triage-bulk-toolbar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="mr-2 text-sm text-[var(--workbench-text)]">
          {t('triage.bulk.selectedCount').replace('{count}', String(entries.length))}
        </strong>
        {allowedActions.includes('assign') ? (
          <BulkModeButton
            disabled={isPending || exceedsBulkLimit}
            label={t('triage.bulk.assign')}
            mode="assign"
            onSelect={setMode}
          />
        ) : null}
        {allowedActions.includes('snooze') ? (
          <BulkModeButton
            disabled={isPending || exceedsBulkLimit}
            label={t('triage.bulk.snooze')}
            mode="snooze"
            onSelect={setMode}
          />
        ) : null}
        {allowedActions.includes('decline') ? (
          <BulkModeButton
            disabled={isPending || exceedsBulkLimit}
            label={t('triage.bulk.decline')}
            mode="decline"
            onSelect={setMode}
          />
        ) : null}
        <button
          className="ml-auto min-h-10 px-3 text-sm font-semibold text-[var(--workbench-muted)]"
          disabled={isPending}
          onClick={onClear}
          type="button"
        >
          {t('triage.bulk.clear')}
        </button>
      </div>

      {mode ? (
        <form className="mt-3 grid gap-3 border-l-2 border-[var(--workbench-primary)] bg-white p-3" onSubmit={(event) => void submit(event)}>
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('triage.bulk.review').replace('{count}', String(entries.length))}
          </p>
          {mode === 'assign' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('triage.bulk.ownerUserId')}
                <input autoFocus className="workbench-input min-h-10 px-3" name="ownerUserId" placeholder={t('triage.bulk.unownedHint')} />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('triage.bulk.projectId')}
                <input className="workbench-input min-h-10 px-3" name="projectId" placeholder={t('triage.action.projectOptional')} />
              </label>
            </div>
          ) : mode === 'decline' ? (
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('triage.bulk.reason')}
              <textarea autoFocus className="workbench-input min-h-24 px-3 py-2" name="reason" required />
            </label>
          ) : (
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('triage.bulk.until')}
              <input autoFocus className="workbench-input min-h-10 px-3" min={toLocalDateTime(new Date())} name="until" required type="datetime-local" />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button className="workbench-button-secondary min-h-10 px-4" disabled={isPending} onClick={() => setMode(undefined)} type="button">
              {t('triage.action.cancel')}
            </button>
            <button className="workbench-button-primary min-h-10 px-4" disabled={isPending} type="submit">
              {isPending ? t('triage.bulk.pending') : t('triage.bulk.submit')}
            </button>
          </div>
        </form>
      ) : null}

      {errorMessage || localError || exceedsBulkLimit ? (
        <p className="mt-3 text-sm font-semibold text-red-700" role="alert">
          {errorMessage ?? (exceedsBulkLimit
            ? t('triage.bulk.limit').replace('{limit}', String(TRIAGE_BULK_ACTION_LIMIT))
            : t('triage.bulk.error'))}
        </p>
      ) : null}

      {results.length > 0 ? (
        <ul
          aria-label={t('triage.bulk.results')}
          aria-live="polite"
          className="mt-3 grid gap-1 text-xs font-semibold"
        >
          {results.map((result) => (
            <li className={result.status === 'succeeded' ? 'text-emerald-700' : 'text-red-700'} key={result.entryId}>
              {result.entryId}: {t(result.status === 'succeeded'
                ? 'triage.bulk.succeeded'
                : result.status === 'conflict'
                  ? 'triage.bulk.conflict'
                  : 'triage.bulk.failed')}
              {result.errorCode ? ` (${result.errorCode})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** Opens one bulk-operation confirmation form. */
function BulkModeButton({ disabled = false, label, mode, onSelect }: {
  disabled?: boolean
  label: string
  mode: TriageBulkActionMode
  onSelect: (mode: TriageBulkActionMode) => void
}) {
  return (
    <button
      className="workbench-button-secondary min-h-10 px-4"
      disabled={disabled}
      onClick={() => onSelect(mode)}
      type="button"
    >
      {label}
    </button>
  )
}

/** Formats a Date for a local `datetime-local` input. */
function toLocalDateTime(date: Date): string {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return offsetDate.toISOString().slice(0, 16)
}
