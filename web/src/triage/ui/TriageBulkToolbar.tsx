import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  TriageBulkActionInput,
  TriageBulkItemResult,
  TriageBulkOperation,
} from '../api'
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

/** Bulk operation whose confirmation form is currently open. */
type BulkActionMode = 'assign' | 'decline' | 'snooze'

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
  const [mode, setMode] = useState<BulkActionMode>()
  const [localError, setLocalError] = useState(false)

  if (entries.length === 0) return null

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!mode || isPending) return
    const input = createBulkInput(entries, mode, new FormData(event.currentTarget))
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
          <BulkModeButton label={t('triage.bulk.assign')} mode="assign" onSelect={setMode} />
        ) : null}
        {allowedActions.includes('snooze') ? (
          <BulkModeButton label={t('triage.bulk.snooze')} mode="snooze" onSelect={setMode} />
        ) : null}
        {allowedActions.includes('decline') ? (
          <BulkModeButton label={t('triage.bulk.decline')} mode="decline" onSelect={setMode} />
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
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('triage.bulk.ownerUserId')}
              <input autoFocus className="workbench-input min-h-10 px-3" name="ownerUserId" placeholder={t('triage.bulk.unownedHint')} />
            </label>
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

      {errorMessage || localError ? (
        <p className="mt-3 text-sm font-semibold text-red-700" role="alert">
          {errorMessage ?? t('triage.bulk.error')}
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
function BulkModeButton({ label, mode, onSelect }: {
  label: string
  mode: BulkActionMode
  onSelect: (mode: BulkActionMode) => void
}) {
  return (
    <button className="workbench-button-secondary min-h-10 px-4" onClick={() => onSelect(mode)} type="button">
      {label}
    </button>
  )
}

/** Builds a bounded bulk input from selected entry revisions and form values. */
function createBulkInput(
  entries: readonly TriageEntryView[],
  mode: BulkActionMode,
  formData: FormData,
): TriageBulkActionInput | undefined {
  const targets = entries.map(({ entry }) => ({
    entryId: entry.id,
    expectedRevision: entry.revision,
  }))
  if (mode === 'assign') {
    const ownerUserId = readFormValue(formData, 'ownerUserId')
    return { operation: { action: 'assign', ownerUserId: ownerUserId || null }, targets }
  }
  if (mode === 'decline') {
    const reason = readFormValue(formData, 'reason')
    return reason ? { operation: { action: 'decline', reason }, targets } : undefined
  }
  const localUntil = readFormValue(formData, 'until')
  const until = localUntil ? new Date(localUntil) : undefined
  return until && !Number.isNaN(until.getTime())
    ? { operation: { action: 'snooze', until: until.toISOString() }, targets }
    : undefined
}

/** Reads and trims one string field from a bulk form. */
function readFormValue(formData: FormData, key: string) {
  const value = formData.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

/** Formats a Date for a local `datetime-local` input. */
function toLocalDateTime(date: Date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return offsetDate.toISOString().slice(0, 16)
}
