import type { SaveTimeRateCardRequest, TimeRateCard } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import { createTimeRateCardDraft, toSaveTimeRateCardRequest, type TimeRateCardDraft } from '../model/timeRateCard'
import { describeTimeTrackingFailure, type TimeTrackingTranslator } from './timeTrackingText'

/** Option of a job role offered in the rate card. */
export type TimeRateCardJobRoleOption = {
  /** Stable job role ID. */
  id: string
  /** Display name. */
  name: string
}

/** Option of a member offered in the rate card. */
export type TimeRateCardMemberOption = {
  /** Member key. */
  id: string
  /** Display name. */
  name: string
}

/** Props of the rate card panel. */
export type TimeRateCardPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Stored or empty card; absent while loading. */
  rateCard?: TimeRateCard
  /** Job roles of the Team's Work Item configuration. */
  jobRoles: readonly TimeRateCardJobRoleOption[]
  /** Members of the Team's Projects. */
  members: readonly TimeRateCardMemberOption[]
  /** Whether the card is loading. */
  isLoading?: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Saves the whole card; the fields stay locked until it settles, so no edit is lost. */
  onSave: (request: SaveTimeRateCardRequest) => Promise<unknown>
  /** Reloads the card. */
  onRetry: () => void
}

/**
 * Lists the rows the card shows: the offered options first, then rows the card holds for
 * options no longer offered, labelled by their IDs so they can still be cleared.
 *
 * @param options - Offered options.
 * @param storedIds - IDs the stored card holds.
 * @returns Rows in display order.
 */
function listRows<Option extends { id: string; name: string }>(options: readonly Option[], storedIds: readonly string[]) {
  const offered = new Set(options.map((option) => option.id))
  return [
    ...options.map((option) => ({ id: option.id, name: option.name })),
    ...storedIds.filter((id) => !offered.has(id)).map((id) => ({ id, name: id })),
  ]
}

/**
 * Confidential default hourly rates of a Team, by member and by job role, with an editor.
 *
 * A new time entry without a rate takes the member's own rate, else the rate of the member's job
 * role. Shown only to managers of the whole Team.
 *
 * @param props - Card, options, and actions.
 * @returns Rate card panel.
 */
