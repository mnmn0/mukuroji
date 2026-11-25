import {
  AGENT_RUN_MAX_LEASE_MINUTES,
  AGENT_RUN_MIN_LEASE_MINUTES,
  AGENT_SETTINGS_BRIEF_MAX_BYTES,
  type WorkspaceAgentDefaults,
} from '@mukuroji/contracts'
import { useId } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import {
  validateWorkspaceAgentDefaultsDraft,
  type WorkspaceAgentDefaultsDraft,
} from '../model/agentSettingsForm'
import type { AgentSettingsSaveFeedback } from '../mutations/useSaveTeamAgentSettings'

/** Props of the Workspace agent defaults section. */
export type WorkspaceAgentDefaultsSectionProps = {
  /** Loaded defaults; undefined while loading or after a failed load. */
  defaults?: WorkspaceAgentDefaults
  /** Form values edited from the loaded defaults. */
  draft?: WorkspaceAgentDefaultsDraft
  /** Outcome of the latest save. */
  feedback?: AgentSettingsSaveFeedback
  /** Whether the latest load failed. */
  hasLoadError: boolean
  /** Whether the defaults changed on the server since the draft was started. */
  hasRevisionConflict: boolean
  /** Whether the draft differs from the loaded defaults. */
  isDirty: boolean
  /** Whether the defaults are loading for the first time. */
  isLoading: boolean
  /** Whether a save is in flight. */
  isSaving: boolean
  /** Locale used for numbers and dates. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Replaces the form values. */
  onDraftChange: (draft: WorkspaceAgentDefaultsDraft) => void
  /** Discards the draft and reloads the defaults. */
  onReload: () => void
  /** Loads the defaults again after a failure. */
  onRetry: () => void
  /** Saves the draft. */
  onSave: () => void
}

/**
 * Renders the Workspace agent defaults editor for Workspace administrators: the lease, take over,
 * and acceptance criteria values a Team uses until it saves its own, and the default brief.
 *
 * @param props - Defaults, draft, state, and handlers.
 * @returns The defaults section.
 */
