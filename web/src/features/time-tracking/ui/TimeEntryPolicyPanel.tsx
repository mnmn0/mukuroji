import type { TimeEntryCheckMode } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import type { SaveTeamTimeEntryPolicyInput, TeamTimeEntryPolicyView } from '../api/timeEntryPolicy'
import { parseDailyLimitHours } from '../model/timeEntryPolicy'
import { describeTimeTrackingFailure, type TimeTrackingTranslator } from './timeTrackingText'

/** Props of the Team time entry check panel. */
export type TimeEntryPolicyPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Saved checks and whether the member may change them, once loaded. */
  view?: TeamTimeEntryPolicyView
  /** Whether the checks are loading. */
  isLoading?: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Saves the checks. */
  onSave: (input: SaveTeamTimeEntryPolicyInput) => Promise<unknown>
  /** Reloads the checks. */
  onRetry: () => void
}

/** Modes offered for each check, in the order shown. */
const checkModes: readonly TimeEntryCheckMode[] = ['off', 'warn', 'reject']

/** Translated name of each mode. */
const checkModeKeys = {
  off: 'timeTracking.policy.mode.off',
  warn: 'timeTracking.policy.mode.warn',
  reject: 'timeTracking.policy.mode.reject',
} as const satisfies Record<TimeEntryCheckMode, MessageKey>

/**
 * Reads a check mode from a select value.
 *
 * @param value - Select value.
 * @returns The mode, or `off` for an unknown value.
 */
function readCheckMode(value: string): TimeEntryCheckMode {
  return value === 'warn' || value === 'reject' ? value : 'off'
}

/**
 * Formats a daily limit as hours for the input.
 *
 * @param minutes - Limit in minutes.
 * @returns Hours with at most two decimals.
 */
function formatDailyLimitHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100)
}

/**
 * Team checks applied when members record or edit time: overlapping ranges and a daily total.
 * Each check is off, warns after saving, or rejects the save. Managers of the whole Team change
 * them; other members see them read-only.
 *
 * @param props - Saved checks and actions.
 * @returns Check panel.
 */
export function TimeEntryPolicyPanel({ hasLoadError = false, isLoading = false, onRetry, onSave, t, view }: TimeEntryPolicyPanelProps) {
  const id = useId()
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const policy = view?.policy
  const readOnly = !view?.canEdit || isSaving

  /**
   * Validates and saves the edited checks.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!policy || isSaving) return
    const data = new FormData(event.currentTarget)
    /**
     * Reads one text field of the form.
     *
     * @param name - Field name.
     * @returns Value, or an empty string when absent.
     */
    const read = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    const dailyLimitMinutes = parseDailyLimitHours(read('dailyLimitHours'))
    if (dailyLimitMinutes === undefined) {
      setMessage({ tone: 'error', text: t('timeTracking.policy.invalidLimit') })
      return
    }
    setIsSaving(true)
    setMessage(undefined)
    try {
      await onSave({
        overlap: readCheckMode(read('overlap')),
        dailyLimit: readCheckMode(read('dailyLimit')),
        dailyLimitMinutes,
        expectedRevision: policy.revision,
      })
      setMessage({ tone: 'status', text: t('timeTracking.policy.saved') })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    } finally {
      setIsSaving(false)
    }
  }

  /**
   * Renders the mode select of one check.
   *
   * @param name - Form field name.
   * @param label - Translated field label.
   * @param value - Saved mode.
   * @returns Labelled select.
   */
  const renderMode = (name: 'overlap' | 'dailyLimit', label: string, value: TimeEntryCheckMode) => (
    <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <select className="workbench-input min-h-9 px-2" defaultValue={value} disabled={readOnly} name={name}>
        {checkModes.map((mode) => <option key={mode} value={mode}>{t(checkModeKeys[mode])}</option>)}
      </select>
    </label>
  )

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-4" data-testid="time-entry-policy-panel">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.policy.title')}</h2>
      <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.policy.hint')}</p>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.policy.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      {policy && !isLoading ? (
        <form className="grid min-w-0 gap-3" key={policy.revision} onSubmit={(event) => { void submit(event) }}>
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            {renderMode('overlap', t('timeTracking.policy.overlap'), policy.overlap)}
            {renderMode('dailyLimit', t('timeTracking.policy.dailyLimit'), policy.dailyLimit)}
            <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('timeTracking.policy.dailyLimitHours')}
              <input
                className="workbench-input min-h-9 w-28 px-2"
                defaultValue={formatDailyLimitHours(policy.dailyLimitMinutes)}
                disabled={readOnly}
                inputMode="decimal"
                name="dailyLimitHours"
                required
              />
            </label>
          </div>
          {view?.canEdit ? (
            <div>
              <button className="workbench-button-primary min-h-9 px-4" disabled={isSaving} type="submit">
                {t('timeTracking.policy.save')}
              </button>
            </div>
          ) : (
            <p className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.policy.readOnly')}</p>
          )}
        </form>
      ) : null}

      <div aria-live="polite" role="status">
        {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
      </div>
      {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}
    </section>
  )
}