export function TimeRateCardPanel({
  hasLoadError = false,
  isLoading = false,
  jobRoles,
  members,
  onRetry,
  onSave,
  rateCard,
  t,
}: TimeRateCardPanelProps) {
  const id = useId()
  const [draft, setDraft] = useState<{ revision: number; value: TimeRateCardDraft }>()
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  // A newer stored card replaces a draft made from an older one.
  const current = rateCard && draft?.revision === rateCard.revision
    ? draft.value
    : rateCard ? createTimeRateCardDraft(rateCard) : undefined
  const jobRoleRows = listRows(jobRoles, rateCard?.jobRoleRates.map((rate) => rate.jobRoleId) ?? [])
  const memberRows = listRows(members, rateCard?.memberRates.map((rate) => rate.userId) ?? [])
  const jobRoleNames = new Map(jobRoleRows.map((row) => [row.id, row.name]))

  /**
   * Replaces the draft with an edited copy.
   *
   * @param update - Changes the copy of the current draft.
   */
  const edit = (update: (value: TimeRateCardDraft) => TimeRateCardDraft) => {
    if (!rateCard || !current) return
    setMessage(undefined)
    setDraft({ revision: rateCard.revision, value: update(current) })
  }

  /**
   * Validates and saves the draft.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving || !rateCard || !current) return
    const result = toSaveTimeRateCardRequest(current, rateCard.revision)
    if (!result.ok) {
      setMessage({ tone: 'error', text: t(result.reason === 'currency' ? 'timeTracking.rateCard.invalidCurrency' : 'timeTracking.rateCard.invalidAmount') })
      return
    }
    setIsSaving(true)
    setMessage(undefined)
    try {
      await onSave(result.request)
      setDraft(undefined)
      setMessage({ tone: 'status', text: t('timeTracking.rateCard.saved') })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-4" data-testid="time-rate-card-panel">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.rateCard.title')}</h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.rateCard.hint')}</p>
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.rateCard.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      {current && !isLoading ? (
        <form className="grid min-w-0 gap-4" onSubmit={(event) => { void submit(event) }}>
          <label className="grid w-fit gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('timeTracking.rateCard.currency')}
            <input
              autoCapitalize="characters"
              className="workbench-input min-h-9 w-20 px-2 uppercase"
              disabled={isSaving}
              maxLength={3}
              onChange={(event) => edit((value) => ({ ...value, currency: event.target.value }))}
              value={current.currency}
            />
          </label>

          <fieldset className="grid min-w-0 gap-2">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('timeTracking.rateCard.jobRoles')}</legend>
            {jobRoleRows.length === 0 ? (
              <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.rateCard.noJobRoles')}</p>
            ) : (
              <ul className="grid min-w-0 gap-2">
                {jobRoleRows.map((row) => (
                  <li className="flex min-w-0 flex-wrap items-center gap-3" key={row.id}>
                    <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-[var(--workbench-text)]">
                      <span className="min-w-32 break-words font-medium">{row.name}</span>
                      <input
                        aria-label={`${row.name} ${t('timeTracking.rateCard.hourlyRate')}`}
                        className="workbench-input min-h-9 w-32 px-2"
                        disabled={isSaving}
                        inputMode="decimal"
                        onChange={(event) => edit((value) => ({ ...value, jobRoleRates: { ...value.jobRoleRates, [row.id]: event.target.value } }))}
                        placeholder={t('timeTracking.rateCard.hourlyRate')}
                        value={current.jobRoleRates[row.id] ?? ''}
                      />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset className="grid min-w-0 gap-2">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('timeTracking.rateCard.members')}</legend>
            {memberRows.length === 0 ? (
              <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.rateCard.noMembers')}</p>
            ) : (
              <ul className="grid min-w-0 gap-2">
                {memberRows.map((row) => {
                  const memberDraft = current.memberRates[row.id] ?? { rate: '', jobRoleId: '' }
                  return (
                    <li className="flex min-w-0 flex-wrap items-center gap-3" key={row.id}>
                      <span className="min-w-32 break-words text-sm font-medium text-[var(--workbench-text)]">{row.name}</span>
                      <select
                        aria-label={`${row.name} ${t('timeTracking.rateCard.jobRole')}`}
                        className="workbench-input min-h-9 px-2"
                        disabled={isSaving}
                        onChange={(event) => edit((value) => ({
                          ...value,
                          memberRates: { ...value.memberRates, [row.id]: { ...memberDraft, jobRoleId: event.target.value } },
                        }))}
                        value={memberDraft.jobRoleId}
                      >
                        <option value="">{t('timeTracking.rateCard.noJobRole')}</option>
                        {jobRoleRows.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                        {memberDraft.jobRoleId && !jobRoleNames.has(memberDraft.jobRoleId)
                          ? <option value={memberDraft.jobRoleId}>{memberDraft.jobRoleId}</option>
                          : null}
                      </select>
                      <input
                        aria-label={`${row.name} ${t('timeTracking.rateCard.ownRate')}`}
                        className="workbench-input min-h-9 w-32 px-2"
                        disabled={isSaving}
                        inputMode="decimal"
                        onChange={(event) => edit((value) => ({
                          ...value,
                          memberRates: { ...value.memberRates, [row.id]: { ...memberDraft, rate: event.target.value } },
                        }))}
                        placeholder={t('timeTracking.rateCard.ownRate')}
                        value={memberDraft.rate}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>

          <div aria-live="polite" role="status">
            {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
          </div>
          {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}
          <div>
            <button className="workbench-button-primary min-h-9 px-3" disabled={isSaving} type="submit">{t('timeTracking.rateCard.save')}</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