export function WorkspaceAgentDefaultsSection({
  defaults,
  draft,
  feedback,
  hasLoadError,
  hasRevisionConflict,
  isDirty,
  isLoading,
  isSaving,
  locale,
  t,
  onDraftChange,
  onReload,
  onRetry,
  onSave,
}: WorkspaceAgentDefaultsSectionProps) {
  const idPrefix = useId()
  const numberFormat = new Intl.NumberFormat(locale)
  const validation = draft ? validateWorkspaceAgentDefaultsDraft(draft) : undefined
  const leaseHelpId = `${idPrefix}-lease-help`
  const briefId = `${idPrefix}-brief`
  const briefCounterId = `${briefId}-counter`
  const conflict = hasRevisionConflict || feedback?.kind === 'conflict'

  /**
   * Fills `{name}` placeholders of a message.
   *
   * @param key - Message key.
   * @param values - Placeholder values.
   * @returns The localized message.
   */
  const format = (key: MessageKey, values: Readonly<Record<string, string | number>>) =>
    Object.entries(values).reduce(
      (message, [name, value]) => message.replaceAll(`{${name}}`, typeof value === 'number' ? numberFormat.format(value) : value),
      t(key),
    )

  return (
    <section
      aria-labelledby={`${idPrefix}-title`}
      className="workbench-panel grid gap-0 overflow-hidden"
      data-testid="workspace-agent-defaults"
    >
      <div className="grid gap-2 px-5 py-5 sm:px-7">
        <h3 className="text-base font-semibold text-[var(--workbench-text)]" id={`${idPrefix}-title`}>
          {t('agentSettings.workspace.title')}
        </h3>
        <p className="max-w-[760px] text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('agentSettings.workspace.help')}
        </p>
      </div>
      {isLoading && !defaults ? (
        <p className="border-t border-[var(--workbench-border)] px-5 py-4 text-sm font-semibold text-[var(--workbench-muted)] sm:px-7" role="status">
          {t('agentSettings.workspace.loading')}
        </p>
      ) : !defaults || !draft || !validation ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--workbench-border)] px-5 py-4 sm:px-7">
          <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">{t('agentSettings.workspace.loadError')}</p>
          <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
            {t('agentSettings.retry')}
          </button>
        </div>
      ) : (
        <>
          {hasLoadError ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--workbench-border)] px-5 py-3 sm:px-7">
              <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">{t('agentSettings.workspace.loadError')}</p>
              <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
                {t('agentSettings.retry')}
              </button>
            </div>
          ) : null}
          <fieldset className="grid gap-4 border-t border-[var(--workbench-border)] px-5 py-6 sm:px-7" disabled={isSaving}>
            <legend className="sr-only">{t('agentSettings.workspace.title')}</legend>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-[var(--workbench-muted)]">
                {defaults.revision === 0
                  ? t('agentSettings.workspace.unsaved')
                  : defaults.updatedAt
                    ? format('agentSettings.updatedAt', {
                      time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
                        .format(new Date(defaults.updatedAt)),
                    })
                    : null}
              </p>
              <span className="workbench-badge">{format('agentSettings.revision', { revision: defaults.revision })}</span>
            </div>
            <label className="grid max-w-xs gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('agentSettings.lease.minutes')}
              <input
                aria-describedby={leaseHelpId}
                aria-invalid={!validation.leaseMinutesValid || undefined}
                className="workbench-input min-h-11 px-3"
                inputMode="numeric"
                max={AGENT_RUN_MAX_LEASE_MINUTES}
                min={AGENT_RUN_MIN_LEASE_MINUTES}
                step={1}
                type="number"
                value={draft.leaseMinutes}
                onChange={(event) => onDraftChange({ ...draft, leaseMinutes: event.target.value })}
              />
            </label>
            <p
              className={`text-xs leading-5 ${validation.leaseMinutesValid ? 'font-medium text-[var(--workbench-muted)]' : 'font-semibold text-[var(--workbench-danger)]'}`}
              id={leaseHelpId}
            >
              {format(validation.leaseMinutesValid ? 'agentSettings.lease.help' : 'agentSettings.lease.invalid', {
                min: AGENT_RUN_MIN_LEASE_MINUTES,
                max: AGENT_RUN_MAX_LEASE_MINUTES,
              })}
            </p>
            <label className="flex min-h-[44px] items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
              <input
                checked={draft.allowTakeoverAfterLeaseExpiry}
                className="h-5 w-5 accent-[var(--workbench-primary)]"
                type="checkbox"
                onChange={(event) => onDraftChange({ ...draft, allowTakeoverAfterLeaseExpiry: event.target.checked })}
              />
              {t('agentSettings.lease.takeover')}
            </label>
            <label className="flex min-h-[44px] items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
              <input
                checked={draft.requireAcceptanceCriteria}
                className="h-5 w-5 accent-[var(--workbench-primary)]"
                type="checkbox"
                onChange={(event) => onDraftChange({ ...draft, requireAcceptanceCriteria: event.target.checked })}
              />
              {t('agentSettings.criteria.require')}
            </label>
            <div className="grid gap-2">
              <label className="text-sm font-semibold text-[var(--workbench-text)]" htmlFor={briefId}>
                {t('agentSettings.workspace.brief')}
              </label>
              <textarea
                aria-describedby={briefCounterId}
                aria-invalid={validation.briefOverLimit || undefined}
                className="workbench-input min-h-28 resize-y px-3 py-2 font-mono text-sm font-normal text-[var(--workbench-text)]"
                id={briefId}
                value={draft.brief}
                onChange={(event) => onDraftChange({ ...draft, brief: event.target.value })}
              />
              <p
                className={`text-xs font-semibold ${validation.briefOverLimit ? 'text-[var(--workbench-danger)]' : 'text-[var(--workbench-muted)]'}`}
                id={briefCounterId}
              >
                {format('agentSettings.briefs.bytes', { used: validation.briefBytes, max: AGENT_SETTINGS_BRIEF_MAX_BYTES })}
                {validation.briefOverLimit ? ` ${format('agentSettings.briefs.overLimit', { max: AGENT_SETTINGS_BRIEF_MAX_BYTES })}` : null}
              </p>
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--workbench-border)] px-5 py-5 sm:px-7">
            <button
              className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="workspace-agent-defaults-save"
              disabled={!isDirty || isSaving || conflict || !validation.valid}
              onClick={onSave}
              type="button"
            >
              {isSaving ? t('agentSettings.saving') : t('agentSettings.workspace.save')}
            </button>
            <SaveMessage conflict={hasRevisionConflict} feedback={feedback} format={format} t={t} />
            {conflict ? (
              <button className="workbench-button-secondary min-h-[44px] px-4" disabled={isSaving} onClick={onReload} type="button">
                {t('agentSettings.reload')}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}

/** Props of the save outcome message. */
type SaveMessageProps = {
  /** Whether the defaults changed on the server since the draft was started. */
  conflict: boolean
  /** Outcome of the latest save. */
  feedback?: AgentSettingsSaveFeedback
  /** Fills placeholders of a message. */
  format: (key: MessageKey, values: Readonly<Record<string, string | number>>) => string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders the outcome of the latest save of the defaults.
 *
 * @param props - Outcome and message helpers.
 * @returns The message, or nothing when there is no outcome.
 */
function SaveMessage({ conflict, feedback, format, t }: SaveMessageProps) {
  const shown = conflict ? { kind: 'conflict' as const } : feedback
  if (!shown) return null
  const message = shown.kind === 'saved'
    ? t('agentSettings.workspace.saved')
    : shown.kind === 'conflict'
      ? t('agentSettings.conflict')
      : shown.kind === 'forbidden'
        ? t('agentSettings.workspace.forbidden')
        : shown.kind === 'invalid'
          ? format('agentSettings.invalid', { message: shown.message })
          : t('agentSettings.saveError')
  return (
    <p
      className={`text-sm font-semibold ${shown.kind === 'saved' ? 'text-[var(--workbench-success)]' : 'text-[var(--workbench-danger)]'}`}
      role={shown.kind === 'saved' ? 'status' : 'alert'}
    >
      {message}
    </p>
  )
}
